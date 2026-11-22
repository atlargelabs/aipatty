import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { readConfig, readFaux } from "../src/config.ts";
import { checkout, fixture, fixtureArgs, until } from "./helpers.ts";

const exec = promisify(execFile);
/** The CLI pointed at the server on `url`'s port. */
function cliAt(url: string) {
  return (...args: string[]) => exec(process.execPath, ["src/cli.ts", "--port", new URL(url).port, ...args], { cwd: checkout, env: {} });
}

/** Wait for readiness or early exit, and reap every child even when assertions fail. */
function launch(t: TestContext, dir: string, env: NodeJS.ProcessEnv = { AIPATTY_FAUX: "1" }, args = fixtureArgs(dir), cwd = checkout) {
  const child = spawn(process.execPath, [join(checkout, "src/main.ts"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(readConfig([], {}).dataDir, join(homedir(), ".aipatty/data"));
  assert.equal(readConfig([], { AIPATTY_FAUX: "1" }).dataDir, join(homedir(), ".aipatty/faux"));
  assert.equal(readConfig(["--data-dir", "~/demo"], { AIPATTY_FAUX: "1" }).dataDir, join(homedir(), "demo"));
});

test("install root owns actual state outside the release cwd, separates faux, and preserves transcripts on restart", { timeout: 20_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "aipatty-install-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "private root");
  const cwd = join(temp, "unrelated cwd");
  await mkdir(cwd);
  const args = ["--install-dir", root, "--port", "0"];

  const real = launch(t, root, {}, args, cwd);
  const realCli = cliAt(await real.url());
  assert.equal((await realCli("log")).stdout, "");
  for (const file of ["data/aipatty.sqlite", "data/owner.sqlite"]) assert.ok((await stat(join(root, file))).isFile(), file);
  real.child.kill("SIGTERM");
  assert.equal(await real.exit, 0);

  const faux = launch(t, root, { AIPATTY_FAUX: "1" }, args, cwd);
  const cli = cliAt(await faux.url());
  assert.equal((await cli("log")).stdout, "");
  assert.equal((await cli("send", "root state survives")).stdout.trim(), "Faux reply: root state survives");
  for (const file of ["faux/aipatty.sqlite", "faux/aipatty.sqlite-wal", "faux/owner.sqlite"]) {
    assert.ok((await stat(join(root, file))).isFile(), file);
  }
  for (const dir of ["work", "runs", "faux/logs/runs"]) assert.ok((await stat(join(root, dir))).isDirectory(), dir);
  // The root chooses the ownership lock, not cwd or listen port.
  const other = launch(t, root, { AIPATTY_FAUX: "1" }, args, temp);
  assert.equal(await other.exit, 1);
  assert.ok(other.stderr().includes(`owns data directory ${join(root, "faux")}`));
  const transcript = (await cli("log")).stdout;
  assert.match(transcript, /user: root state survives/);
  assert.match(transcript, /assistant: Faux reply: root state survives/);
  faux.child.kill("SIGTERM");
  assert.equal(await faux.exit, 0);

  const restarted = launch(t, root, { AIPATTY_FAUX: "1" }, args, temp);
  assert.equal((await cliAt(await restarted.url())("log")).stdout, transcript);
  restarted.child.kill("SIGTERM");
  assert.equal(await restarted.exit, 0);
  const realRestart = launch(t, root, {}, args, cwd);
  assert.equal((await cliAt(await realRestart.url())("log")).stdout, "");
  realRestart.child.kill("SIGTERM");
  assert.equal(await realRestart.exit, 0);
  assert.ok(!existsSync(join(cwd, "data")) && !existsSync(join(cwd, "faux")));
});

test("CLI recovers a saved model the catalog lacks, without a login or model call", { timeout: 15_000 }, async t => {
  // The fake model is saved with the root, and the real catalog does not have it.
  const dir = await fixture(t);
  const seed = launch(t, dir);
  await seed.url();
  seed.child.kill("SIGTERM");
  await seed.exit;
  const server = launch(t, dir, {});
  const cli = cliAt(await server.url());
  const health = JSON.parse((await cli("health")).stdout);
  assert.equal(health.modelStatus, "unavailable");
  assert.equal(health.model.modelId, "faux-1");
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
  // An available default model with no login. The unreachable address keeps a stray key off the network.
  await writeFile(join(dir, "models-store.json"), JSON.stringify({
    openai: {
      models: [{ ...openaiProvider().getModels()[0], id: "gpt-6.2-sol", baseUrl: "http://127.0.0.1:9" }],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 1_000,
    },
  }));
  const server = launch(t, dir, { OPENAI_API_KEY: "ambient-fake" });
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
  const owner = launch(t, dir);
  const base = await owner.url();
  const other = launch(t, dir); // Both ask the OS for a free TCP port.
  assert.equal(await other.exit, 1);
  assert.ok(other.stderr().includes(`owns data directory ${dir}`));

  const input = "resume ".repeat(100);
  const route = "/api/conversations/root";
  const response = await fetch(`${base}${route}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: input }) });
  assert.equal(response.status, 202);
  await until(async () => (await (await fetch(base + route)).json() as { busy: boolean }).busy);
  owner.child.kill("SIGKILL");
  await owner.exit;

  const replacement = launch(t, dir);
  const url = await replacement.url();
  const cli = cliAt(url);
  assert.equal(JSON.parse((await cli("models")).stdout).models[0].modelId, "faux-1");
  await until(async () => (await cli("log")).stdout.split("\n").filter(line => line === `assistant: Faux reply: ${input}`).length === 1);
  const result = JSON.parse((await cli("model", "set", "faux-1")).stdout);
  assert.equal(result.modelStatus, "available");
});

test("legacy server settings and AIPATTY_FAUX as the only environment setting", () => {
  const { pi, ...settings } = readConfig([], {});
  assert.deepEqual(settings, {
    dataDir: join(homedir(), ".aipatty/data"), port: 8790, faux: false,
    authFile: join(homedir(), ".pi/agent/auth.json"), modelsStore: join(homedir(), ".pi/agent/models-store.json"),
    workDir: join(homedir(), ".aipatty/work"), runsDir: join(homedir(), ".aipatty/runs"),
  });
  // A run launches this release's own pinned CLI and extension by absolute path, never one found on PATH.
  assert.deepEqual(pi, {
    node: process.execPath,
    cli: join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    extension: join(checkout, "node_modules/pi-delegates/src/index.ts"),
    agentDir: join(homedir(), ".pi/agent"),
    repo: "atlargelabs/aipatty", repoUrl: "git@github.com:atlargelabs/aipatty.git", git: "git", gh: "gh",
  });
  assert.ok(existsSync(pi.cli) && existsSync(pi.extension), "the pinned CLI and extension are installed");
  const dirs = readConfig(["--pi-dir", "~/elsewhere", "--work-dir", "~/w", "--runs-dir=/tmp/r"], {});
  assert.deepEqual([dirs.pi.agentDir, dirs.workDir, dirs.runsDir], [join(homedir(), "elsewhere"), join(homedir(), "w"), "/tmp/r"]);
  const { authFile, modelsStore, port } = readConfig(["--pi-dir", "~/elsewhere", "--port=0"], {});
  assert.deepEqual([authFile, modelsStore, port], [join(homedir(), "elsewhere/auth.json"), join(homedir(), "elsewhere/models-store.json"), 0]);
  for (const bad of ["65536", "-1", "8790.5", "http", ""]) {
    assert.throws(() => readConfig([`--port=${bad}`], {}), /--port must be an integer between 0 and 65535/);
  }
  assert.throws(() => readConfig(["--data-dir="], {}), /--data-dir needs a path/);
  assert.throws(() => readConfig(["--host", "0.0.0.0"], {}), /Unknown option '--host'[^]*Usage: node src\/main\.ts \[--port <n>\]/);
  assert.throws(() => readConfig(["extra"], {}), /Usage: node src\/main\.ts/);

  // An empty value is unset, only "1" turns faux mode on, and every other AIPATTY_ name is an error: the old
  // settings must not be silently ignored.
  assert.equal(readFaux({ AIPATTY_FAUX: "", PATH: "/bin" }), false);
  assert.equal(readFaux({ AIPATTY_FAUX: "0" }), false);
  assert.equal(readFaux({ AIPATTY_FAUX: "1" }), true);
  assert.throws(() => readConfig([], { AIPATTY_HOST: "0.0.0.0", AIPATTY_PORT: "1" }),
    /Unknown setting AIPATTY_HOST, AIPATTY_PORT\. The only environment setting is AIPATTY_FAUX/);
});

test("the server refuses an old environment setting and an unknown option", async t => {
  const dir = await fixture(t);
  const stale = launch(t, dir, { AIPATTY_FAUX: "1", AIPATTY_HOST: "0.0.0.0" });
  assert.equal(await stale.exit, 1);
  assert.match(stale.stderr(), /aipatty: Unknown setting AIPATTY_HOST\./);
  const unknown = launch(t, dir, { AIPATTY_FAUX: "1" }, ["--trusted-hosts", "mini.test"]);
  assert.equal(await unknown.exit, 1);
  assert.match(unknown.stderr(), /aipatty: Unknown option '--trusted-hosts'/);
});

test("CLI names the address and the reason when the server cannot be reached, and rejects a bad port or a leftover setting", async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise(resolve => listener.close(resolve));
  await assert.rejects(cliAt(`http://127.0.0.1:${port}`)("health"), new RegExp(
    `aipatty: Cannot reach the server at http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)\\. Is it running, and is --port its port\\?\n`,
  ));
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => exec(process.execPath, ["src/cli.ts", ...args], { cwd: checkout, env });
  await assert.rejects(cli(["health", "--port", "0"]), /aipatty: --port must be an integer between 1 and 65535\n/);
  await assert.rejects(cli(["health", "--port"]), /aipatty: --port needs a value\n/);
  await assert.rejects(cli(["health"], { AIPATTY_URL: "http://127.0.0.1:9" }), /aipatty: Unknown setting AIPATTY_URL\./);
});

test("CLI changes the thinking level and aborts a running turn", { timeout: 15_000 }, async t => {
  const dir = await fixture(t);
  const first = launch(t, dir);
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

  // The level is saved with the conversation, not taken from the settings.
  first.child.kill("SIGTERM");
  await first.exit;
  base = await launch(t, dir).url();
  cli = cliAt(base);
  assert.equal(JSON.parse((await cli("health")).stdout).thinking, "low");
});
