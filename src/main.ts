import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };
import { startApi } from "./api.ts";
import { LOOPBACK, readConfig } from "./config.ts";
import { openHost } from "./host.ts";

function runningCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const health = {
    ok: true as const,
    commit: runningCommit(),
    startedAt: new Date().toISOString(),
    version: packageJson.version,
  };
  const config = readConfig();
  const signal = Promise.withResolvers<void>();
  const stop = () => signal.resolve();
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
      const api = await startApi(agent, health, config.port);
      console.log(`aipatty listening on ${LOOPBACK}:${api.port}`);
      await Promise.race([signal.promise, closed]);
      await api.close();
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
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
