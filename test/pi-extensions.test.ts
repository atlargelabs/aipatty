import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readConfig } from "../src/config.ts";
import { checkout } from "./helpers.ts";

async function setup(t: TestContext) {
  // In production the stage is not under the release's node_modules: test real absolute/virtual resolution.
  const dir = await mkdtemp(join(tmpdir(), "aipatty-extension-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent"), cwd = join(dir, "checkout"), home = join(dir, "home"), temp = join(dir, "temp");
  await Promise.all([agentDir, cwd, home, temp].map(path => mkdir(path)));
  const pi = readConfig(["--pi-dir", agentDir], {}).pi;
  const env: NodeJS.ProcessEnv = {
    HOME: home, TMPDIR: temp, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: pi.agentDir, PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1", PUPPETEER_EXECUTABLE_PATH: join(dir, "missing-browser"),
  };
  const run = async (extensions: string[], model: string[], extraEnv = {}) => {
    const child = spawn(pi.node, [pi.cli, "--offline", "--mode", "json", "--no-session", "--thinking", "off",
      "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
      ...extensions.flatMap(path => ["-e", path]), ...model,
    ], { cwd, env: { ...env, ...extraEnv }, signal: AbortSignal.timeout(20_000), killSignal: "SIGKILL" });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.stdin.on("error", () => {});
    child.stdin.end("auth-free fixture prompt\n");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, stdout, stderr };
  };
  return { dir, agentDir, cwd, pi, env, run };
}

function events(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as {
    type: string; message?: { role: string; provider: string; model: string; stopReason: string; content: unknown };
    toolName?: string; result?: { content: unknown; details?: unknown; structuredContent?: unknown };
  });
}

test("bundled Pi loads the pinned web tools, ignores executable discovery, and keeps coding with missing fetch prerequisites", { timeout: 30_000 }, async t => {
  const { dir, agentDir, cwd, pi, run, env } = await setup(t);
  const marker = join(dir, "unexpected-code-ran"), tools = join(dir, "tools.json");
  const hook = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'hook ran'); export default () => {};`;
  const defaultHooks = join(agentDir, "just-web-fetch/extensions"), checkoutHooks = join(cwd, "checkout-hooks");
  for (const path of [defaultHooks, checkoutHooks, join(agentDir, "extensions"), join(cwd, ".pi/extensions")]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "must-not-load.ts"), hook);
  }
  await writeFile(join(cwd, ".puppeteerrc.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'Puppeteer config ran');`);
  await writeFile(join(cwd, "AGENTS.md"), "unexpected checkout context");
  const extractor = join(dir, "trafilatura"), extractorCalls = join(dir, "extractor-calls");
  await writeFile(extractor, `#!/bin/sh
pwd -P >> ${JSON.stringify(extractorCalls)}
read -r html
[ "$html" = '<p>fixture HTML</p>' ] && [ "$*" = '--markdown --formatting' ] || exit 8
[ -z "$FIXTURE_SECRET" ] && [ "$PATTY_RUN_ID" = 'fixture-run' ] || exit 9
printf '# Fixture Markdown\\n'
`, { mode: 0o700 });
  const browser = join(dir, "chrome"), browserArgs = join(dir, "browser-args");
  await writeFile(browser, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(browserArgs)}\nexit 7\n`, { mode: 0o700 });

  const requests: Array<{ url?: string; authorization?: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    req.setEncoding("utf8");
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.output_item.done", item: { id: "fixture-search", type: "web_search_call", status: "completed",
        action: { type: "search", query: "fixture search query", sources: [{ url: "https://example.invalid/", title: "Fixture source" }] } } },
      { type: "response.output_text.delta", delta: "Fixture search result" },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "fixture-search": {
    api: "openai-responses", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: "fixture-key", models: [{ id: "search-model", name: "Local search fixture" }],
  } } }));
  await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ provider: "fixture-search", model: "search-model" }));
  await writeFile(join(cwd, "web-search.json"), JSON.stringify({ provider: "must-not-load", model: "bad" }));

  for (const mode of ["missing extractor", "missing egress", "invalid egress", "missing Chrome", "stub Chrome"]) {
    if (mode !== "missing extractor") await writeFile(join(agentDir, "just-web-fetch.json"), JSON.stringify({ extensionsDir: checkoutHooks }));
    const result = await run([pi.extension, pi.webFetchExtension, pi.webSearchExtension, join(checkout, "test/fixtures/pi-extension-smoke.ts")],
      ["--model", "fixture/coding"], { FIXTURE_MARKER: marker, FIXTURE_TOOLS: tools,
        ...(mode !== "missing extractor" ? { PI_WEB_FETCH_TRAFILATURA: extractor } : {}),
        ...(mode !== "missing egress" ? { PI_WEB_FETCH_EGRESS_PROXY: mode === "invalid egress" ? "direct://" : "http://127.0.0.1:9" } : {}),
        ...(mode === "stub Chrome" ? { PUPPETEER_EXECUTABLE_PATH: browser, FIXTURE_CHECK_EXTRACTOR: "1",
          FIXTURE_SECRET: "do-not-forward", PATTY_RUN_ID: "fixture-run" } : {}) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const { all, active, prompt, extraction } = JSON.parse(await readFile(tools, "utf8")) as {
      all: string[]; active: string[]; prompt: string; extraction?: unknown;
    };
    if (mode === "stub Chrome") assert.deepEqual(extraction, { ok: true, markdown: "# Fixture Markdown" });
    for (const name of ["delegate", "web_fetch", "web_search", "url_context"]) assert.equal(all.filter(n => n === name).length, 1, name);
    assert.ok(active.includes("web_fetch") && active.includes("web_search"), active.join(", "));
    assert.ok(!active.includes("url_context"));
    assert.doesNotMatch(prompt, /unexpected checkout context/);
    const trace = events(result.stdout);
    const outcomes = trace.filter(event => event.type === "tool_execution_end");
    const fetch = JSON.stringify(outcomes.find(event => event.toolName === "web_fetch"));
    if (mode === "missing extractor") {
      assert.match(fetch, /Set PI_WEB_FETCH_TRAFILATURA/);
    } else if (mode === "missing egress" || mode === "invalid egress") {
      assert.match(fetch, /Set PI_WEB_FETCH_EGRESS_PROXY/);
    } else {
      assert.match(fetch, /Blocked navigation to https:\/\/127\.0\.0\.1/);
      if (mode === "missing Chrome") assert.match(fetch, /PUPPETEER_EXECUTABLE_PATH is not executable/);
      else assert.match(fetch, /Browser error:/);
    }
    const search = JSON.stringify(outcomes.find(event => event.toolName === "web_search"));
    assert.match(search, /Fixture search result/);
    assert.match(search, /Fixture source/);
    assert.ok(trace.some(event => event.type === "message_end" && event.message?.role === "assistant"
      && event.message.stopReason === "stop" && JSON.stringify(event.message.content).includes("unrelated coding turn completed")));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(agentDir, "just-web-fetch/aipatty/ephemeral")), []);
  }
  const args = (await readFile(browserArgs, "utf8")).trim().split("\n");
  assert.ok(args.some(arg => arg.startsWith(`--user-data-dir=${env.TMPDIR}`)), args.join(" "));
  assert.ok(!args.includes("--no-sandbox"));
  for (const flag of ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--disable-quic", "--remote-debugging-pipe"]) {
    assert.ok(args.includes(flag), flag);
  }
  // Only the explicit local extraction fixture ran; failed browser/preflight calls never start it.
  assert.equal(await readFile(extractorCalls, "utf8"), `${await realpath(agentDir)}\n`);
  assert.equal(requests.length, 5);
  for (const req of requests) {
    assert.equal(req.url, "/responses");
    assert.equal(req.authorization, "Bearer fixture-key");
    assert.deepEqual(JSON.parse(req.body).tools, [{ type: "web_search" }]);
  }
});

test("bundled Pi discovers and selects an explicit Claude Code model using only a stub executable", { timeout: 30_000 }, async t => {
  const { dir, pi, run } = await setup(t);
  const cli = join(dir, "claude"), calls = join(dir, "calls.jsonl");
  await writeFile(cli, `#!${process.execPath}\nimport ${JSON.stringify(join(checkout, "test/fixtures/fake-claude-code.mjs"))};\n`, { mode: 0o700 });
  const env = { PI_CLAUDE_CODE_COMMAND: cli, FIXTURE_CLAUDE_CALLS: calls };
  const modelId = "fixture-discovered";
  const runClaude = (model: string, extra = {}) => run([pi.claudeCodeExtension], ["--provider", "claude-code", "--model", model],
    { ...env, PATTY_CLAUDE_CODE_MODEL: model, ...extra });
  const result = await runClaude(modelId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const reply = events(result.stdout).find(event => event.type === "message_end" && event.message?.role === "assistant")?.message;
  assert.equal(reply?.provider, "claude-code");
  assert.equal(reply.model, modelId);
  assert.equal(reply.stopReason, "stop");
  assert.deepEqual(reply.content, [{ type: "text", text: "Claude Code stub replied" }]);
  const invoked = async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
  assert.deepEqual((await invoked()).filter(call => call[0] === "stream").map(call => call[1]), ["default", "fixture-route"]);
  for (const [, , args] of (await invoked()).filter(call => call[0] === "stream")) {
    assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  }

  await writeFile(calls, "");
  const unknown = await runClaude("fixture-disc");
  assert.equal(unknown.code, 1, unknown.stdout);
  assert.match(unknown.stderr, /Claude Code did not discover the requested model/);
  assert.deepEqual((await invoked()).map(call => call.slice(0, 2)), [["status"], ["stream", "default"]]);

  await writeFile(calls, "");
  const loggedOut = await runClaude(modelId, { FIXTURE_CLAUDE_LOGGED_OUT: "1" });
  assert.equal(loggedOut.code, 1, loggedOut.stdout);
  assert.match(loggedOut.stderr, /Claude Code is installed but not logged in/);
  assert.deepEqual(await invoked(), [["status"]]);
});
