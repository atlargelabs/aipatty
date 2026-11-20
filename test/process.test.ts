import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { readConfig, readSettings } from "../src/config.ts";
import { checkout, fixture, fixtureEnv, until } from "./helpers.ts";

const exec = promisify(execFile);
function cliAt(url: string) {
  return (...args: string[]) => exec(process.execPath, ["src/cli.ts", ...args], { cwd: checkout, env: { AIPATTY_URL: url } });
}

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
  const cli = cliAt(await server.url());
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
  assert.deepEqual(status, {
    modelStatus: "available", model: { provider: chosen.provider, modelId: chosen.modelId }, thinking: "high",
  });
  assert.equal((await cli("log")).stdout, "");
});

test("a send requires a subscription login, even with an ambient or stored API key", { timeout: 10_000 }, async t => {
  const dir = await fixture(t);
  const env = fixtureEnv(dir, { AIPATTY_FAUX: "0", AIPATTY_HOST: "127.0.0.1", OPENAI_API_KEY: "ambient-fake" });
  // An available default model with no login. The unreachable address keeps a stray key off the network.
  await writeFile(join(dir, "models-store.json"), JSON.stringify({
    openai: {
      models: [{ ...openaiProvider().getModels()[0], id: "gpt-6.2-sol", baseUrl: "http://127.0.0.1:9" }],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 1_000,
    },
  }));
  const server = launch(t, env);
  const base = await server.url();
  const cli = cliAt(base);
  await assert.rejects(cli("send", "hi"), /Run failed: model_error: Provider is not configured: openai/);
  assert.match(server.stderr(), /Run failed \(submission \d+\): model_error: Provider is not configured: openai/);

  // A client retrying the same request gets the same failed submission, and the server logs it once.
  const retry = async () => (await (await fetch(`${base}/api/conversations/root/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi", requestId: "same" }),
  })).json() as { submissionId: number }).submissionId;
  const failed = `Run failed (submission ${await retry()})`;
  await until(() => server.stderr().includes(failed));
  assert.equal(`Run failed (submission ${await retry()})`, failed);
  await cli("health");
  assert.equal(server.stderr().split(failed).length - 1, 1);

  await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "!exit 3" } }));
  const cause = /model_error: .*API keys are not supported/;
  await assert.rejects(cli("send", "hi"), cause);
  assert.match(server.stderr(), cause);
});

test("CLI reports the HTTP status when the reply is not this server's JSON", async t => {
  const stub = createServer((req, res) => {
    const status = req.url === "/health" ? 502 : 200;
    res.writeHead(status, { "Content-Type": "text/html" }).end("<!DOCTYPE html><title>proxy</title>");
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => { stub.close(); stub.closeAllConnections(); });
  const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  const cli = cliAt(url);
  await assert.rejects(cli("health"), /aipatty: HTTP 502 Bad Gateway\n/);
  await assert.rejects(cli("models"), /aipatty: Expected JSON from http:\/\/127\.0\.0\.1:\d+\/api\/models\n/);
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
  await until(async () => (await (await fetch(base + route)).json() as { busy: boolean }).busy);
  owner.child.kill("SIGKILL");
  await owner.exit;

  const replacement = launch(t, env);
  const url = await replacement.url();
  const cli = cliAt(url);
  assert.equal(JSON.parse((await cli("models")).stdout).models[0].modelId, "faux-1");
  await until(async () => (await cli("log")).stdout.split("\n").filter(line => line === `assistant: Faux reply: ${input}`).length === 1);
  const result = JSON.parse((await cli("model", "set", "faux-1")).stdout);
  assert.equal(result.modelStatus, "available");
});

test("settings: an empty value is unset, an unknown name is an error, and the pi directory holds both pi files", () => {
  const blank = Object.fromEntries(["DATA_DIR", "HOST", "TRUSTED_HOSTS", "PORT", "PI_DIR", "FAUX", "URL"].map(name => [`AIPATTY_${name}`, ""]));
  assert.deepEqual(readConfig(blank), readConfig({}));
  assert.deepEqual(readSettings(blank), {});
  assert.deepEqual(readSettings({ AIPATTY_URL: "http://mini.test:8790", PATH: "/bin" }), { URL: "http://mini.test:8790" });
  assert.throws(() => readConfig({ AIPATTY_PROVIDER: "openai", AIPATTY_HOSTS: "x" }), /Unknown setting AIPATTY_PROVIDER, AIPATTY_HOSTS\. The settings are: AIPATTY_DATA_DIR, /);
  const { authFile, modelsStore } = readConfig({ AIPATTY_PI_DIR: "~/elsewhere" });
  assert.deepEqual([authFile, modelsStore], [join(homedir(), "elsewhere/auth.json"), join(homedir(), "elsewhere/models-store.json")]);
  assert.equal(readConfig({}).authFile, join(homedir(), ".pi/agent/auth.json"));
});

test("CLI names the address and the reason when the server cannot be reached, and rejects a misspelt setting", async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));
  await assert.rejects(cliAt(`http://127.0.0.1:${port}`)("health"), new RegExp(
    `aipatty: Cannot reach the server at http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)\\. Is it running, and is AIPATTY_URL its address\\?\n`,
  ));
  const misspelt = exec(process.execPath, ["src/cli.ts", "health"], { cwd: checkout, env: { AIPATTY_ULR: "http://127.0.0.1:9" } });
  await assert.rejects(misspelt, /aipatty: Unknown setting AIPATTY_ULR\./);
});

test("CLI changes the thinking level and aborts a running turn", { timeout: 15_000 }, async t => {
  const dir = await fixture(t);
  const env = { ...fixtureEnv(dir), AIPATTY_HOST: "127.0.0.1" };
  const first = launch(t, env);
  let base = await first.url();
  let cli = cliAt(base);
  assert.equal(JSON.parse((await cli("health")).stdout).thinking, "high");
  assert.equal(JSON.parse((await cli("thinking", "set", "low")).stdout).thinking, "low");
  await assert.rejects(cli("thinking", "set", "loud"), /Expected a thinking level: off, minimal, low, medium, high, xhigh, max/);

  const route = "/api/conversations/root";
  const busy = async () => (await (await fetch(base + route)).json() as { busy: boolean }).busy;
  const sending = cli("send", "x".repeat(900)).then(() => "answered", (error: Error) => error.message);
  await until(busy);
  await assert.rejects(cli("model", "set", "faux-1"), /run 'aipatty abort'/);
  assert.equal((await cli("abort")).stdout, "");
  assert.match(await sending, /aipatty: Run failed: aborted\n/);
  assert.equal(await busy(), false);
  assert.equal(JSON.parse((await cli("model", "set", "faux-1")).stdout).modelStatus, "available");

  // The level is saved with the conversation, not taken from the environment.
  first.child.kill("SIGTERM");
  await first.exit;
  base = await launch(t, env).url();
  cli = cliAt(base);
  assert.equal(JSON.parse((await cli("health")).stdout).thinking, "low");
});
