import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readConfig, type PiConfig } from "../src/config.ts";
import { checkout } from "./helpers.ts";

const exec = promisify(execFile);

async function setup(t: TestContext) {
  // Outside node_modules for real absolute/virtual resolution, and short enough for Darwin's Unix socket paths.
  const dir = await mkdtemp("/tmp/aipatty-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent"), cwd = join(dir, "checkout"), home = join(dir, "home"), temp = join(dir, "temp");
  await Promise.all([agentDir, cwd, home, temp].map(path => mkdir(path)));
  const pi = readConfig(["--pi-dir", agentDir], {}).pi;
  const env: NodeJS.ProcessEnv = {
    HOME: home, TMPDIR: temp, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: pi.agentDir, PI_TELEMETRY: "0", PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1", PUPPETEER_EXECUTABLE_PATH: join(dir, "missing-browser"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  };
  const run = async (extensions: string[], model: string[], extraEnv = {}, cli = pi.cli) => {
    const child = spawn(pi.node, [cli, "--offline", "--mode", "json", "--no-session", "--thinking", "off",
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

// Isolated releases as started through deploy/current. Reuse only the unchanged package pins, not the
// managed sources, policy or reviewer. No GitHub or installation commands are used by these smokes.
async function stage(dir: string, sha: string) {
  const release = join(dir, "deploy", sha);
  await mkdir(join(release, "node_modules/@earendil-works"), { recursive: true });
  await cp(join(checkout, "src/managed-pi"), join(release, "src/managed-pi"), { recursive: true });
  await cp(join(checkout, "src/config.ts"), join(release, "src/config.ts"));
  for (const relative of ["node_modules/pi-delegates", "node_modules/@earendil-works/pi-coding-agent"]) {
    await symlink(join(checkout, relative), join(release, relative));
  }
  const reviewer = "node_modules/@earendil-works/pi-review";
  await cp(join(checkout, reviewer), join(release, reviewer), { recursive: true });
  return release;
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
  env.FIXTURE_SEARCH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ provider: "fixture-search", model: "search-model" }));
  const ambientSearch = join(cwd, "web-search.json");
  await writeFile(ambientSearch, JSON.stringify({ provider: "must-not-load", model: "bad" }));

  for (const mode of ["missing extractor", "missing egress", "invalid egress", "missing Chrome", "stub Chrome"]) {
    if (mode !== "missing extractor") await writeFile(join(agentDir, "just-web-fetch.json"), JSON.stringify({ extensionsDir: checkoutHooks }));
    const result = await run([pi.extension, pi.webFetchExtension, pi.webSearchExtension, join(checkout, "test/fixtures/pi-extension-smoke.ts")],
      ["--model", "fixture/coding"], { FIXTURE_MARKER: marker, FIXTURE_TOOLS: tools, PI_WEB_SEARCH_CONFIG: ambientSearch,
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
    assert.match(search, /The current model coding .* does not support native web search/);
    assert.match(search, /will not switch to another configured model automatically/);
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
  assert.deepEqual([...requests], [], "ambient settings must not redirect web search");

  // Opting into a different provider in the release (rather than in shared state) still works.
  const release = await stage(dir, "with-search-policy");
  await writeFile(join(release, "src/managed-pi/web-search.json"), JSON.stringify({ provider: "fixture-search", model: "search-model" }));
  const result = await run([pi.webFetchExtension, pi.webSearchExtension, join(checkout, "test/fixtures/pi-extension-smoke.ts")],
    ["--model", "fixture/coding"], { FIXTURE_MARKER: marker, FIXTURE_TOOLS: tools, PI_WEB_SEARCH_CONFIG: ambientSearch },
    join(release, "src/managed-pi/cli.ts"));
  assert.equal(result.code, 0, result.stderr);
  const search = JSON.stringify(events(result.stdout).find(event => event.type === "tool_execution_end" && event.toolName === "web_search"));
  assert.match(search, /Fixture search result/);
  assert.match(search, /Fixture source/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "/responses");
  assert.equal(requests[0]!.authorization, "Bearer fixture-key");
  assert.deepEqual(JSON.parse(requests[0]!.body).tools, [{ type: "web_search" }]);
});

test("bundled Pi and real delegate children use release policy through upgrade and rollback", { timeout: 60_000 }, async t => {
  const { dir, agentDir, cwd, pi, env, run } = await setup(t);
  const git = (...args: string[]) => exec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env });
  const settings = join(agentDir, "settings.json"), auth = join(agentDir, "auth.json");
  const jobs = join(agentDir, "delegates/jobs"), seen = new Set<string>();
  const marker = join(dir, "ambient-executable-ran"), shell = join(dir, "ambient-shell"), extension = join(cwd, ".pi/ambient.ts");
  await writeFile(shell, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 2\n`, { mode: 0o700 });
  await mkdir(join(cwd, ".pi"));
  await writeFile(extension, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'extension ran'); export default () => {};`);
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
    shellPath: shell, defaultProjectTrust: "always", packages: ["./.pi"], extensions: [extension],
    delegates: { maxParallel: 32, maxThinkers: 32, reviewExtension: extension, environment: { checks: [], exemption: "checkout" } },
  }));
  const ambientPrompt = "standalone system prompt must not reach managed Pi";
  const ambientContext = "standalone agent instructions must not reach managed delegates";
  const ancestor = "unrelated parent instructions must not reach managed delegates";
  const projectContext = "fixture checkout instructions still reach managed delegates";
  await writeFile(join(agentDir, "SYSTEM.md"), ambientPrompt);
  await writeFile(join(agentDir, "AGENTS.md"), ambientContext);
  await writeFile(join(dir, "AGENTS.md"), ancestor);
  await writeFile(join(cwd, "AGENTS.md"), projectContext);
  await symlink(join(agentDir, "AGENTS.md"), join(cwd, "AGENTS.override.md"));
  const reviewGuidelines = join(cwd, "REVIEW_GUIDELINES.md");
  const ownGuidelines = "fixture checkout review guideline";
  const outsideGuidelines = "external guidelines must not reach crmanager";
  await writeFile(reviewGuidelines, ownGuidelines);
  await mkdir(join(agentDir, ".pi"));
  await writeFile(join(agentDir, "REVIEW_GUIDELINES.md"), outsideGuidelines);
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", ".pi", "AGENTS.md", "AGENTS.override.md", "REVIEW_GUIDELINES.md");
  await git("commit", "--quiet", "-m", "fixture");

  // The parent uses a scripted provider. The children use Pi's real Azure transport pointed at loopback via
  // its standard host env, and a fixture model present only in their shared on-disk catalog cache.
  const requests: Array<{ url?: string; auth: string | string[] | undefined; body: { input: unknown[]; tools: { name: string }[] } }> = [];
  const server = createServer(async (req, res) => {
    req.setEncoding("utf8");
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers["api-key"], body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const item = { id: "fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture child completed" }] };
    for (const event of [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "fixture", status: "completed", output: [item] } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  env.AZURE_OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.AZURE_OPENAI_API_KEY = "fixture-fallback";
  const template = azureProvider().getModels().find(m => m.id === "gpt-4.1")!;
  const cache = JSON.stringify({ azure: { models: [{ ...template, id: "cached-smoke" }],
    lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 1_000 } });
  const modelsStore = join(agentDir, "models-store.json");
  await writeFile(modelsStore, cache);
  let expectOwnGuidelines = true;
  const smoke = async (selected: PiConfig, expectedAuth: string, parallel = 10, legacyRun = false) => {
    const result = await run([selected.extension, join(checkout, "test/fixtures/pi-delegates-smoke.ts")],
      ["--model", "fixture/coding"], {}, selected.cli);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const trace = events(result.stdout);
    if (!legacyRun) {
      const shell = trace.find(event => event.toolName === "bash" && event.type === "tool_execution_end");
      assert.deepEqual(shell?.result?.content, [{ type: "text", text: "managed-shell" }]);
    }
    assert.match(JSON.stringify(trace.find(event => event.toolName === "delegate_parallel" && event.type === "tool_execution_end")), /Fixture child completed/);
    const added = (await readdir(jobs)).filter(id => !seen.has(id));
    assert.equal(added.length, 2);
    for (const id of added) {
      seen.add(id);
      const job = JSON.parse(await readFile(join(jobs, id, "job.json"), "utf8"));
      assert.equal(job.execution, "stopped", JSON.stringify({ profile: job.profileName, error: job.error }));
      assert.equal(job.summary, "Fixture child completed");
      assert.equal(job.config.maxParallel, parallel);
      assert.equal(job.config.maxThinkers, 6);
      assert.equal(job.config.reviewExtension, selected.reviewExtension);
      assert.equal(job.config.profiles.crmanager.permissions, "read-only");
      assert.equal(job.config.profiles.crmanager.workspace, "clone");
      if (!legacyRun) {
        const { publication, environment, extensions } = job.config;
        assert.deepEqual(publication, { repository: "atlargelabs/aipatty", remote: "origin", baseBranch: "main", requiredChecks: [],
          ciTimeoutMs: 600_000, allowUnpublishedBase: false });
        assert.deepEqual(environment.setup.map((step: { command: string }) => step.command), ["npm ci --ignore-scripts"]);
        assert.deepEqual(environment.checks.map((step: { command: string }) => step.command), ["npm run check", "npm test"]);
        assert.deepEqual(extensions, []);
      }
    }
    assert.equal(requests.length, 2);
    const review = requests.find(req => req.body.tools.some(tool => tool.name === "delegate_review_diff"));
    assert.ok(review);
    assert.match(JSON.stringify(review.body.input), /Delegated scope: Commit [0-9a-f]{40}/);
    assert.deepEqual(review.body.tools.map(tool => tool.name).sort(), ["codemode", "delegate_review_diff", "find", "grep", "ls", "read"]);
    assert.ok(requests.every(req => req.auth === expectedAuth), JSON.stringify(requests.map(req => req.auth)));
    assert.ok(requests.every(req => req.url?.includes("/responses") && !req.url.includes("/ambient")), JSON.stringify(requests.map(req => req.url)));
    if (!legacyRun) {
      assert.equal(JSON.stringify(review.body.input).includes(ownGuidelines), expectOwnGuidelines);
      assert.ok(!JSON.stringify(review.body.input).includes(outsideGuidelines));
      for (const req of requests) {
        const prompt = JSON.stringify(req.body.input);
        assert.ok(prompt.includes(projectContext));
        for (const outside of [ambientPrompt, ambientContext, ancestor]) assert.ok(!prompt.includes(outside), outside);
      }
    }
    requests.length = 0;
  };

  await smoke(pi, "fixture-fallback"); // No legacy settings or auth file.
  await assert.rejects(readFile(settings), { code: "ENOENT" });
  await writeFile(settings, "{}\n");
  await smoke(pi, "fixture-fallback");
  assert.equal(await readFile(settings, "utf8"), "{}\n");
  const old = await stage(dir, "first"), next = await stage(dir, "next"), current = join(dir, "deploy/current");
  await rm(reviewGuidelines);
  await symlink(join(agentDir, "REVIEW_GUIDELINES.md"), reviewGuidelines);
  await git("commit", "--quiet", "-am", "attempt to link guidelines outside checkout");
  expectOwnGuidelines = false;
  const relativeReview = "node_modules/@earendil-works/pi-review/review.ts";
  const legacy = JSON.stringify({ shellPath: shell, apiKeys: { unused: "must-not-migrate" },
    delegates: { maxParallel: 1, reviewExtension: join(current, relativeReview), environment: { checks: [], setup: [] },
      publication: { repository: "fixture/not-authorized", baseBranch: "other", requiredChecks: [] } } }, null, 2) + "\n";
  await writeFile(settings, legacy);
  const models = join(agentDir, "models.json");
  const ambientModels = JSON.stringify({ providers: { azure: {
    api: "openai-completions", baseUrl: `${env.AZURE_OPENAI_BASE_URL}/ambient`, apiKey: `!${shell}`,
    models: [{ id: "cached-smoke", name: "Ambient endpoint override" }],
  } } });
  await writeFile(models, ambientModels);
  await rm(auth, { force: true });
  const select = async (release: string): Promise<PiConfig> => {
    await rm(current, { force: true });
    await symlink(release, current);
    const { stdout } = await exec(pi.node, ["--input-type=module", "-e", `
      import { readConfig } from ${JSON.stringify(pathToFileURL(join(current, "src/config.ts")).href)};
      console.log(JSON.stringify(readConfig(["--pi-dir", ${JSON.stringify(agentDir)}], {}).pi));
    `], { env });
    const selected = JSON.parse(stdout) as PiConfig;
    assert.equal(selected.reviewExtension, join(await realpath(release), relativeReview));
    assert.equal(selected.agentDir, agentDir);
    return selected;
  };
  const first = await select(old);
  await smoke(first, "fixture-fallback"); // apiKeys migration must not consume or rewrite the old settings.
  const cleanAuth = await readFile(auth, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return "{}";
  });
  assert.deepEqual(JSON.parse(cleanAuth), {});
  assert.equal(await readFile(settings, "utf8"), legacy);

  const fixtureAuth = '{ "azure": {"type":"api_key", "key":"fixture-shared-state"} }\n';
  await writeFile(auth, fixtureAuth);
  await smoke(await select(next), "fixture-shared-state");
  await smoke(first, "fixture-shared-state"); // Repointing current doesn't change an already selected release.
  await git("rm", "-r", ".pi");
  await git("commit", "--quiet", "-m", "no project policy directory");
  await smoke(await select(old), "fixture-shared-state");
  assert.equal(await readFile(settings, "utf8"), legacy);
  assert.equal(await readFile(auth, "utf8"), fixtureAuth);
  assert.equal(await readFile(modelsStore, "utf8"), cache);
  assert.equal(await readFile(models, "utf8"), ambientModels);
  assert.equal(await readFile(join(agentDir, "SYSTEM.md"), "utf8"), ambientPrompt);
  await assert.rejects(readFile(marker), { code: "ENOENT" });

  // The raw CLI still reads the legacy settings. Remove the intentionally conflicting model override in
  // this fixture so it too selects the fixture model from the cache and talks only to loopback.
  await rm(models);
  await smoke({ ...first, cli: join(old, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    extension: join(old, "node_modules/pi-delegates/src/index.ts"), reviewExtension: join(current, relativeReview) },
    "fixture-shared-state", 1, true);
  assert.equal(await readFile(settings, "utf8"), legacy);
  assert.equal(await readFile(auth, "utf8"), fixtureAuth);

  const incomplete = await stage(dir, "bad-settings");
  const broken = await select(incomplete);
  await rm(broken.settings);
  for (const reason of [/ENOENT/, /expected the managed delegates limit/]) {
    const result = await run([broken.extension], ["--model", "fixture/coding"], {}, broken.cli);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /Invalid managed Pi settings at .*bad-settings/);
    assert.match(result.stderr, reason);
    await writeFile(broken.settings, '{"delegates":{"version":1,"maxParallel":10}}');
  }
  assert.equal((await readdir(jobs)).length, seen.size);
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
