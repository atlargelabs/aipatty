import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type Conversation } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.ts";
import { HttpError, type AgentHost } from "./host.ts";
import { OwnerBusy } from "./ownership.ts";
import { openUpgradeLog, reapStage } from "./upgrade-process.ts";
import {
  errorText, exists, finish, idPattern, ownedFile, resultText, sameInstall, upgradeEntryKind,
  UpgradePaths, type UpgradeJournal,
} from "./upgrade-state.ts";

const ResultDoc = defineDoc<{ last: string }>({
  kind: "aipatty.upgrade.delivery", version: 1, scope: "session",
  initial: () => ({ last: "" }), checkpointWhen: () => true,
});
const RequestDoc = defineDocFamily<{ id: string; accepted: boolean }, null>({
  kind: "aipatty.upgrade.request", version: 1, scope: "session", family: true,
  initial: () => ({ id: "", accepted: false }), checkpointWhen: () => true,
});

/** A DB transaction covers both the visible transcript entry and its idempotency marker. */
async function report(agent: AgentHost, paths: UpgradePaths, j: UpgradeJournal): Promise<void> {
  if (j.phase !== "done" || j.branch === undefined || j.reported) return;
  const observed = paths.load();
  if (observed?.id !== j.id || observed.phase !== "done") throw new Error("Upgrade journal changed during delivery");
  if (observed.reported) return;
  const key = `${j.branch}:${j.requestKey}`;
  const accepted = await agent.harness.snapshot(RequestDoc, key, ctx);
  if (accepted?.id !== j.id || !accepted.accepted) {
    if (j.result?.kind !== "cancelled" || (accepted?.id && accepted.id !== j.id)) {
      throw new Error(`Upgrade ${j.id}: its durable request is missing`);
    }
    // The external record can precede SQLite commit. A crash in that window isn't an accepted command.
    // Retire the key durably so even a later retransmission cannot create a new upgrade from it.
    await agent.harness.commit(async tx => { (await tx.doc(RequestDoc, key, null)).id = j.id; }, ctx);
    paths.save({ ...j, reported: true, result: { ...j.result, reason: "Interrupted before the operator command committed; no command was accepted." } });
    return;
  }
  const branch = await agent.conversation(String(j.branch));
  if (!branch) throw new Error(`Upgrade ${j.id}: requesting branch ${j.branch} is missing`);
  await branch.commit(async tx => {
    const marker = await tx.doc(ResultDoc);
    if (marker.last === j.id) return;
    await tx.appendEntry(branch.id, {
      kind: upgradeEntryKind, data: { id: j.id, type: "result", text: resultText(j) },
    });
    marker.last = j.id;
  }, ctx);
  paths.save({ ...j, reported: true });
}

function assertSelected(paths: UpgradePaths, source: string, commit: string, expected = commit): void {
  if (commit !== expected || paths.release(commit) !== source || paths.selected() !== commit) {
    throw new Error(`Start the selected immutable deploy/${expected} release for this installation`);
  }
}

interface StartupState { paths: UpgradePaths; journal: UpgradeJournal }

/** Run under owner.sqlite and before opening Durable storage or Pi recovery. */
export async function guardStartup(config: Config, source: string, commit: string, childId?: string): Promise<StartupState | undefined> {
  const paths = UpgradePaths.forStartup(config);
  if (!paths) {
    if (childId !== undefined) throw new Error("Validation start requires the managed upgrade layout and journal");
    return;
  }
  let j = paths.load();
  if (!j) throw new Error("Upgrade journal disappeared during startup");
  sameInstall(j, config);
  if (childId !== undefined) {
    const expected = j.phase === "switching" ? j.target : j.phase === "restored" && !j.legacy ? j.old : undefined;
    if (!process.connected || !idPattern.test(childId) || j.id !== childId || !expected) throw new Error("Invalid or interrupted validation start");
    assertSelected(paths, source, commit, expected);
    if (exists(paths.piRun)) throw new Error("Pi recovery is present; refusing validation without touching that run");
    return { paths, journal: j };
  }
  if (j.phase === "requested" || j.phase === "staging") {
    // No side effects on pointer or DB are allowed in either phase. A dead helper must not wedge the old release.
    const unlock = paths.lease();
    try {
      j = paths.load();
      if (!j) throw new Error("Upgrade journal disappeared during startup");
      if (j.phase === "requested" || j.phase === "staging") {
        if (j.phase === "staging") await reapStage(j);
        const unstaged = j.phase === "staging" ? paths.stagingLease(j.id) : undefined;
        try {
          assertSelected(paths, source, commit, j.old);
          j = finish(j, { kind: "cancelled", reason: "Interrupted staging was not retried." });
          paths.save(j);
        } finally { unstaged?.(); }
      }
    } finally { unlock(); }
  }
  if (j.phase !== "done") throw new Error(`Unfinished upgrade (${j.phase}): use upgrade-supervisor.ts recover before serving ${paths.db}`);
  assertSelected(paths, source, commit, j.result?.active ?? j.old);
  paths.syncJournal();
  return { paths, journal: j };
}

/** A lost supervisor is only permission to start when its commit point can be read and synced. */
export function committedValidation(startup: StartupState, source: string, commit: string): StartupState | undefined {
  const { paths, journal } = startup;
  const j = paths.load();
  if (j?.id !== journal.id || j.phase !== "done" || j.result?.active !== commit
    || (j.result.kind !== "upgraded" && j.result.kind !== "rolled-back")) return;
  assertSelected(paths, source, commit);
  paths.syncJournal();
  return { paths, journal: j };
}

export async function reportStartup(agent: AgentHost, startup: StartupState | undefined, listeningCommit: string): Promise<void> {
  if (!startup) return;
  const { paths, journal } = startup;
  let j = paths.load();
  if (j?.id !== journal.id || j.phase !== "done") throw new Error("Upgrade journal changed during startup");
  if (!j.result?.active && !j.reported && j.old === listeningCommit && paths.selected() === listeningCommit) {
    // An interrupted stage may have been cancelled before any server could be probed. This one is now bound.
    j = finish(j, { ...j.result!, active: listeningCommit });
    paths.save(j);
  }
  // If the committed release cannot deliver, do not confirm activation or restore over its DB. The next
  // explicit start retries the same result, and the helper has already recorded which checkout to start.
  try { await report(agent, paths, j); }
  catch (error) { throw new Error(`Could not deliver upgrade ${j.id}: ${errorText(error)}`, { cause: error }); }
}

export function hostUpgrade(config: Config, agent: AgentHost, source: string, commit: string, stop: () => void) {
  return async (target: Conversation, requestKey: string): Promise<string> => {
    let paths: UpgradePaths;
    try {
      paths = UpgradePaths.forConfig(config);
      assertSelected(paths, source, commit);
      ownedFile(join(source, "src/upgrade-supervisor.ts"));
    } catch (error) { throw new HttpError(409, errorText(error)); }
    const unblock = await agent.reserveUpgrade(target);
    let handed = false;
    let drainStarted = false;
    const id = randomUUID();
    let recoveryWatch: FSWatcher | undefined;
    const watchRecovery = () => {
      if (recoveryWatch) return;
      const close = () => { recoveryWatch?.close(); recoveryWatch = undefined; };
      const check = () => {
        let j: UpgradeJournal | undefined;
        try { j = paths.load(); } catch { return; }
        if (j?.id !== id) { close(); return; }
        if (j.phase !== "done") return;
        close();
        void settleHandoff("Explicit recovery completed.", false).catch(error => console.error(`Upgrade ${id}:`, error));
      };
      try {
        // Only for this unresolved request. No polling, and the watcher never keeps the app alive.
        recoveryWatch = watch(paths.state, { persistent: false }, (_event, name) => { if (!name || name === "journal.json") check(); });
        recoveryWatch.on("error", error => { close(); console.error(`Cannot watch recovery of ${id}:`, error); });
        check(); // Cover a terminal rename just before subscribing.
      } catch (error) { console.error(`Cannot watch recovery of ${id}:`, error); }
    };
    const settleHandoff = async (reason: string, observeRecovery = true) => {
      // Reap the recorded group before settling; a bounded wait is only for a racing explicit recover or
      // the stage worker finishing its own cleanup. There is no recurring background upgrade job.
      const deadline = Date.now() + 30_000;
      for (;;) {
        let unlock: (() => void) | undefined;
        try {
          unlock = paths.lease();
          let j = paths.load();
          if (j?.id !== id) break;
          if (j.phase === "requested" || j.phase === "staging"
            || (j.phase === "stopping" && !drainStarted && paths.selected() === commit)) {
            // This same host still owns Durable storage; a dead helper cannot have advanced past stopping.
            if (j.phase === "staging") await reapStage(j);
            const unstaged = j.phase === "staging" ? paths.stagingLease(j.id) : undefined;
            try {
              j = finish(j, { kind: "cancelled", active: commit, reason });
              paths.save(j);
            } finally { unstaged?.(); }
          }
          if (j.phase !== "done") {
            console.error(`Upgrade ${id} stopped during ${j.phase}; no new work before documented recovery. ${reason}`);
            return;
          }
          try { await report(agent, paths, j); }
          catch (error) { console.error(`Could not deliver upgrade ${id}:`, error); }
          break;
        } catch (error) {
          if (error instanceof OwnerBusy && Date.now() < deadline) { await sleep(100); continue; }
          console.error(`Could not settle upgrade ${id}:`, error);
          const j = paths.load();
          if (j?.id === id && j.phase !== "done") {
            // Never reopen while the stage may still have writers or the DB/current can be uncertain.
            // A successful explicit pre-cutover recover can release this same host without a restart.
            if (observeRecovery && (j.phase === "requested" || j.phase === "staging")) watchRecovery();
            return;
          }
          break;
        } finally { unlock?.(); }
      }
      unblock();
    };
    try {
      const unlock = paths.lease();
      try {
        const previous = paths.load();
        if (previous) {
          sameInstall(previous, config);
          if (previous.phase !== "done") throw new HttpError(409, "Another upgrade is pending; see the upgrade journal");
          await report(agent, paths, previous);
        }
        if (exists(paths.piRun)) throw new HttpError(409, `Pi recovery is pending: ${paths.piRun}`);
        const j: UpgradeJournal = { version: 1, id, port: config.port, faux: config.faux, old: commit,
          branch: target.id, requestKey, legacy: false, phase: "requested" };
        // No model turn is started. The operator's command is complete when this entry is durably stored (default
        // immediate Durable commit). Only then can any helper take ownership, let alone ask the app to stop.
        const accepted = await target.commit(async tx => {
          const request = await tx.doc(RequestDoc, `${target.id}:${requestKey}`, null);
          if (request.id) {
            if (!request.accepted) throw new HttpError(409, "That upgrade command did not commit. Send a fresh /upgrade if still wanted.");
            return request.id;
          }
          paths.save(j);
          request.id = id;
          request.accepted = true;
          await tx.appendEntry(target.id, {
            kind: upgradeEntryKind, data: { id, type: "request", text: `Requested upgrade (${id}).` },
          });
          return id;
        }, ctx);
        if (accepted !== id) {
          unblock();
          return accepted;
        }
      } finally { unlock(); }
      const log = openUpgradeLog(paths, id);
      try {
        const child = spawn(process.execPath, [join(source, "src/upgrade-supervisor.ts"), "handoff",
          "--install-dir", paths.root, "--port", String(config.port), "--id", id], {
          cwd: source, detached: true, stdio: ["ignore", log, log, "ipc"],
        });
        child.on("message", message => {
          if (message !== "drain") return;
          try {
            const j = paths.load();
            if (j?.id === id && j.phase === "stopping") {
              drainStarted = true;
              stop();
            }
          } catch (error) { console.error(`Cannot drain for upgrade ${id}:`, error); }
        });
        const settle = (reason: string) => { void settleHandoff(reason).catch(error => console.error(`Upgrade ${id}:`, error)); };
        child.once("exit", (code, signal) => { settle(`The one-shot helper exited (${code ?? signal}); see ${paths.log(id)}.`); });
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("spawn", resolve);
        });
        child.unref();
        child.channel?.unref();
        handed = true;
        return id;
      } finally { closeSync(log); }
    } catch (error) {
      if (!handed) await settleHandoff(`Could not start the upgrade helper: ${errorText(error)}`);
      throw error instanceof HttpError ? error : new HttpError(409, errorText(error));
    }
  };
}