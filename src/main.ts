import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { startApi, type Health } from "./api.ts";
import { LOOPBACK, readConfig } from "./config.ts";
import { openHost } from "./host.ts";
import { pendingUpgrade, selfCheck, settleUpgrade, upgradeRequest } from "./upgrade.ts";

/** The checkout this server runs from. */
const release = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

function runningCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: release,
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
  };
  const config = readConfig();
  // Set when an upgrade supervisor started this server as its new release.
  const pending = pendingUpgrade(config, health.commit);
  const stopping = Promise.withResolvers<void>();
  const stop = () => stopping.resolve();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const agent = await openHost(config);
    const { harness } = agent;
    const closed = harness.closed.then(end => {
      if (end.kind === "failed") {
        console.error("Harness failed:", end.error);
        process.exitCode = 1;
      }
    });
    try {
      health.problems = await selfCheck(agent, config);
      for (const problem of health.problems) console.error("Health check:", problem);
      if (pending && health.problems.length) throw new Error(`Health check failed: ${health.problems.join("; ")}`);
      let port = config.port;
      const api = await startApi(agent, health, port, {
        tailscaleOrigin: config.tailscaleOrigin,
        onShutdown: stop, onUpgrade: upgradeRequest(agent, config, release, () => port),
      });
      port = api.port;
      try {
        await settleUpgrade(agent, config, pending, health.commit);
        console.log(`aipatty listening on ${LOOPBACK}:${api.port}`);
        await Promise.race([stopping.promise, closed]);
      } finally {
        await api.close();
      }
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
