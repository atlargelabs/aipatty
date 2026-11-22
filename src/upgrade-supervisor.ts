#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { closeSync, realpathSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readConfig } from "./config.ts";
import { backupDb, restoreDb } from "./upgrade-db.ts";
import {
  confirmActivation, getHealth, identify, launchServer, leaveRunning, legacyConnection, openUpgradeLog, probeServer,
  quiescent, sendParent, stopCandidate, type ServerChild,
} from "./upgrade-process.ts";
import { stageRelease, verifyRelease } from "./upgrade-release.ts";
import {
  errorText, exists, finish, idPattern, resultText, sameInstall, upgradeProtocol, UpgradePaths, type UpgradeJournal,
} from "./upgrade-state.ts";

function noPi(paths: UpgradePaths): void {
  if (exists(paths.piRun)) throw new Error(`Pi run or recovery is present: ${paths.piRun}. Leave the record intact and let the old release recover it.`);
}

async function verifySelected(paths: UpgradePaths, sha: string): Promise<void> {
  if (paths.selected() !== sha) throw new Error(`Unexpected current symlink; expected ${sha}`);
  await verifyRelease(paths.release(sha), sha);
}

/** One owner, one target, no retry. The only replayable part is safe restoration of the recorded old release. */
async function run(paths: UpgradePaths, args: {
  mode: "bootstrap" | "handoff" | "recover"; id?: string; faux: boolean; port: number; origin: string; scriptRelease: string;
}): Promise<UpgradeJournal> {
  const { mode, scriptRelease, origin } = args;
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
      leaveRunning(old);
      if (!current.legacy) await confirmActivation(old, current, current.old);
      return verified;
    } catch (error) {
      if (!current.legacy && paths.load()?.phase !== "done") await stopCandidate(old);
      else leaveRunning(old); // A committed or legacy server can already have admitted work.
      throw error;
    }
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
        return current;
      }
      openLog();
      try {
        if (current.phase === "requested" || current.phase === "staging") {
          await verifySelected(paths, current.old);
          return done(current, { kind: "cancelled", active: await verifyOld(current), reason: "Interrupted staging was not retried." });
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
      const sha = await stageRelease({ paths, id: initial.id, old: initial.old, origin, log: log!, note,
        bootstrap: mode === "bootstrap" ? scriptRelease : undefined,
        pinned: target => { save({ ...requireJournal(), target }); },
      });
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
      leaveRunning(candidate);
      await confirmActivation(candidate, verified, sha);
      return verified;
    } catch (error) {
      const why = errorText(error);
      const current = paths.load() ?? requireJournal();
      if (current.phase === "done") {
        if (candidate) leaveRunning(candidate);
        note(why);
        throw error; // Never restore over a possibly committed release.
      }
      if (current.phase === "requested" || current.phase === "staging") {
        return done(current, { kind: "failed", active: await verifyOld(current, parent?.pid), reason: why });
      }
      try {
        if (candidate) await stopCandidate(candidate);
        return await rollback(current, why);
      } catch (failure) {
        note(`ROLLBACK FAILED (${requireJournal().phase}): ${why}; ${errorText(failure)}. Journal and backup retained.`);
        throw new Error(`Upgrade failed: ${why}. Rollback failed: ${errorText(failure)}. See ${paths.log(current.id)} and ${paths.journal}; use recover after investigating.`);
      }
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
  if (extra.length || (mode !== "bootstrap" && mode !== "handoff" && mode !== "recover")
    || !values["install-dir"] || !values.port || (mode === "handoff" ? !values.id || !idPattern.test(values.id) || !process.connected : values.id !== undefined)) {
    throw new Error("Usage: node src/upgrade-supervisor.ts bootstrap|recover --install-dir <canonical-root> --port <port>");
  }
  const config = readConfig(["--install-dir", values["install-dir"], "--port", values.port]);
  const paths = UpgradePaths.forConfig(config);
  const scriptRelease = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const j = await run(paths, { mode, id: values.id, port: config.port, faux: config.faux, origin: config.pi.repoUrl, scriptRelease });
  const ok = mode === "recover" || j.result?.kind === "upgraded" || j.result?.kind === "noop";
  if (mode !== "handoff") (ok ? console.log : console.error)(`${resultText(j)}\nLog: ${paths.log(j.id)}`);
  if (!ok) process.exitCode = 1;
}

try { await main(); } catch (error) {
  console.error(`Upgrade: ${errorText(error)}`);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}