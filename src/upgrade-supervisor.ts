#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, realpathSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { readConfig, type Config } from "./config.ts";
import { backupDb, restoreDb } from "./upgrade-db.ts";
import {
  assertStageIdle, confirmActivation, detachServer, getHealth, identify, launchServer, legacyConnection, openUpgradeLog, probeServer,
  quiescent, reapStage, sendParent, stageMarker, stopCandidate, type ServerChild,
} from "./upgrade-process.ts";
import { stageRelease, verifyRelease } from "./upgrade-release.ts";
import {
  errorText, exists, finish, idPattern, resultText, sameInstall, upgradeProtocol, UpgradePaths, type ProcessIdentity, type UpgradeJournal,
} from "./upgrade-state.ts";

const stageDeadlineMs = 26 * 60_000;

function noPi(paths: UpgradePaths): void {
  if (exists(paths.piRun)) throw new Error(`Pi run or recovery is present: ${paths.piRun}. Leave the record intact and let the old release recover it.`);
}

async function verifySelected(paths: UpgradePaths, sha: string): Promise<void> {
  if (paths.selected() !== sha) throw new Error(`Unexpected current symlink; expected ${sha}`);
  await verifyRelease(paths.release(sha), sha);
}

/** Child of the one-shot owner, not a public mode. Deadlines and command cleanup survive loss of that owner. */
async function runStage(paths: UpgradePaths, config: Config, id: string, scriptRelease: string): Promise<void> {
  const signal = new AbortController();
  const authorized = await new Promise<boolean>(resolve => {
    process.once("disconnect", () => {
      signal.abort(new Error("Staging supervisor disconnected"));
      resolve(false);
    });
    process.once("message", value => resolve(value === "prepare"));
  });
  if (!authorized) throw new Error("Stage worker was not authorized");
  const unlock = paths.stagingLease(id);
  let log: number | undefined;
  try {
    const j = paths.load();
    if (!process.connected || j?.id !== id || j.phase !== "staging" || j.stageProcess?.pid !== process.pid
      || process.env[stageMarker(id)] !== "1" || paths.selected() !== j.old) {
      throw new Error("Invalid or cancelled stage handoff");
    }
    sameInstall(j, config);
    log = openUpgradeLog(paths, id);
    await stageRelease({ paths, id, old: j.old, origin: config.pi.repoUrl, log, signal: signal.signal,
      bootstrap: j.legacy ? scriptRelease : undefined,
      pinned: target => { paths.save({ ...j, target }); },
      note: text => { writeSync(log!, `${new Date().toISOString()} ${text}\n`); },
      assertIdle: () => assertStageIdle(id),
    });
  } catch (error) {
    if (process.connected) await sendParent(errorText(error)).catch(() => {});
    throw error;
  } finally {
    if (log !== undefined) closeSync(log);
    unlock();
  }
}

async function prepare(paths: UpgradePaths, j: UpgradeJournal, source: string, log: number, record: (p: ProcessIdentity) => void): Promise<void> {
  if (!j.legacy && !process.connected) throw new Error("Requesting host exited before staging");
  const child = spawn(process.execPath, [join(source, "src/upgrade-supervisor.ts"), "stage",
    "--install-dir", paths.root, "--port", String(j.port), "--id", j.id], {
    cwd: source, detached: true, env: { ...process.env, [stageMarker(j.id)]: "1" }, stdio: ["ignore", log, log, "ipc"],
  });
  let failure: string | undefined;
  child.on("message", value => { if (typeof value === "string") failure = value; });
  const completed = new Promise<Error | undefined>(resolve => {
    child.once("error", resolve);
    // All stdio is redirected; exit suffices, even if an already-disconnected IPC stream never emits close.
    child.once("exit", (code, signal) => resolve(code === 0 ? undefined : new Error(failure ?? `Stage worker exited (${code ?? signal})`)));
  });
  const disconnect = () => { if (child.connected) child.disconnect(); };
  const parentLost = Promise.withResolvers<Error>();
  const onHostExit = () => {
    disconnect();
    parentLost.resolve(new Error("Requesting host exited during staging"));
  };
  if (!j.legacy) process.once("disconnect", onHostExit);
  const stageDeadline = new AbortController();
  try {
    const identity = child.pid && await identify(child.pid);
    if (!identity || !child.connected || (!j.legacy && !process.connected)) throw new Error("Stage handoff ended before the worker could be verified");
    // A surviving owner can reap this group even if we lose the worker or both owners after it starts a command.
    record(identity);
    await new Promise<void>((resolve, reject) => child.send("prepare", error => error ? reject(error) : resolve()));
    const expired = sleep(stageDeadlineMs, undefined, { signal: stageDeadline.signal, ref: false })
      .then(() => new Error(`Staging exceeded its total deadline (${stageDeadlineMs} ms)`));
    const error = await Promise.race([completed, parentLost.promise, expired]);
    if (error) throw error;
  } finally {
    stageDeadline.abort();
    process.off("disconnect", onHostExit);
    disconnect();
    const deadline = new AbortController();
    try { await Promise.race([completed, sleep(3_000, undefined, { signal: deadline.signal })]); }
    finally { deadline.abort(); }
    child.channel?.unref();
    child.unref();
  }
}

/** One owner, one target, no retry. The only replayable part is safe restoration of the recorded old release. */
async function run(paths: UpgradePaths, args: {
  mode: "bootstrap" | "handoff" | "recover"; id?: string; faux: boolean; port: number; scriptRelease: string;
}): Promise<UpgradeJournal> {
  const { mode, scriptRelease } = args;
  const release = paths.lease();
  let log: number | undefined;
  const bootstrapId = mode === "bootstrap" ? randomUUID() : undefined;
  let j: UpgradeJournal | undefined;
  const note = (text: string) => {
    if (log !== undefined) writeSync(log, `${new Date().toISOString()} ${text}\n`);
  };
  const save = (next: UpgradeJournal) => { paths.save(next); j = next; return next; };
  const openLog = () => { log ??= openUpgradeLog(paths, j!.id); };
  const requireJournal = () => {
    if (!j) throw new Error(`No upgrade journal at ${paths.journal}`);
    return j;
  };
  const verifyOld = async (current: UpgradeJournal, pid?: number): Promise<string | undefined> => {
    try {
      if (paths.selected() !== current.old) return;
      if (current.legacy) {
        const old = await legacyConnection(paths, current);
        old.close();
      } else {
        const health = await getHealth(current.port);
        if (health.ok !== true || health.commit !== current.old || health.upgradeProtocol !== upgradeProtocol
          || (pid !== undefined && health.pid !== pid)) return;
      }
      return current.old;
    } catch { return; }
  };
  const done = (before: UpgradeJournal, status: NonNullable<UpgradeJournal["result"]>) => {
    const next = save(finish(before, status));
    // Work is committed already; an error appending diagnostics must not trigger a rollback.
    note(resultText(next));
    return next;
  };

  async function rollback(current: UpgradeJournal, why: string): Promise<UpgradeJournal> {
    note(`Restoring ${current.old}: ${why}`);
    await verifyRelease(paths.release(current.old), current.old);
    if (current.phase === "restored" && current.legacy && await verifyOld(current)) {
      return done(current, { kind: "rolled-back", active: current.old, reason: current.reason ?? why });
    }
    const free = await quiescent(paths, current.port, current.phase === "stopping" ? current.oldProcess : undefined);
    try {
      const selected = paths.selected();
      if (selected !== current.old && (current.phase === "stopping" || current.phase === "restored" || selected !== current.target)) {
        throw new Error(`Refusing to restore over unexpected current release ${selected}`);
      }
      if (current.phase === "switching" || current.phase === "restoring") {
        current = save({ ...current, phase: "restoring", reason: current.reason ?? why });
        restoreDb(paths, current.id);
        paths.select(current.old);
      }
      if (current.phase !== "restored") current = save({ ...current, phase: "restored", reason: current.reason ?? why });
      // If legacy shutdown raced late Pi work before the backup, only the unchanged old release may recover it.
      if (!current.legacy) noPi(paths);
    } finally { free(); }
    const old = launchServer(paths, current, current.old, !current.legacy);
    try {
      await probeServer(old, current, current.old, !current.legacy);
      if (current.legacy) {
        const legacy = await legacyConnection(paths, current);
        legacy.close();
        if (legacy.identity.pid !== old.child.pid) throw new Error("Rollback listener isn't the old process we launched");
      }
      const verified = done(current, { kind: "rolled-back", active: current.old, reason: current.reason ?? why });
      detachServer(old);
      if (!current.legacy) await confirmActivation(old, current, current.old);
      return verified;
    } catch (error) {
      if (!current.legacy && paths.load()?.phase !== "done") await stopCandidate(old);
      throw error;
    } finally { detachServer(old); }
  }

  try {
    if (bootstrapId) {
      log = openUpgradeLog(paths, bootstrapId);
      note("Checking legacy bootstrap prerequisites");
    }
    j = paths.load();
    if (j) sameInstall(j, { port: args.port, faux: args.faux });
    const sourceSha = basename(scriptRelease);
    if (scriptRelease !== paths.release(sourceSha)) throw new Error("Run the helper from an immutable deploy/<sha> release of this root");
    await verifyRelease(scriptRelease, sourceSha);
    if (mode === "recover") {
      const current = requireJournal();
      if (current.phase === "done") {
        await verifySelected(paths, current.result?.active ?? current.old);
        paths.syncJournal();
        return current;
      }
      openLog();
      try {
        if (current.phase === "requested" || current.phase === "staging") {
          if (current.phase === "staging") await reapStage(current);
          const unstaged = current.phase === "staging" ? paths.stagingLease(current.id) : undefined;
          try {
            await verifySelected(paths, current.old);
            return done(current, { kind: "cancelled", active: await verifyOld(current), reason: "Interrupted staging was not retried." });
          } finally { unstaged?.(); }
        }
        return await rollback(current, current.reason ?? "Interrupted cutover; the pinned candidate was not retried.");
      } catch (error) {
        note(`RECOVERY FAILED (${requireJournal().phase}): ${errorText(error)}. Journal and backup retained.`);
        throw error;
      }
    }

    let parent: Awaited<ReturnType<typeof identify>>;
    if (mode === "bootstrap") {
      if (j && (j.phase !== "done" || (j.branch !== undefined && !j.reported))) {
        throw new Error(`An upgrade is unfinished or undelivered: ${paths.journal}`);
      }
      if (j && paths.selected() !== (j.result?.active ?? j.old)) throw new Error("Current differs from the upgrade journal");
      const old = paths.selected();
      await verifySelected(paths, old);
      noPi(paths);
      const initial: UpgradeJournal = { version: 1, id: bootstrapId!, port: args.port, faux: args.faux, old, legacy: true, phase: "staging" };
      const legacy = await legacyConnection(paths, initial);
      legacy.close();
      save(initial);
    } else {
      const requested = requireJournal();
      if (!process.connected || requested.id !== args.id || requested.phase !== "requested" || requested.legacy
        || requested.branch === undefined || requested.old !== sourceSha) throw new Error("Invalid or expired host handoff");
      if (process.ppid <= 1) throw new Error("Host handoff lost its parent");
      parent = await identify(process.ppid);
      if (!parent || !await verifyOld(requested, parent.pid)) throw new Error("Could not verify the requesting host");
      save({ ...requested, phase: "staging" });
    }
    openLog();
    let candidate: ServerChild | undefined;
    try {
      const initial = requireJournal();
      noPi(paths);
      await prepare(paths, initial, scriptRelease, log!, stageProcess => { save({ ...initial, stageProcess }); });
      const prepared = paths.load();
      if (prepared?.id !== initial.id || prepared.phase !== "staging" || !prepared.target) throw new Error("Stage worker did not pin a target");
      await reapStage(prepared);
      j = prepared;
      const sha = prepared.target;
      await verifySelected(paths, initial.old);
      noPi(paths);
      if (sha === initial.old) {
        const active = await verifyOld(initial, parent?.pid);
        if (!active) throw new Error("The selected release matches main but the old server could not be verified");
        return done(requireJournal(), { kind: "noop", active });
      }
      const legacy = initial.legacy ? await legacyConnection(paths, initial) : undefined;
      try {
        if (!legacy && (!process.connected || !await verifyOld(initial, parent?.pid))) throw new Error("The old host exited before cutover");
        noPi(paths);
        note(`Requesting graceful stop of ${initial.old}`);
        save({ ...requireJournal(), phase: "stopping", oldProcess: legacy?.identity ?? parent });
        if (legacy) {
          await legacy.shutdown();
          note(`Legacy shutdown acknowledged; waiting for PID ${legacy.identity.pid} to exit`);
        } else await sendParent("drain");
      } finally { legacy?.close(); }
      const free = await quiescent(paths, initial.port, legacy?.identity ?? parent);
      try {
        noPi(paths);
        await verifySelected(paths, initial.old);
        await backupDb(paths, initial.id);
        note(`Saved standalone SQLite backup at ${paths.backup(initial.id)}`);
        save({ ...requireJournal(), phase: "switching" });
        paths.select(sha);
      } finally { free(); }
      note(`Starting ${sha} in validation mode`);
      candidate = launchServer(paths, requireJournal(), sha, true);
      await probeServer(candidate, requireJournal(), sha, true);
      const verified = done(requireJournal(), { kind: "upgraded", active: sha });
      detachServer(candidate);
      await confirmActivation(candidate, verified, sha);
      return verified;
    } catch (error) {
      const why = errorText(error);
      const current = paths.load() ?? requireJournal();
      if (current.phase === "done") {
        note(why);
        throw error; // Never restore over a possibly committed release.
      }
      if (current.phase === "requested" || current.phase === "staging") {
        try { await reapStage(current); }
        catch (cleanup) {
          note(`STAGE CLEANUP FAILED: ${why}; ${errorText(cleanup)}. Journal retained.`);
          throw cleanup;
        }
        return done(current, { kind: "failed", active: await verifyOld(current, parent?.pid), reason: why });
      }
      try {
        if (candidate) await stopCandidate(candidate);
        return await rollback(current, why);
      } catch (failure) {
        note(`ROLLBACK FAILED (${requireJournal().phase}): ${why}; ${errorText(failure)}. Journal and backup retained.`);
        throw new Error(`Upgrade failed: ${why}. Rollback failed: ${errorText(failure)}. See ${paths.log(current.id)} and ${paths.journal}; use recover after investigating.`);
      }
    } finally {
      if (candidate) detachServer(candidate);
    }
  } catch (error) {
    if (bootstrapId && log !== undefined) {
      note(`Bootstrap failed: ${errorText(error)}`);
      throw new Error(`${errorText(error)}. See ${paths.log(bootstrapId)}`, { cause: error });
    }
    throw error;
  } finally {
    if (log !== undefined) closeSync(log);
    release();
  }
}

async function main(): Promise<void> {
  const { values, positionals: [mode, ...extra] } = parseArgs({ allowPositionals: true, options: {
    "install-dir": { type: "string" }, port: { type: "string" }, id: { type: "string" },
  } });
  const internal = mode === "handoff" || mode === "stage";
  if (extra.length || (!internal && mode !== "bootstrap" && mode !== "recover")
    || !values["install-dir"] || !values.port || (internal ? !values.id || !idPattern.test(values.id) || !process.connected : values.id !== undefined)) {
    throw new Error("Usage: node src/upgrade-supervisor.ts bootstrap|recover --install-dir <canonical-root> --port <port>");
  }
  const config = readConfig(["--install-dir", values["install-dir"], "--port", values.port]);
  const paths = UpgradePaths.forConfig(config);
  const scriptRelease = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  if (mode === "stage") return runStage(paths, config, values.id!, scriptRelease);
  const j = await run(paths, { mode, id: values.id, port: config.port, faux: config.faux, scriptRelease });
  const ok = mode === "recover" || j.result?.kind === "upgraded" || j.result?.kind === "noop";
  if (mode !== "handoff") {
    (ok ? console.log : console.error)(`${resultText(j)}\nLog: ${paths.log(j.id)}`);
    if (mode === "recover" && j.branch !== undefined && !j.reported) {
      console.log(`Result for branch ${j.branch} is still marked pending. If it does not appear, restart the selected app to retry delivery without deploying.`);
    }
  }
  if (!ok) process.exitCode = 1;
}

try { await main(); } catch (error) {
  console.error(`Upgrade: ${errorText(error)}`);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}