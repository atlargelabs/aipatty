/**
 * The server's side of `/upgrade`: start the supervisor, check its own health as it starts, and post the outcome in
 * the branch that asked. The supervisor script says how an upgrade goes.
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { accessSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readConfig, type Config } from "./config.ts";
import { HttpError, type AgentHost } from "./host.ts";
import { delegatesSource, piSettingsSource } from "./managed-pi/pins.ts";
import { managedPi, readManagedDelegateSettings } from "./managed-pi/policy.ts";
import { ownLock } from "./ownership.ts";
import { upgradeEntryKind } from "./protocol.ts";
import { readJson, upgradeFiles, type Pending, type Result } from "./upgrade-supervisor.ts";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The install root, when this server was started the way the supervisor restarts one: with `--install-dir` and no
 * other directory option.
 */
function managedRoot(config: Config): string | undefined {
  const root = config.installDir;
  if (!root) return undefined;
  const derived = readConfig(["--install-dir", root], { AIPATTY_FAUX: config.faux ? "1" : "" });
  const same = derived.dataDir === config.dataDir && derived.workDir === config.workDir
    && derived.runsDir === config.runsDir && derived.pi.agentDir === config.pi.agentDir;
  return same ? root : undefined;
}

function supervisorRunning(root: string): boolean {
  try {
    ownLock(upgradeFiles(root).lock, "busy")();
    return false;
  } catch {
    return true;
  }
}

/**
 * Before the database opens: the upgrade this server is the new release of, if a supervisor is waiting for it. Any
 * other pending upgrade was interrupted, so the old release and its database are put back and started instead of
 * this server.
 */
export function pendingUpgrade(config: Config, commit: string): Pending | undefined {
  const root = managedRoot(config);
  const pending = root && readJson<Pending>(upgradeFiles(root).pending);
  if (!root || !pending) return undefined;
  if (pending.new === commit && supervisorRunning(root)) return pending;
  console.error(`An upgrade to ${pending.new} was interrupted. Rolling back to ${pending.old}.`);
  const script = join(root, "deploy", pending.old, "src/upgrade-supervisor.ts");
  const { status } = spawnSync(process.execPath, [script, "recover", "--install-dir", root], { stdio: "inherit" });
  throw new Error(status === 0
    ? `Rolled back to ${pending.old}, which is now running in the background.`
    : `Could not roll back to ${pending.old}; see the output above and ${upgradeFiles(root).serverLog}.`);
}

/**
 * What this release needs in order to work, checked locally at every start: no model call and no network. An upgrade
 * is kept only if its release reports no problem.
 */
export async function selfCheck(agent: AgentHost, config: Config): Promise<string[]> {
  const problems: string[] = [];
  const check = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${message(error)}`);
    }
  };
  // Scheduling runs and the root's saved model is in the catalog.
  await check("Model", () => agent.assertAvailable());
  await check("Conversations", async () => {
    const { branches } = await agent.branches();
    for (const { id } of branches) {
      const branch = await agent.conversation(String(id));
      if (!branch) throw new Error(`Branch ${id} cannot be opened`);
      await branch.entries({}, 1, undefined, ctx);
    }
  });
  const { cli, extension, reviewExtension, settings } = config.pi;
  await check("Pi CLI", () => { accessSync(cli); accessSync(managedPi.bundleCli); piSettingsSource(); });
  await check("Delegates extension", () => { accessSync(extension); delegatesSource(); });
  await check("Review extension", () => accessSync(reviewExtension));
  await check("Managed Pi settings", () => readManagedDelegateSettings(settings));
  return problems;
}

async function post(conversation: Conversation, text: string): Promise<void> {
  await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: upgradeEntryKind, data: { text } }), ctx);
}

/** Post the outcome the supervisor left, if there is one. It is posted again if the server stops in between. */
async function deliverResult(agent: AgentHost, root: string): Promise<boolean> {
  const { result: file } = upgradeFiles(root);
  const result = readJson<Result>(file);
  if (!result) return false;
  const branch = await agent.conversation(String(result.branch)) ?? await agent.conversation("root");
  await post(branch!, result.text);
  rmSync(file, { force: true });
  return true;
}

/**
 * Once the server listens. The new release of a pending upgrade reports in the requesting branch and clears the
 * pending record, which commits the upgrade: an error here ends the server and the supervisor falls back. Any other
 * start posts the outcome of an upgrade that did not replace the old release.
 */
export async function settleUpgrade(agent: AgentHost, config: Config, pending: Pending | undefined, commit: string): Promise<void> {
  const root = managedRoot(config);
  if (!root) return;
  if (!pending) {
    await deliverResult(agent, root).catch(error => console.error("Upgrade result not posted:", error));
    return;
  }
  const branch = await agent.conversation(String(pending.branch));
  if (!branch) throw new Error(`Branch ${pending.branch}, which asked for the upgrade, is missing`);
  await post(branch, `Upgrade complete. Now running ${commit.slice(0, 7)}; was ${pending.old.slice(0, 7)}.`);
  rmSync(upgradeFiles(root).pending);
}

/** The handler of `/upgrade` sent to a branch. It returns once the supervisor has started. */
export function upgradeRequest(agent: AgentHost, config: Config, release: string, port: () => number) {
  return async (conversation: Conversation): Promise<void> => {
    const root = managedRoot(config);
    const files = root && upgradeFiles(root);
    if (!files || !existsSync(files.current) || realpathSync(files.current) !== release) {
      throw new HttpError(409, "Upgrade needs a managed install: start deploy/current with --install-dir and no other directory option");
    }
    const done = await agent.reserveUpgrade();
    try {
      mkdirSync(files.dir, { recursive: true });
      await post(conversation, "Upgrade requested. Fetching the latest main.");
      const log = openSync(files.log, "a");
      try {
        // Detached, with no pipe to this process: it has to outlive the server it stops.
        const child = spawn(process.execPath, [
          join(release, "src/upgrade-supervisor.ts"), "start",
          "--install-dir", root, "--port", String(port()), "--branch", String(conversation.id),
        ], { detached: true, stdio: ["ignore", log, log] });
        await once(child, "spawn");
        // The supervisor ends while this server still runs only when it did not get as far as stopping it.
        child.once("exit", code => {
          void (async () => {
            if (await deliverResult(agent, root)) return;
            await post(conversation, `Upgrade failed: the supervisor exited (${code}) without a result. See ${files.log}.`);
          })().catch(error => console.error("Upgrade:", error)).finally(done);
        });
        child.unref();
      } finally {
        closeSync(log);
      }
    } catch (error) {
      done();
      throw error;
    }
  };
}
