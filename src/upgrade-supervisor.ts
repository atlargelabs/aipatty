#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { readConfig, type Config } from "./config.ts";
import { backupDb, restoreDb } from "./upgrade-db.ts";
import {
  confirmActivation, detachServer, getHealth, identify, launchServer, legacyConnection, openUpgradeLog, probeServer,
  LegacyInspectionError, quiescent, sendParent, stopCandidate, type ServerChild,
} from "./upgrade-process.ts";
import { InterruptedStageError, publishRelease, stageRelease, verifyRelease, type StageOutput } from "./upgrade-release.ts";
import {
  errorText, exists, finish, idPattern, interruptedStage, resultText, sameInstall, shaPattern, syncPath, upgradeProtocol, UpgradePaths, type UpgradeJournal,
} from "./upgrade-state.ts";

const stageDeadlineMs = 26 * 60_000;

function noPi(paths: UpgradePaths): void {
  if (exists(paths.piRun)) throw new Error(`Pi run or recovery is present: ${paths.piRun}. Leave the record intact and let the old release recover it.`);
}

async function verifySelected(paths: UpgradePaths, sha: string): Promise<void> {
  if (paths.selected() !== sha) throw new Error(`Unexpected current symlink; expected ${sha}`);
  await verifyRelease(paths.release(sha), sha);
}

type StageResult = { output: StageOutput } | { failure: string };
const validDigest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function validOutput(value: unknown, j: UpgradeJournal, target?: string): value is StageOutput {
  if (!value || typeof value !== "object" || !("sha" in value) || !target || value.sha !== target) return false;
  if (target === j.old) return !("digest" in value) && !("bootstrapTree" in value);
  return "digest" in value && validDigest(value.digest)
    && (j.legacy ? "bootstrapTree" in value && validDigest(value.bootstrapTree) : !("bootstrapTree" in value));
}

/** Child of the one-shot owner, not a public mode. Writes only its private checkout and log. */
async function runStage(paths: UpgradePaths, config: Config, id: string, scriptRelease: string): Promise<void> {
  const signal = new AbortController();
  const authorized = await new Promise<boolean>(resolve => {
    process.once("disconnect", () => {
      signal.abort(new InterruptedStageError("Staging supervisor disconnected"));
      resolve(false);
    });
    process.once("message", value => resolve(value === "prepare"));
  });
  if (!authorized) throw new Error("Stage worker was not authorized");
  const unlock = paths.stagingLease(id);
  let log: number | undefined;
  let result: StageResult;
  try {
    const j = paths.load();
    if (!process.connected || j?.id !== id || j.phase !== "staging" || paths.selected() !== j.old) {
      throw new Error("Invalid or cancelled stage handoff");
    }
    sameInstall(j, config);
    log = openUpgradeLog(paths, id);
    try {
      result = { output: await stageRelease({ paths, id, old: j.old, origin: config.pi.repoUrl, log, signal: signal.signal,
        bootstrap: j.legacy ? scriptRelease : undefined,
        pinned: target => sendParent({ id, target }).catch(error => { throw new InterruptedStageError(errorText(error)); }),
        note: text => { writeSync(log!, `${new Date().toISOString()} ${text}\n`); },
      }) };
    } catch (error) {
      if (error instanceof InterruptedStageError) throw error;
      result = { failure: errorText(error) };
    }
  } finally {
    try { if (log !== undefined) closeSync(log); }
    finally { unlock(); }
  }
  signal.signal.throwIfAborted();
  await sendParent({ id, ...result });
}

async function prepare(paths: UpgradePaths, j: UpgradeJournal, source: string, log: number, pin: (target: string) => void): Promise<StageResult> {
  if (!j.legacy && !process.connected) throw new Error("Requesting host exited before staging");
  const child = spawn(process.execPath, [join(source, "src/upgrade-supervisor.ts"), "stage",
    "--install-dir", paths.root, "--port", String(j.port), "--id", j.id], {
    cwd: source, detached: true, stdio: ["ignore", log, log, "ipc"],
  });
  let target: string | undefined, result: StageResult | undefined, protocolError: unknown;
  child.on("message", value => {
    if (protocolError) return;
    try {
      if (!value || typeof value !== "object" || !("id" in value) || value.id !== j.id || result) {
        throw new Error("Invalid stage response");
      }
      if ("target" in value && typeof value.target === "string" && shaPattern.test(value.target) && !target) {
        pin(value.target);
        target = value.target;
      } else if ("failure" in value && typeof value.failure === "string") result = { failure: value.failure };
      else if ("output" in value && validOutput(value.output, j, target)) result = { output: value.output };
      else throw new Error("Invalid stage response");
    } catch (error) { protocolError = error; }
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.once("exit", (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`Stage worker exited (${code ?? signal})`)));
  });
  const ipcClosed = new Promise<void>(resolve => child.once("disconnect", resolve));
  const parentLost = Promise.withResolvers<void>();
  if (!j.legacy) process.once("disconnect", parentLost.resolve);
  const stageDeadline = new AbortController();
  try {
    await Promise.race([
      Promise.all([exited, ipcClosed, new Promise<void>((resolve, reject) => child.send("prepare", error => error ? reject(error) : resolve()))]),
      parentLost.promise.then(() => { throw new Error("Requesting host exited during staging"); }),
      sleep(stageDeadlineMs, undefined, { signal: stageDeadline.signal, ref: false })
        .then(() => { throw new Error(`Staging exceeded its total deadline (${stageDeadlineMs} ms)`); }),
    ]);
    if (protocolError) throw protocolError;
    if (!result || !child.pid) throw new Error("Stage worker exited without a completion response");
    // Only a veto on normal exit, not recovery authority or a claim about detached descendants. Never signal it.
    try { process.kill(-child.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return result; throw error; }
    throw new Error("Stage worker's group still has members");
  } finally {
    stageDeadline.abort();
    process.off("disconnect", parentLost.resolve);
    try { if (child.connected) child.disconnect(); }
    finally {
      child.channel?.unref();
      child.unref();
    }
  }
}

/** One owner, one target, no retry. The only replayable part is safe restoration of the recorded old release. */
async function run(paths: UpgradePaths, args: {
  mode: "bootstrap" | "handoff" | "recover"; id?: string; ack?: string; faux: boolean; port: number; scriptRelease: string;
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
    } catch (error) {
      if (error instanceof LegacyInspectionError) throw error;
      return;
    }
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
      if (args.ack !== undefined && (current.phase !== "staging" || current.id !== args.ack)) {
        throw new Error("Acknowledgement must name the pending staging request ID from this journal");
      }
      if (current.phase === "staging" && args.ack === undefined) throw new Error(interruptedStage(paths, current.id));
      if (current.phase === "done") {
        await verifySelected(paths, current.result?.active ?? current.old);
        paths.syncJournal();
        return current;
      }
      openLog();
      try {
        if (current.phase === "requested") {
          await verifySelected(paths, current.old);
          return done(current, { kind: "cancelled", active: await verifyOld(current), reason: "Interrupted request was not staged." });
        }
        if (current.phase === "staging") {
          // Matching acknowledgement is the operator's attestation after maintenance, not a process probe.
          // This lock excludes a live worker; it cannot prove that its commands or descendants have exited.
          const unlockStage = paths.stagingLease(current.id);
          try {
            await verifySelected(paths, current.old);
            return done(current, { kind: "cancelled", active: await verifyOld(current),
              reason: `Operator acknowledged interrupted staging. The private stage was not reused or removed: ${paths.stage(current.id)}.` });
          } finally { unlockStage(); }
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
    let interrupted = false;
    try {
      const initial = requireJournal();
      noPi(paths);
      const staged = paths.stage(initial.id);
      mkdirSync(staged, { mode: 0o700 }); // Exclusive: never reuse a half-prepared release.
      syncPath(paths.deploy);
      interrupted = true;
      const prepared = await prepare(paths, initial, scriptRelease, log!, target => { save({ ...initial, target }); });
      if ("failure" in prepared) {
        interrupted = false;
        rmSync(staged, { recursive: true, force: true });
        throw new Error(prepared.failure);
      }
      const sha = prepared.output.sha;
      if (sha !== initial.old) {
        await publishRelease(paths, initial.id, prepared.output, initial.legacy ? scriptRelease : undefined);
      }
      interrupted = false;
      rmSync(staged, { recursive: true, force: true });
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
      if (current.phase === "staging") {
        if (interrupted) {
          const message = `${interruptedStage(paths, current.id)} ${why}`;
          note(message);
          throw new Error(message, { cause: error });
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
    "install-dir": { type: "string" }, port: { type: "string" }, id: { type: "string" }, "ack-interrupted-stage": { type: "string" },
  } });
  const internal = mode === "handoff" || mode === "stage";
  const ack = values["ack-interrupted-stage"];
  if (extra.length || (!internal && mode !== "bootstrap" && mode !== "recover")
    || !values["install-dir"] || !values.port || (internal ? !values.id || !idPattern.test(values.id) || !process.connected : values.id !== undefined)
    || (ack !== undefined && (mode !== "recover" || !idPattern.test(ack)))) {
    throw new Error("Usage: node src/upgrade-supervisor.ts bootstrap|recover --install-dir <canonical-root> --port <port> [recover only: --ack-interrupted-stage <id>]");
  }
  const config = readConfig(["--install-dir", values["install-dir"], "--port", values.port]);
  const paths = UpgradePaths.forConfig(config);
  const scriptRelease = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  if (mode === "stage") return runStage(paths, config, values.id!, scriptRelease);
  const j = await run(paths, { mode, id: values.id, ack, port: config.port, faux: config.faux, scriptRelease });
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