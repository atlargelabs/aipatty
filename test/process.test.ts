import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { readConfig } from "../src/config.ts";
import { checkout, fixture, fixtureEnv } from "./helpers.ts";

const exec = promisify(execFile);

/** Wait for readiness or early exit, and reap every child even when assertions fail. */
function launch(t: TestContext, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["src/main.ts"], { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  const ready = Promise.withResolvers<string>();
  child.stdout.on("data", chunk => {
    out += chunk;
    const address = /listening on (127\.0\.0\.1:\d+)\n/.exec(out);
    if (address) ready.resolve(`http://${address[1]}`);
  });
  child.stderr.on("data", chunk => { err += chunk; });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
  t.after(async () => { child.kill("SIGKILL"); await exit; });
  return { child, exit, stderr: () => err, url: () => Promise.race([ready.promise, exit.then(code => {
    throw new Error(`Server exited (${code}): ${err}`);
  })]) };
}

test("faux has its own default database directory and an explicit override still wins", () => {
  assert.equal(readConfig({}).dataDir, join(homedir(), ".aipatty/data"));
  assert.equal(readConfig({ AIPATTY_FAUX: "1" }).dataDir, join(homedir(), ".aipatty/faux"));
  assert.equal(readConfig({ AIPATTY_FAUX: "1", AIPATTY_DATA_DIR: "~/demo" }).dataDir, join(homedir(), "demo"));
});

test("CLI recovers a fresh install with no cached default, without a login or model call", { timeout: 10_000 }, async t => {
  const env = fixtureEnv(await fixture(t), { AIPATTY_FAUX: "0", AIPATTY_HOST: "127.0.0.1" });
  const server = launch(t, env);
  const base = await server.url();
  const cli = (...args: string[]) => exec(process.execPath, ["src/cli.ts", ...args], {
    cwd: checkout, env: { ...env, AIPATTY_URL: base },
  });
  const health = JSON.parse((await cli("health")).stdout);
  assert.equal(health.modelStatus, "unavailable");
  assert.equal(health.model.modelId, "gpt-6.2-sol");
  assert.equal((await cli("log")).stdout, "");
  await assert.rejects(cli("send", "not admitted"), /aipatty model set/);
  await assert.rejects(cli("model", "set", "not-in-catalog"), /Unknown modelId/);
  assert.equal(JSON.parse((await cli("health")).stdout).modelStatus, "unavailable");
  const { models } = JSON.parse((await cli("models")).stdout);
  const chosen = models.find((model: { modelId: string }) => model.modelId === "gpt-6.1-sol");
  assert.ok(chosen);
  const status = JSON.parse((await cli("model", "set", chosen.modelId)).stdout);
  assert.deepEqual(status, { modelStatus: "available", model: { provider: chosen.provider, modelId: chosen.modelId } });
  assert.equal((await cli("log")).stdout, "");
});

test("one owner per directory across ports; SIGKILL releases ownership and interrupted input resumes", { timeout: 20_000 }, async t => {
  const dir = await fixture(t);
  const env = { ...fixtureEnv(dir), AIPATTY_HOST: "127.0.0.1" };
  const owner = launch(t, env);
  const base = await owner.url();
  const other = launch(t, env); // Both ask the OS for a free TCP port.
  assert.equal(await other.exit, 1);
  assert.ok(other.stderr().includes(`owns data directory ${dir}`));

  const input = "resume ".repeat(100);
  const route = "/api/conversations/root";
  const response = await fetch(`${base}${route}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: input }) });
  assert.equal(response.status, 202);
  const busyBy = Date.now() + 3000;
  while (!(await (await fetch(base + route)).json() as { busy: boolean }).busy) {
    assert.ok(Date.now() < busyBy, "expected the turn to start before killing the process");
    await sleep(10);
  }
  owner.child.kill("SIGKILL");
  await owner.exit;

  const replacement = launch(t, env);
  const url = await replacement.url();
  const cli = (...args: string[]) => exec(process.execPath, ["src/cli.ts", ...args], { cwd: checkout, env: { ...env, AIPATTY_URL: url } });
  assert.equal(JSON.parse((await cli("models")).stdout).models[0].modelId, "faux-1");
  const deadline = Date.now() + 9000;
  while ((await cli("log")).stdout.split("\n").filter(line => line === `assistant: Faux reply: ${input}`).length !== 1) {
    assert.ok(Date.now() < deadline, "interrupted turn should finish exactly once");
    await sleep(100);
  }
  const result = JSON.parse((await cli("model", "set", "faux-1")).stdout);
  assert.equal(result.modelStatus, "available");
});
