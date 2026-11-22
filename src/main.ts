import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { startApi, type Health } from "./api.ts";
import { LOOPBACK, readConfig } from "./config.ts";
import { openHost } from "./host.ts";
import { committedValidation, guardStartup, hostUpgrade, reportStartup } from "./upgrade-host.ts";
import { errorText, upgradeChildEnv, upgradeProtocol } from "./upgrade-state.ts";

const source = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

function runningCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const health: Health = {
    ok: true,
    commit: runningCommit(),
    startedAt: new Date().toISOString(),
    version: packageJson.version,
    pid: process.pid,
    upgradeProtocol,
  };
  const config = readConfig();
  const childId = process.env[upgradeChildEnv];
  const disconnected = Promise.withResolvers<"parent">();
  if (childId !== undefined) {
    if (!process.connected) throw new Error("Upgrade validation requires a private supervisor connection");
    process.once("disconnect", () => disconnected.resolve("parent"));
  }
  const stopping = Promise.withResolvers<"stop">();
  const stop = () => stopping.resolve("stop");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let startup: ReturnType<typeof guardStartup>;
    const agent = await openHost(config, { paused: true, beforeOpen() {
      startup = guardStartup(config, source, health.commit, childId);
    } });
    const { harness } = agent;
    const closed = harness.closed.then(end => {
      if (end.kind === "failed") {
        console.error("Harness failed:", end.error);
        process.exitCode = 1;
      }
    });
    try {
      let serving = false;
      const activate = async () => {
        await reportStartup(agent, startup, health.commit);
        agent.activate();
        serving = true;
        delete health.validation;
      };
      if (childId !== undefined) {
        try {
          // No model call, no queued work, and no Pi recovery run during validation.
          await agent.assertAvailable();
          if (startup?.journal.branch !== undefined) {
            const branch = await agent.conversation(String(startup.journal.branch));
            if (!branch) throw new Error("The requesting conversation is missing");
            await agent.assertAvailable(branch);
          }
          health.validation = { id: childId, ready: true };
        } catch (error) {
          health.validation = { id: childId, ready: false, reason: errorText(error) };
        }
      }
      const api = await startApi(agent, health, config.port, {
        onShutdown: stop, onUpgrade: hostUpgrade(config, agent, source, health.commit, stop), serving: () => serving,
      });
      try {
        if (childId === undefined) await activate();
        console.log(`aipatty listening on ${LOOPBACK}:${api.port}${serving ? "" : " (validation only)"}`);
        if (childId !== undefined) {
          const event = await Promise.race([disconnected.promise, stopping.promise, closed]);
          if (event !== "parent") return;
          startup = startup && committedValidation(startup, source, health.commit);
          if (!startup || health.validation?.ready !== true) return;
          await activate();
          console.log(`aipatty committed ${health.commit}; serving ${LOOPBACK}:${api.port}`);
        }
        await Promise.race([stopping.promise, closed]);
      } finally { await api.close(); }
    } finally {
      await agent.close();
      await closed;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

try {
  await main();
} catch (error) {
  console.error("aipatty:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
