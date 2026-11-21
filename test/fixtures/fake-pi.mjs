// A stand-in for the Pi CLI in one-shot JSON mode. It plays the steps of `fake-scenario.json` in the agent directory
// and records how it was launched in `fake-launches.jsonl` there.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const scenario = JSON.parse(readFileSync(join(agentDir, "fake-scenario.json"), "utf8"));
const sessionId = scenario.sessionId ?? "fake-session";
if (scenario.ignoreTerm) process.on("SIGTERM", () => {});

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(join(agentDir, "fake-launches.jsonl"), JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), prompt, pid: process.pid,
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PI_|PATTY_|AIPATTY_)/.test(name))),
}) + "\n");

const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
if (!scenario.noHeader) emit({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() });

for (const step of scenario.steps ?? []) {
  if (step.emit) emit(step.emit);
  if (step.raw !== undefined) process.stdout.write(step.raw);
  if (step.stderr !== undefined) process.stderr.write(step.stderr);
  if (step.spawn) {
    // As the delegates extension starts its children: detached, leading their own process group.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { detached: true, stdio: "ignore" });
    child.unref();
    appendFileSync(join(agentDir, "fake-pids.txt"), `${child.pid}\n`);
  }
  if (step.job) {
    const dir = join(agentDir, "delegates", "jobs", step.job.id);
    mkdirSync(join(dir, "workspace", "src"), { recursive: true });
    writeFileSync(join(dir, "workspace", "src", "file.ts"), "clone");
    writeFileSync(join(dir, "child-1.log"), "delegate log");
    writeFileSync(join(dir, "lease.json"), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(dir, "job.json"), JSON.stringify({
      id: step.job.id, ownerSession: step.job.session ?? sessionId, parentId: step.job.parentId, finishedAt: step.job.finishedAt,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: step.job.cost ?? 0, turns: 1 },
      workspace: { kind: "clone", path: join(dir, "workspace"), source: step.job.source ?? process.cwd() },
    }));
  }
  if (step.sleep) await sleep(step.sleep);
  if (step.hang) await new Promise(() => setInterval(() => {}, 1000));
  if (step.exit !== undefined) process.exit(step.exit);
}
