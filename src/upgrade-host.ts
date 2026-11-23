import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type Conversation } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, watch, writeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.ts";
import { HttpError, type AgentHost } from "./host.ts";
import { OwnerBusy } from "./ownership.ts";
import { openUpgradeLog } from "./upgrade-process.ts";
import {
  errorText, exists, finish, idPattern, interruptedCutover, interruptedStage, journalMatches, ownedFile, resultText,
  sameInstall, sameUpgradeRequest, upgradeEntryKind, upgradeHandoffEnv, UpgradePaths, type UpgradeJournal,
} from "./upgrade-state.ts";

const ResultDoc = defineDoc<{ last: string; journal?: string }>({
  kind: "aipatty.upgrade.delivery", version: 1, scope: "session",
  initial: () => ({ last: "" }), checkpointWhen: () => true,
});
const RequestDoc = defineDocFamily<{ id: string; accepted: boolean }, null>({
  kind: "aipatty.upgrade.request", version: 1, scope: "session", family: true,
  initial: () => ({ id: "", accepted: false }), checkpointWhen: () => true,
});
const requestDocKey = (j: UpgradeJournal) => `${j.branch}:${j.requestKey}`;

/** A candidate must still be able to deliver the result before the coordinator commits it. */
export async function assertAcceptedRequest(agent: AgentHost, j: UpgradeJournal): Promise<void> {
  if (j.branch === undefined) return;
  const accepted = await agent.harness.snapshot(RequestDoc, requestDocKey(j), ctx);
  if (accepted?.id !== j.id || !accepted.accepted) throw new Error(`Upgrade ${j.id}: its durable request is missing`);
}

/** A DB transaction covers both the visible transcript entry and its idempotency marker. */
async function report(agent: AgentHost, paths: UpgradePaths, j: UpgradeJournal): Promise<UpgradeJournal> {
  const check = () => paths.check(j, j.result?.active ?? j.old);
  check();
  if (j.phase !== "done" || j.branch === undefined || j.reported) return j;
  const ack = (result = j.result): UpgradeJournal => {
    // The transaction may already have committed. On drift, retain the on-disk record and let the
    // idempotency marker suppress duplicates when the original result can be retried.
    check();
    const next = { ...j, result, reported: true as const };
    paths.save(next);
    return next;
  };
  const key = requestDocKey(j);
  const accepted = await agent.harness.snapshot(RequestDoc, key, ctx);
  if (accepted?.id !== j.id || !accepted.accepted) {
    if (j.result?.kind !== "cancelled" || (accepted?.id && accepted.id !== j.id)) {
      throw new Error(`Upgrade ${j.id}: its durable request is missing`);
    }
    // The external record can precede SQLite commit. A crash in that window isn't an accepted command.
    // Retire the key durably so even a later retransmission cannot create a new upgrade from it.
    await agent.harness.commit(async tx => {
      const request = await tx.doc(RequestDoc, key, null);
      check();
      if (request.accepted || (request.id && request.id !== j.id)) throw new Error(`Upgrade ${j.id}: its durable request changed`);
      request.id = j.id;
    }, ctx);
    return ack({ ...j.result, reason: "Interrupted before the operator command committed; no command was accepted." });
  }
  const branch = await agent.conversation(String(j.branch));
  if (!branch) throw new Error(`Upgrade ${j.id}: requesting branch ${j.branch} is missing`);
  await branch.commit(async tx => {
    const marker = await tx.doc(ResultDoc);
    check();
    if (marker.last === j.id) {
      if (!marker.journal || !journalMatches(JSON.parse(marker.journal), j)) {
        throw new Error(`Upgrade ${j.id}: already delivered a different terminal journal`);
      }
      return;
    }
    await tx.appendEntry(branch.id, {
      kind: upgradeEntryKind, data: { id: j.id, type: "result", text: resultText(j) },
    });
    check();
    marker.last = j.id;
    marker.journal = JSON.stringify(j);
  }, ctx);
  return ack();
}

function assertSelected(paths: UpgradePaths, source: string, commit: string, expected = commit): void {
  if (commit !== expected || paths.release(commit) !== source || paths.selected() !== commit) {
    throw new Error(`Start the selected immutable deploy/${expected} release for this installation`);
  }
}

interface StartupState { paths: UpgradePaths; journal: UpgradeJournal }

/** Run under owner.sqlite and before opening Durable storage or Pi recovery. */
export function guardStartup(config: Config, source: string, commit: string, childId?: string): StartupState | undefined {
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
  if (j.phase === "requested") {
    // This phase precedes worker authorization. No staged commands or cutover need to be recovered.
    const unlock = paths.lease();
    try {
      assertSelected(paths, source, commit, j.old);
      paths.check(j, commit);
      j = finish(j, { kind: "cancelled", reason: "Interrupted request was not staged." });
      paths.save(j);
    } finally { unlock(); }
  }
  if (j.phase === "staging") throw new Error(interruptedStage(paths, j.id));
  if (j.phase !== "done") throw new Error(`Unfinished upgrade (${j.phase}): use upgrade-supervisor.ts recover before serving ${paths.db}`);
  assertSelected(paths, source, commit, j.result?.active ?? j.old);
  paths.syncJournal();
  return { paths, journal: j };
}

/** A lost supervisor is only permission to start when its commit point can be read and synced. */
export function committedValidation(startup: StartupState, source: string, commit: string): StartupState | undefined {
  const { paths, journal } = startup;
  // These are the only terminal transitions from the exact journal this process validated. Root and
  // data ownership are bound by startup, and the whole record includes the port and request identity.
  const expected = journal.phase === "switching" && journal.target === commit
    ? finish(journal, { kind: "upgraded", active: commit })
    : journal.phase === "restored" && !journal.legacy && journal.old === commit
      ? finish(journal, { kind: "rolled-back", active: commit, reason: journal.reason ?? interruptedCutover })
      : undefined;
  if (!expected || !journalMatches(paths.load(), expected)) return;
  assertSelected(paths, source, commit);
  paths.syncJournal();
  return { paths, journal: expected };
}

export async function reportStartup(agent: AgentHost, startup: StartupState | undefined, listeningCommit: string): Promise<StartupState | undefined> {
  if (!startup) return;
  const { paths, journal: j } = startup;
  paths.check(j, listeningCommit);
  if (j.phase !== "done") throw new Error("Startup requires a terminal upgrade journal");
  // If the committed release cannot deliver, do not confirm activation or restore over its DB. The next
  // explicit start retries the same result, and the helper has already recorded which checkout to start.
  try { return { paths, journal: await report(agent, paths, j) }; }
  catch (error) { throw new Error(`Could not deliver upgrade ${j.id}: ${errorText(error)}`, { cause: error }); }
}

/** Last synchronous check before resuming work or making the listener available for commands. */
export function checkStartup(config: Config, startup: StartupState | undefined, commit: string, validating = false): void {
  if (startup) {
    startup.paths.check(startup.journal, commit);
    if (validating && exists(startup.paths.piRun)) throw new Error("Pi recovery is present; refusing validation without touching that run");
  } else if (UpgradePaths.forStartup(config)) throw new Error("Upgrade journal appeared during startup; start again to verify it");
}

export function hostUpgrade(config: Config, agent: AgentHost, source: string, commit: string, stop: () => void) {
  return async (target: Conversation, requestKey: string): Promise<string> => {
    let paths: UpgradePaths;
    const id = randomUUID();
    const request: UpgradeJournal = { version: 1, id, port: config.port, faux: config.faux, old: commit,
      branch: target.id, requestKey, legacy: false, phase: "requested" };
    const key = requestDocKey(request);
    try {
      paths = UpgradePaths.forConfig(config);
      assertSelected(paths, source, commit);
      ownedFile(join(source, "src/upgrade-supervisor.ts"));
      // An accepted retry only reads its ID; it cannot take the supervisor lease or admit new work.
      const prior = await agent.harness.snapshot(RequestDoc, key, ctx);
      if (prior?.accepted && prior.id) {
        assertSelected(paths, source, commit);
        if (!paths.load()) paths.assertNoOrphanedUpgrade();
        return prior.id;
      }
    } catch (error) { throw new HttpError(409, errorText(error)); }
    const unblock = await agent.reserveUpgrade(target);
    let handed = false;
    let committed = false;
    let journalAttempted = false;
    let drainStarted = false;
    let terminal: UpgradeJournal | undefined;
    let recoveryWatch: FSWatcher | undefined;
    const cannotWatch = (error: unknown) => console.error(`Cannot watch recovery of ${id}; after recover returns, restart the selected app to reopen admission:`, error);
    const watchRecovery = () => {
      if (recoveryWatch) return;
      const close = () => { recoveryWatch?.close(); recoveryWatch = undefined; };
      const check = () => {
        let j: UpgradeJournal | undefined;
        try { j = paths.load(); }
        catch (error) {
          console.error(`Cannot read recovery of ${id}; admission will stay closed until a terminal journal is verified. If already recovered, restart the selected app:`, error);
          return;
        }
        if (!j || !sameUpgradeRequest(j, request)) { close(); return; }
        if (j.phase !== "done" || (terminal && !journalMatches(j, terminal))) return;
        close();
        void settleHandoff("Explicit recovery completed.", false).catch(error => console.error(`Upgrade ${id}:`, error));
      };
      try {
        // Only for this unresolved request. No polling, and the watcher never keeps the app alive.
        recoveryWatch = watch(paths.state, { persistent: false }, (_event, name) => { if (!name || name === "journal.json") check(); });
        recoveryWatch.on("error", error => { close(); cannotWatch(error); });
        check(); // Cover a terminal rename just before subscribing.
      } catch (error) { cannotWatch(error); }
    };
    const settleHandoff = async (reason: string, observeRecovery = true) => {
      // A bounded wait is only for the journal lease. Interrupted staging cannot self-settle.
      const deadline = Date.now() + 30_000;
      for (;;) {
        let unlock: (() => void) | undefined;
        try {
          unlock = paths.lease();
          let j = paths.load();
          if (!j || !sameUpgradeRequest(j, request)) throw new Error(`Missing or changed upgrade journal for ${id}`);
          if (terminal) paths.check(terminal, commit);
          if (j.phase === "requested" || (j.phase === "stopping" && !drainStarted)) {
            // This same host still owns Durable storage; a dead helper cannot have advanced past stopping.
            paths.check(j.phase === "requested" ? request : j, commit);
            j = finish(j, { kind: "cancelled", active: commit, reason });
            paths.save(j);
          }
          if (j.phase === "staging") throw new Error(interruptedStage(paths, id));
          if (j.phase !== "done") throw new Error(`Upgrade ${id} stopped during ${j.phase}; no new work before documented recovery. ${reason}`);
          assertSelected(paths, source, commit, j.result?.active ?? j.old);
          paths.check(j, commit);
          terminal = j;
          paths.syncJournal();
          try { terminal = j = await report(agent, paths, j); }
          catch (error) {
            const message = `Could not deliver upgrade ${id}: ${errorText(error)}. The journal still has the result; restart the selected app to retry delivery, not deployment.`;
            console.error(message);
            try {
              const log = openUpgradeLog(paths, id);
              try { writeSync(log, `${new Date().toISOString()} ${message}\n`); }
              finally { closeSync(log); }
            } catch (logError) { console.error(`Could not log delivery failure for ${id}:`, logError); }
          }
          // A transcript failure with an unchanged terminal record is retryable. Drift isn't authority
          // to reopen admission, even when it was detected during delivery.
          paths.check(j, commit);
          break;
        } catch (error) {
          if (error instanceof OwnerBusy && Date.now() < deadline) { await sleep(100); continue; }
          console.error(`Could not settle upgrade ${id}:`, error);
          // Reopen only after checking a terminal journal under the lease. A later explicit recovery can
          // release this same host without a restart; fs.watch is just a hint to retry those checks.
          if (observeRecovery) watchRecovery();
          return;
        } finally { unlock?.(); }
      }
      unblock();
    };
    try {
      const unlock = paths.lease();
      try {
        let previous = paths.load();
        paths.check(previous, commit);
        if (previous) {
          sameInstall(previous, config);
          if (previous.phase !== "done") throw new HttpError(409, "Another upgrade is pending; see the upgrade journal");
          assertSelected(paths, source, commit, previous.result?.active ?? previous.old);
          previous = await report(agent, paths, previous);
        }
        // No model turn is started. The operator's command is complete when this entry is durably stored (default
        // immediate Durable commit). Only then can any helper take ownership, let alone ask the app to stop.
        const accepted = await target.commit(async tx => {
          const marker = await tx.doc(RequestDoc, key, null);
          paths.check(previous, commit);
          if (marker.id) {
            if (!marker.accepted) throw new HttpError(409, "That upgrade command did not commit. Send a fresh /upgrade if still wanted.");
            return marker.id;
          }
          if (exists(paths.piRun)) throw new HttpError(409, `Pi recovery is pending: ${paths.piRun}`);
          journalAttempted = true;
          try { paths.save(request); }
          catch (error) {
            // Under the lease, seeing the previous record and selection proves no forward transition.
            // If either is uncertain, keep admission closed.
            try { paths.check(previous, commit); journalAttempted = false; } catch { /* fail closed */ }
            throw error;
          }
          marker.id = id;
          marker.accepted = true;
          await tx.appendEntry(target.id, {
            kind: upgradeEntryKind, data: { id, type: "request", text: `Requested upgrade (${id}).` },
          });
          paths.check(request, commit);
          return id;
        }, ctx);
        committed = true;
        if (accepted !== id) {
          unblock();
          return accepted;
        }
        paths.check(request, commit);
      } finally { unlock(); }
      const log = openUpgradeLog(paths, id);
      try {
        paths.check(request, commit);
        const child = spawn(process.execPath, [join(source, "src/upgrade-supervisor.ts"), "handoff",
          "--install-dir", paths.root, "--port", String(config.port), "--id", id], {
          cwd: source, env: { ...process.env, [upgradeHandoffEnv]: JSON.stringify(request) },
          detached: true, stdio: ["ignore", log, log, "ipc"],
        });
        child.on("message", message => {
          if (!message || typeof message !== "object" || !("drain" in message)) return;
          try {
            const j = message.drain as UpgradeJournal | undefined;
            if (j?.phase !== "stopping" || !sameUpgradeRequest(j, request) || j.oldProcess?.pid !== process.pid) {
              throw new Error("Invalid upgrade drain request");
            }
            paths.check(j, commit);
            drainStarted = true;
            stop();
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
      if (!journalAttempted) unblock();
      else if (!handed) {
        await settleHandoff(`Could not start the upgrade helper: ${errorText(error)}`)
          .catch(settleError => console.error(`Upgrade ${id}:`, settleError));
      }
      // The operator already has a durable request. Report any launch failure against it, not as a rejection.
      if (committed) return id;
      throw error instanceof HttpError ? error : new HttpError(409, errorText(error));
    }
  };
}