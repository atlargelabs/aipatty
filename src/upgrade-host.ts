import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type Conversation } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.ts";
import { HttpError, type AgentHost } from "./host.ts";
import { OwnerBusy } from "./ownership.ts";
import { openUpgradeLog } from "./upgrade-process.ts";
import {
  errorText, exists, finish, idPattern, ownedFile, resultText, sameInstall, syncPath, upgradeEntryKind,
  UpgradePaths, type UpgradeJournal,
} from "./upgrade-state.ts";

const ResultDoc = defineDoc<{ last: string }>({
  kind: "aipatty.upgrade.delivery", version: 1, scope: "session",
  initial: () => ({ last: "" }), checkpointWhen: () => true,
});
const RequestDoc = defineDocFamily<{ id: string }, null>({
  kind: "aipatty.upgrade.request", version: 1, scope: "session", family: true,
  initial: () => ({ id: "" }), checkpointWhen: () => true,
});

/** A DB transaction covers both the visible transcript entry and its idempotency marker. */
async function report(agent: AgentHost, paths: UpgradePaths, j: UpgradeJournal): Promise<void> {
  if (j.phase !== "done" || j.branch === undefined || j.reported) return;
  const branch = await agent.conversation(String(j.branch));
  if (!branch) throw new Error(`Upgrade ${j.id}: requesting branch ${j.branch} is missing`);
  const observed = paths.load();
  if (observed?.id !== j.id || observed.phase !== "done") throw new Error("Upgrade journal changed during delivery");
  if (observed.reported) return;
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
  if (j.phase === "requested" || j.phase === "staging") {
    // No side effects on pointer or DB are allowed in either phase. A dead helper must not wedge the old release.
    const unlock = paths.lease();
    try {
      j = paths.load();
      if (!j) throw new Error("Upgrade journal disappeared during startup");
      if (j.phase === "requested" || j.phase === "staging") {
        assertSelected(paths, source, commit, j.old);
        j = finish(j, { kind: "cancelled", reason: "Interrupted staging was not retried." });
        paths.save(j);
      }
    } finally { unlock(); }
  }
  if (j.phase !== "done") throw new Error(`Unfinished upgrade (${j.phase}): use upgrade-supervisor.ts recover before serving ${paths.db}`);
  assertSelected(paths, source, commit, j.result?.active ?? j.old);
  return { paths, journal: j };
}

/** A lost supervisor is only permission to start when its commit point can be read and synced. */
export function committedValidation(startup: StartupState, source: string, commit: string): StartupState | undefined {
  const { paths, journal } = startup;
  const j = paths.load();
  if (j?.id !== journal.id || j.phase !== "done" || j.result?.active !== commit
    || (j.result.kind !== "upgraded" && j.result.kind !== "rolled-back")) return;
  assertSelected(paths, source, commit);
  syncPath(paths.journal);
  syncPath(paths.state);
  return { paths, journal: j };
}

export async function reportStartup(agent: AgentHost, startup: StartupState | undefined, listeningCommit: string): Promise<void> {
  if (!startup) return;
  const { paths, journal } = startup;
  try {
    let j = paths.load();
    if (j?.id !== journal.id || j.phase !== "done") throw new Error("Upgrade journal changed during startup");
    if (!j.result?.active && !j.reported && j.old === listeningCommit && paths.selected() === listeningCommit) {
      // An interrupted stage may have been cancelled before any server could be probed. This one is now bound.
      j = finish(j, { ...j.result!, active: listeningCommit });
      paths.save(j);
    }
    await report(agent, paths, j);
  } catch (error) { console.error(`Could not deliver upgrade ${journal.id}:`, error); }
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
    const settleHandoff = async (reason: string) => {
      // A short bounded wait is solely for a racing explicit recover; there is no poller or supervisor to keep alive.
      for (let attempt = 0; ; attempt++) {
        let unlock: (() => void) | undefined;
        try {
          unlock = paths.lease();
          let j = paths.load();
          if (j?.id !== id) break;
          if (j.phase === "requested" || j.phase === "staging"
            || (j.phase === "stopping" && !drainStarted && paths.selected() === commit)) {
            // This same host still owns Durable storage; a dead helper cannot have advanced past stopping.
            j = finish(j, { kind: "cancelled", active: commit, reason });
            paths.save(j);
          }
          if (j.phase !== "done") {
            console.error(`Upgrade ${id} stopped during ${j.phase}; no new work before documented recovery. ${reason}`);
            return;
          }
          try { await report(agent, paths, j); }
          catch (error) { console.error(`Could not deliver upgrade ${id}:`, error); }
          break;
        } catch (error) {
          if (error instanceof OwnerBusy && attempt < 40) { await sleep(100); continue; }
          console.error(`Could not settle upgrade ${id}:`, error);
          // A failing handoff must not wedge the old process. Uncertain cutover is the one exception.
          const j = paths.load();
          if (j?.id === id && !["requested", "staging", "done"].includes(j.phase)) return;
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
          if (previous.branch === target.id && previous.requestKey === requestKey) {
            unblock();
            return previous.id;
          }
        }
        if (exists(paths.piRun)) throw new HttpError(409, `Pi recovery is pending: ${paths.piRun}`);
        const j: UpgradeJournal = { version: 1, id, port: config.port, faux: config.faux, old: commit,
          branch: target.id, requestKey, legacy: false, phase: "requested" };
        // No model turn is started. The operator's command is complete when this entry is durably stored (default
        // immediate Durable commit). Only then can any helper take ownership, let alone ask the app to stop.
        const accepted = await target.commit(async tx => {
          const request = await tx.doc(RequestDoc, `${target.id}:${requestKey}`, null);
          if (request.id) return request.id;
          paths.save(j);
          request.id = id;
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