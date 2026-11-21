import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { Config } from "../src/config.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { openPiRuns, outcomeText, type RunOutcome, type RunRequest } from "../src/pi-run.ts";
import { readReport, readReview } from "../src/pi-trace.ts";
import { messageText } from "../src/protocol.ts";
import { checkout, fauxConfig, fixture, until } from "./helpers.ts";

const exec = promisify(execFile);
const repo = "atlargelabs/aipatty";
const head = "a".repeat(40);
const other = "b".repeat(40);
const prUrl = `https://github.com/${repo}/pull/12`;
const issueUrl = `https://github.com/${repo}/issues/11`;

/** A fixture directory with a repository to clone, the fake CLI and the fake `gh`. */
async function setup(t: TestContext): Promise<Config> {
  const dir = await fixture(t);
  const origin = join(dir, "origin");
  await mkdir(origin);
  const git = (...args: string[]) => exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: origin });
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(origin, "README.md"), "fixture\n");
  await git("add", "README.md");
  await git("commit", "--quiet", "-m", "initial");
  const config = fauxConfig(dir);
  const reviewDir = join(dir, "git/github.com/earendil-works/pi-review");
  await mkdir(reviewDir, { recursive: true });
  await writeFile(join(reviewDir, "review.ts"), "");
  return {
    ...config,
    pi: {
      ...config.pi, cli: join(checkout, "test/fixtures/fake-pi.mjs"), extension: join(dir, "pinned-delegates/index.ts"),
      repoUrl: origin, gh: join(checkout, "test/fixtures/fake-gh.mjs"), pollMs: 50,
    },
  };
}

type Step = Record<string, unknown>;
const scenario = (config: Config, steps: Step[], extra: object = {}) =>
  writeFile(join(config.pi.agentDir, "fake-scenario.json"), JSON.stringify({ steps, ...extra }));
const github = (config: Config, known: object) => writeFile(join(config.dataDir, "fake-gh.json"), JSON.stringify(known));
const openPr = { "pr 12": { state: "OPEN", headRefOid: head, baseRefName: "main", body: "Closes #11" }, "issue 11": { number: 11, state: "OPEN" } };

function usage(cost: number) {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function assistant(text: string, cost = 0.5, stopReason = "stop", errorMessage?: string): Step {
  return { emit: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: usage(cost), stopReason, errorMessage } } };
}
const settled: Step = { emit: { type: "agent_settled", aborted: false } };
const report = (fields: object = {}) => `Done.\n<result>\n${JSON.stringify({ summary: "Added the thing.", issue: issueUrl, pr: prUrl, remaining: [], ...fields })}\n</result>`;

/** A delegate call and its result, as the delegates extension reports them. */
function delegate(callId: string, job: { id: string; profile: string; task: string; cost: number; sha?: string; summary?: string; success?: boolean; prUrl?: string }): Step[] {
  const args = { profile: job.profile, name: "job", task: job.task };
  const result = {
    id: job.id, name: "job", profile: job.profile, model: "openai/gpt-6.2-sol", execution: "stopped", success: job.success ?? true,
    summary: job.summary ?? "", workspace: { kind: "clone", baseSha: job.sha }, verification: { status: "not-run", checks: [] },
    delivery: job.prUrl ? { status: "delivered", prUrl: job.prUrl } : { status: "not-requested" },
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: job.cost, turns: 3 },
  };
  return [
    { emit: { type: "tool_execution_start", toolCallId: callId, toolName: "delegate", args } },
    // A progress update repeats nothing that counts.
    { emit: { type: "tool_execution_update", toolCallId: callId, toolName: "delegate", args, partialResult: { details: { delegateDisplay: [] } } } },
    { emit: { type: "tool_execution_end", toolCallId: callId, toolName: "delegate", isError: false, result: { content: [], details: { delegateResult: result, delegateDisplay: [] }, usage: usage(job.cost) } } },
  ];
}
const review = (callId: string, id: string, fields: { sha?: string; summary?: string; success?: boolean; task?: string } = {}) => delegate(callId, {
  id, profile: "crmanager", task: fields.task ?? "/review pr 12\nLook at the tests.", cost: 0.25, sha: fields.sha ?? head,
  summary: fields.summary ?? "No findings.\n\nOverall verdict: correct", success: fields.success,
});

const request = (fields: Partial<RunRequest> = {}): RunRequest => ({
  conversationId: 1, callId: "call-1", task: "Add the thing.", pr: true, base: "main", model: "openai/gpt-6.2-sol",
  thinking: "high", timeoutMs: 60_000, ...fields,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const launches = async (config: Config) => (await readFile(join(config.pi.agentDir, "fake-launches.jsonl"), "utf8"))
  .trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; cwd: string; prompt: string; pid: number; env: Record<string, string> });
const spawned = async (config: Config) => (await readFile(join(config.pi.agentDir, "fake-pids.txt"), "utf8").catch(() => ""))
  .trim().split("\n").filter(Boolean).map(Number);

test("a run launches the pinned CLI with only the pinned delegates extension, in a fresh clone that is then deleted", async t => {
  const config = await setup(t);
  await github(config, openPr);
  await scenario(config, [...review("c1", "job-review"), assistant(report()), settled]);
  const runs = await openPiRuns(config);
  const outcome = await runs.run(request({ task: "Add the thing.\nSecond line.", model: "openai/gpt-6.2-astra", thinking: "low" }));
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));

  const [launch, ...more] = await launches(config);
  assert.equal(more.length, 0);
  const { argv } = launch;
  assert.deepEqual(argv.slice(0, 8), ["--mode", "json", "--no-session", "--model", "openai/gpt-6.2-astra", "--thinking", "low", "--no-approve"]);
  // Exactly one extension, by absolute path into the release, and nothing discovered.
  assert.deepEqual(argv.filter((arg, index) => argv[index - 1] === "-e" || argv[index - 1] === "--extension"), [config.pi.extension]);
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp"]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.ok(!argv.some(arg => ["--approve", "-a", "--skill", "--session", "--continue"].includes(arg)));
  assert.equal(launch.env.PI_CODING_AGENT_DIR, config.pi.agentDir);
  assert.equal(launch.env.PATTY_RUN_ID, outcome.runId);
  assert.deepEqual(Object.keys(launch.env).filter(name => name.startsWith("AIPATTY_")), []);

  // The clone was the working directory, the prompt carries the task, and the rules name the workflow.
  assert.equal(launch.cwd.endsWith(join("runs", outcome.runId, "repo")), true, launch.cwd);
  assert.match(launch.prompt, /Add the thing\.\nSecond line\./);
  assert.match(launch.prompt, /checked out here at `main` \([0-9a-f]{40}\)/);
  const rules = await readFile(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
  for (const rule of [/Only Steve merges|only Steve merges/, /npm run check/, /npm test/, /Closes #N/, /\/review pr <number>/, /crmanager/, /<result>/]) assert.match(rules, rule);
  assert.deepEqual(await readdir(config.runsDir), []);
  assert.ok(existsSync(join(outcome.logDir, "events.jsonl")));
  assert.deepEqual(JSON.parse(await readFile(join(outcome.logDir, "result.json"), "utf8")).status, "completed");
  assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
});

test("the result is confirmed with gh, and delegate spend is charged once", async t => {
  const config = await setup(t);
  await github(config, openPr);
  await scenario(config, [
    assistant("Working.", 0.5, "toolUse"),
    ...delegate("c1", { id: "job-pr", profile: "prmanager", task: "Implement it.", cost: 2, prUrl }),
    // The same job reported again, as a continuation's display might: counted once.
    ...delegate("c2", { id: "job-pr", profile: "prmanager", task: "Implement it.", cost: 2, prUrl }),
    ...review("c3", "job-review"),
    { emit: { type: "message_update", usage: usage(99), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } } },
    assistant(report({ remaining: ["[P2] A lesser finding."] }), 0.25),
    { emit: { type: "agent_end", messages: [{ role: "assistant", usage: usage(99) }], willRetry: false } },
    settled,
  ]);
  const outcome = await (await openPiRuns(config)).run(request());
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  assert.deepEqual(outcome.pr, { url: prUrl, number: 12, headSha: head, state: "OPEN", confirmed: true });
  assert.deepEqual(outcome.issue, { url: issueUrl, confirmed: true });
  assert.deepEqual(outcome.review, { status: "clean", verdict: "correct", sha: head, important: 0, lesser: 0 });
  assert.equal(outcome.summary, "Added the thing.");
  assert.deepEqual(outcome.remaining, ["[P2] A lesser finding."]);
  assert.deepEqual(outcome.problems, []);
  // Pi's two messages, the prmanager once, and the review: not the streaming update, the repeat, or agent_end's copy.
  assert.equal(outcome.usage.cost.total, 0.5 + 0.25 + 2 + 0.25);
  assert.equal(outcome.usageComplete, true);
  assert.match(await readFile(join(config.dataDir, "fake-gh-calls.txt"), "utf8"), /^pr view 12 --repo atlargelabs\/aipatty /);
});

test("a result is not reported as reviewed when the review is missing, has findings, failed, or covers another commit", async t => {
  const config = await setup(t);
  await github(config, openPr);
  const runs = await openPiRuns(config);
  const run = async (steps: Step[]) => {
    await scenario(config, [...steps, assistant(report()), settled]);
    return runs.run(request());
  };
  const missing = await run([]);
  assert.equal(missing.review.status, "missing");
  assert.equal(missing.status, "completed");

  const p1 = await run(review("c1", "r1", { summary: "[P1] src/a.ts:3 breaks the build.\nOverall verdict: needs attention" }));
  assert.deepEqual(p1.review, { status: "findings", verdict: "needs attention", sha: head, important: 1, lesser: 0 });
  // A verdict of "correct" beside a P0 is still a finding, and so is a review with no readable verdict.
  assert.equal((await run(review("c1", "r2", { summary: "[P0] src/a.ts:3 loses data.\nVerdict: correct" }))).review.status, "findings");
  assert.equal((await run(review("c1", "r3", { summary: "Looks fine to me." }))).review.status, "findings");

  const stale = await run(review("c1", "r4", { sha: other }));
  assert.deepEqual(stale.review, { status: "stale", verdict: "correct", sha: other, important: 0, lesser: 0 });
  // A branch review before the PR, then nothing after: the last finished review decides.
  assert.equal((await run([...review("c1", "r5"), ...review("c2", "r6", { sha: other, task: "/review branch main" })])).review.status, "stale");
  // A review of uncommitted changes names no reviewed commit.
  assert.equal((await run(review("c1", "r7", { task: "/review uncommitted" }))).review.status, "stale");
  // A clean review followed by one that failed to finish still counts the clean one, of the same head.
  assert.equal((await run([...review("c1", "r8"), ...review("c2", "r9", { success: false, summary: "" })])).review.status, "clean");
  // Only a failed review: nothing finished.
  assert.equal((await run(review("c1", "r10", { success: false, summary: "verdict: correct" }))).review.status, "missing");

  const text = outcomeText(stale);
  assert.match(text, /Review: NOT REVIEWED: the last review covered a different commit from the PR head/);
  assert.match(text, new RegExp(`PR: ${prUrl} \\(open, head ${head}\\)`));
});

test("a successful exit or a URL in the model's output is not proof of delivery", async t => {
  const config = await setup(t);
  const runs = await openPiRuns(config);
  // GitHub has no such PR.
  await github(config, {});
  await scenario(config, [...review("c1", "r1"), assistant(report()), settled]);
  const none = await runs.run(request());
  assert.equal(none.status, "failed");
  assert.deepEqual(none.pr, { url: prUrl, number: 12, confirmed: false });
  assert.equal(none.review.status, "unverified");
  assert.match(none.problems.join("\n"), /The PR could not be confirmed with gh/);
  assert.match(outcomeText(none), /NOT CONFIRMED with GitHub/);

  // A PR of another repository, and no PR at all.
  await scenario(config, [assistant(report({ pr: "https://github.com/someone/else/pull/12" })), settled]);
  const foreign = await runs.run(request());
  assert.equal(foreign.status, "failed");
  assert.equal(foreign.pr, undefined);
  assert.match(foreign.problems.join("\n"), /not a PR of atlargelabs\/aipatty/);
  await scenario(config, [assistant("I opened a PR, trust me."), settled]);
  const claimed = await runs.run(request());
  assert.equal(claimed.status, "failed");
  assert.match(claimed.problems.join("\n"), /No PR was found, though one was requested/);

  // A merged or closed PR, one against another base, and one that does not link its issue, are reported.
  await github(config, { "pr 12": { state: "MERGED", headRefOid: head, baseRefName: "release", body: "no link" }, "issue 11": { number: 11 } });
  await scenario(config, [...review("c1", "r2"), assistant(report()), settled]);
  const merged = await runs.run(request());
  assert.match(merged.problems.join("\n"), /The PR is merged, not open\.[^]*The PR targets release, not main\.[^]*does not link issue #11/);

  // Without a PR requested, nothing is asked of GitHub and nothing is expected.
  await scenario(config, [assistant(report({ pr: null, issue: null })), settled]);
  const reportOnly = await runs.run(request({ pr: false }));
  assert.equal(reportOnly.status, "completed");
  assert.equal(reportOnly.review.status, "none");
  assert.match((await launches(config)).at(-1)!.prompt, /a report only; publish nothing/);
});

test("missing sign-in or model, a provider error, and malformed output are failures with their cause", async t => {
  const config = await setup(t);
  await github(config, openPr);
  const runs = await openPiRuns(config);

  // No credential: the CLI prints to stderr and exits 1 after the session header.
  await scenario(config, [{ stderr: "Error: No API key found for openai. Run pi auth login openai.\n" }, { exit: 1 }]);
  const auth = await runs.run(request());
  assert.equal(auth.status, "failed");
  assert.match(auth.problems.join("\n"), /Pi exited with code 1\.[^]*No API key found for openai/);
  assert.equal(auth.usage.cost.total, 0);

  // An unknown model: an error before any event.
  await scenario(config, [{ stderr: "Error: Model not found: nope\n" }, { exit: 1 }], { noHeader: true });
  const model = await runs.run(request({ model: "openai/nope" }));
  assert.equal(model.status, "failed");
  assert.match(model.problems.join("\n"), /Pi produced no event stream\.[^]*Model not found: nope/);

  // The provider failed mid-run: the process exits 0, and only the last message says so.
  await scenario(config, [assistant("", 0.1, "error", "500 upstream exploded"), settled]);
  const provider = await runs.run(request());
  assert.equal(provider.status, "failed");
  assert.match(provider.problems.join("\n"), /Pi's last message ended with "error": 500 upstream exploded/);
  assert.equal(provider.usage.cost.total, 0.1);

  // Output that is not the JSON event stream is not trusted, even with a clean exit and a plausible report.
  await scenario(config, [...review("c1", "r1"), { raw: "not json\n" }, { raw: "[1,2]\n" }, assistant(report()), settled]);
  const malformed = await runs.run(request());
  assert.equal(malformed.status, "failed");
  assert.match(malformed.problems.join("\n"), /2 line\(s\) that were not JSON events/);

  // Exit without `agent_settled`, and a report that is not the asked-for block.
  await scenario(config, [...review("c1", "r1"), assistant(report())]);
  assert.match((await runs.run(request())).problems.join("\n"), /Pi exited before it reported the run as settled/);
  await scenario(config, [...review("c1", "r1"), assistant(`All done: ${prUrl}`), settled]);
  const raw = await runs.run(request());
  assert.equal(raw.status, "failed");
  assert.equal(raw.summary, `All done: ${prUrl}`);

  // The repository cannot be cloned at the requested base.
  await scenario(config, [assistant(report()), settled]);
  const clone = await runs.run(request({ base: "no-such-branch" }));
  assert.equal(clone.status, "failed");
  assert.match(clone.problems.join("\n"), /Could not clone atlargelabs\/aipatty at no-such-branch/);
  assert.deepEqual(await readdir(config.runsDir), []);

  // Without the review extension a PR could never be reviewed: refused before anything is cloned or launched.
  const before = (await launches(config)).length;
  await rm(join(config.pi.agentDir, "git"), { recursive: true });
  const unreviewable = await runs.run(request());
  assert.equal(unreviewable.status, "failed");
  assert.match(unreviewable.problems.join("\n"), /The review extension is missing at .*pi-review\/review\.ts/);
  assert.equal((await launches(config)).length, before);
  assert.equal((await runs.run(request({ pr: false }))).status, "completed");
  await writeFile(join(config.pi.agentDir, "settings.json"), JSON.stringify({ delegates: { reviewExtension: join(checkout, "package.json") } }));
  assert.notEqual((await runs.run(request())).problems.join("\n").includes("review extension"), true);
});

test("a second run is refused while one is active, on any branch, and the slot frees afterwards", async t => {
  const config = await setup(t);
  await scenario(config, [{ hang: true }]);
  const runs = await openPiRuns(config);
  const controller = new AbortController();
  const first = runs.run(request({ conversationId: 3 }), controller.signal);
  const active = runs.active();
  assert.equal(active?.conversationId, 3);
  await assert.rejects(runs.run(request({ conversationId: 4, callId: "call-2" })),
    new RegExp(`Pi run ${active!.runId}, started from branch 3, is still active\\. Only one run at a time`));
  await until(() => existsSync(join(config.pi.agentDir, "fake-launches.jsonl")));
  controller.abort();
  assert.equal((await first).status, "aborted");
  assert.equal(runs.active(), undefined);
  await scenario(config, [assistant(report({ pr: null, issue: null })), settled]);
  assert.equal((await runs.run(request({ pr: false }))).status, "completed");
});

test("abort and timeout stop Pi and its delegates' processes, keep the logs, and delete the workspace and delegate clones", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  const steps: Step[] = [
    assistant("Working.", 0.5, "toolUse"),
    ...delegate("c1", { id: "job-done", profile: "worker", task: "Do part.", cost: 1 }),
    { emit: { type: "tool_execution_start", toolCallId: "c2", toolName: "delegate", args: { profile: "prmanager", name: "job", task: "Publish." } } },
    { job: { id: "job-running" } }, { job: { id: "job-nested", session: "another-session", source: join(config.pi.agentDir, "delegates/jobs/job-running/workspace") } },
    { job: { id: "job-unrelated", session: "someone-else", source: "/elsewhere" } },
    { spawn: true }, { spawn: true }, { hang: true },
  ];
  const runs = await openPiRuns(config);
  const jobs = join(config.pi.agentDir, "delegates/jobs");
  const check = async (outcome: RunOutcome, status: string) => {
    assert.equal(outcome.status, status);
    const [pi] = (await launches(config)).slice(-1);
    const children = (await spawned(config)).slice(-2);
    assert.equal(children.length, 2);
    await until(() => ![pi.pid, ...children].some(alive));
    assert.deepEqual(await readdir(config.runsDir), []);
    // The run's jobs, found by its session and by where they were cloned from, lose their clones and keep their logs.
    for (const id of ["job-running", "job-nested"]) {
      assert.ok(!existsSync(join(jobs, id, "workspace")), id);
      assert.ok(existsSync(join(jobs, id, "job.json")) && existsSync(join(jobs, id, "discarded")) && !existsSync(join(jobs, id, "lease.json")), id);
      assert.equal(await readFile(join(outcome.logDir, "delegates", id, "child-1.log"), "utf8"), "delegate log");
      assert.ok(!existsSync(join(outcome.logDir, "delegates", id, "workspace")));
    }
    assert.ok(existsSync(join(jobs, "job-unrelated/workspace/src/file.ts")), "another session's clone is not this run's");
    // What was spent before the stop is charged, and marked incomplete: one delegate never reported.
    assert.equal(outcome.usage.cost.total, 1.5);
    assert.equal(outcome.usageComplete, false);
    assert.match(outcome.problems.join("\n"), /1 delegate call\(s\) never reported/);
    assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
    return outcome;
  };

  await scenario(config, steps);
  const controller = new AbortController();
  const aborted = runs.run(request(), controller.signal);
  await until(async () => (await spawned(config)).length === 2);
  controller.abort();
  await check(await aborted, "aborted");

  // A run that ignores SIGTERM is killed, and a timeout reports any PR the run had already published.
  await github(config, openPr);
  await scenario(config, [...delegate("c0", { id: "job-pr", profile: "prmanager", task: "Publish.", cost: 0, prUrl }), ...steps], { ignoreTerm: true });
  const timedOut = await check(await runs.run(request({ timeoutMs: 1_500 })), "timed_out");
  assert.equal(timedOut.pr?.confirmed, true);
  assert.equal(timedOut.review.status, "missing");
  assert.match(timedOut.summary, /stopped after/);
});

test("after a crash, the next start stops the surviving processes, cleans up, and reports the call interrupted", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  await scenario(config, [
    assistant("Working.", 0.5, "toolUse"),
    ...delegate("c1", { id: "job-pr", profile: "prmanager", task: "Publish.", cost: 1, prUrl }),
    { job: { id: "job-running" } }, { spawn: true }, { hang: true },
  ]);
  // A host process that starts the run and is then killed outright.
  const script = `
    import { openPiRuns } from ${JSON.stringify(join(checkout, "src/pi-run.ts"))};
    const runs = await openPiRuns(${JSON.stringify(config)});
    await runs.run(${JSON.stringify(request({ conversationId: 7, callId: "call-crash" }))});`;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise(resolve => host.once("exit", resolve));
  t.after(() => { host.kill("SIGKILL"); });
  await until(async () => (await spawned(config)).length === 1, Boolean, 20_000);
  // Long enough for the host to have recorded the detached child.
  await until(async () => JSON.parse(await readFile(join(config.dataDir, "pi-run.json"), "utf8")).seen.length >= 2);
  host.kill("SIGKILL");
  await exited;
  const [pi] = await launches(config);
  const [child] = await spawned(config);
  assert.ok(alive(pi.pid) && alive(child), "the run outlives its host");

  const runs = await openPiRuns(config);
  assert.ok(!alive(pi.pid) && !alive(child));
  assert.deepEqual(await readdir(config.runsDir), []);
  assert.ok(!existsSync(join(config.pi.agentDir, "delegates/jobs/job-running/workspace")));
  assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
  assert.equal(runs.active(), undefined);
  const outcome = await runs.settled(7, "call-crash");
  assert.equal(outcome?.status, "interrupted");
  assert.deepEqual(outcome?.pr, { url: prUrl, number: 12, confirmed: false });
  assert.equal(outcome?.usage.cost.total, 1.5);
  assert.equal(outcome?.usageComplete, false);
  assert.match(outcome!.summary, /is not run again/);
  assert.equal(await runs.settled(7, "another-call"), undefined);

  // Never rerun: only the one launch, and a third start still knows the call.
  assert.equal((await launches(config)).length, 1);
  assert.equal((await (await openPiRuns(config)).settled(7, "call-crash"))?.status, "interrupted");
});

/** What the fake model answered last. */
async function lastText(host: AgentHost): Promise<string> {
  const { items } = await (await host.conversation("root"))!.entries({}, 10, undefined, ctx);
  return items.flatMap(entry => (entry.model ?? []).filter(message => message.role === "assistant").map(messageText)).find(Boolean) ?? "";
}

test("the pi tool returns the outcome to the calling branch and charges the run to it once", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  await github(config, openPr);
  await scenario(config, [...delegate("c1", { id: "job-pr", profile: "prmanager", task: "Implement.", cost: 2, prUrl }), ...review("c2", "r1"), assistant(report(), 0.5), settled]);
  const host = await openHost(config);
  t.after(() => host.close());
  const root = (await host.conversation("root"))!;
  const send = async (content: string) => (await host.submit(root, { type: "input", content })).wait(ctx);

  assert.equal((await send('call pi {"task":"Add the thing."}')).status, "done");
  const text = await lastText(host);
  assert.match(text, /^Faux tool result: Pi run \S+: completed\nSummary: Added the thing\./);
  assert.match(text, new RegExp(`PR: ${prUrl} \\(open, head ${head}\\)`));
  assert.match(text, /Review: reviewed \(last review: verdict correct/);
  assert.match(text, /Cost: \$2\.75, charged to this branch/);
  assert.equal((await host.branch(root)).cost, 2.75);
  assert.equal(await host.totalCost(), 2.75);
  assert.match((await launches(config))[0].prompt, /requested from aipatty's conversation branch 1\./);

  // Bad arguments are refused before anything is launched.
  await send('call pi {"task":"x","base":"--upload-pack=evil"}');
  assert.match(await lastText(host), /Not a branch, tag or commit/);
  await send('call pi {"task":"x","thinking":"loud"}');
  assert.match(await lastText(host), /Expected a thinking level/);
  assert.equal((await launches(config)).length, 1);

  // A failed run is an error result that still charges what it spent.
  await scenario(config, [assistant("", 0.25, "error", "boom"), settled]);
  await send('call pi {"task":"Again."}');
  assert.match(await lastText(host), /Pi run \S+: failed[^]*No PR was found/);
  assert.equal((await host.branch(root)).cost, 3);
});

test("the model's own tools work in the work directory", { timeout: 30_000 }, async t => {
  const config = await setup(t);
  const host = await openHost(config);
  t.after(() => host.close());
  const root = (await host.conversation("root"))!;
  const result = await (await host.submit(root, { type: "input", content: 'call bash {"command":"pwd && echo scratch > note.txt"}' })).wait(ctx);
  assert.equal(result.status, "done");
  assert.match(await lastText(host), new RegExp(`Faux tool result: ${config.workDir}\\b`));
  assert.equal(await readFile(join(config.workDir, "note.txt"), "utf8"), "scratch\n");
  const offered = (await root.agent(ctx)).tools.map(tool => tool.name);
  for (const name of ["read", "write", "edit", "bash", "codemode", "pi", "fork_branch", "list_branches", "read_branch", "set_model"]) {
    assert.ok(offered.includes(name), `${name} in ${offered.join(", ")}`);
  }
});

test("aborting the branch stops its run and reports what the run had done", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  await scenario(config, [assistant("Working.", 0.5, "toolUse"), ...delegate("c1", { id: "job-pr", profile: "prmanager", task: "Publish.", cost: 1, prUrl }), { spawn: true }, { hang: true }]);
  const host = await openHost(config);
  t.after(() => host.close());
  const root = (await host.conversation("root"))!;
  const submission = await host.submit(root, { type: "input", content: 'call pi {"task":"Add the thing."}' });
  await until(async () => (await spawned(config)).length === 1, Boolean, 20_000);
  await host.abort(root);
  assert.equal((await submission.wait(ctx)).status, "unanswered");
  const [pi] = await launches(config);
  assert.ok(!alive(pi.pid) && !alive((await spawned(config))[0]));
  assert.equal(host.runs.active(), undefined);
  assert.deepEqual(await readdir(config.runsDir), []);
  const { items } = await root.entries({}, 10, undefined, ctx);
  const results = items.flatMap(entry => (entry.model ?? []).filter(message => message.role === "toolResult").map(messageText));
  assert.equal(results.length, 1);
  assert.match(results[0], new RegExp(`Pi run \\S+: aborted[^]*PR: ${prUrl} \\(NOT CONFIRMED with GitHub\\)[^]*Cost: \\$1\\.50 \\(incomplete`));
  assert.equal((await host.branch(root)).cost, 1.5);
});

test("a restart reports the interrupted call in its branch, without running it again", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  await scenario(config, [assistant("Working.", 0.5, "toolUse"), { spawn: true }, { hang: true }]);
  const first = await openHost(config);
  const submission = await first.submit((await first.conversation("root"))!, { type: "input", content: 'call pi {"task":"Add the thing."}' });
  await until(async () => (await spawned(config)).length === 1, Boolean, 20_000);
  await first.close();
  const [pi] = await launches(config);
  assert.ok(!alive(pi.pid) && !alive((await spawned(config))[0]));
  // Left for the next start: the saved run, and no result in the transcript yet.
  assert.ok(existsSync(join(config.dataDir, "pi-run.json")));

  const second = await openHost(config);
  t.after(() => second.close());
  const root = (await second.conversation("root"))!;
  await (await second.harness.submission(submission.id, ctx))!.wait(ctx);
  await root.waitForIdle(ctx);
  const { items } = await root.entries({}, 10, undefined, ctx);
  const results = items.flatMap(entry => (entry.model ?? []).filter(message => message.role === "toolResult").map(messageText));
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.match(results[0], /Pi run \S+: interrupted\nSummary: aipatty stopped while this run was in progress/);
  assert.equal((await second.branch(root)).cost, 0.5);
  assert.equal((await launches(config)).length, 1);
  assert.deepEqual(await readdir(config.runsDir), []);
  assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
});

test("reviews and reports are read strictly", () => {
  assert.deepEqual(readReview("Overall verdict: \"correct\" (no blocking issues)"), { verdict: "correct", important: 0, lesser: 0 });
  assert.deepEqual(readReview("[P2] a\n[P3] b\nVerdict: correct"), { verdict: "correct", important: 0, lesser: 2 });
  // Both words present: the cautious reading wins.
  assert.equal(readReview("Mostly correct, but needs attention.").verdict, "needs attention");
  assert.equal(readReview("The code is incorrect.").verdict, "unknown");
  assert.equal(readReport("no block"), undefined);
  assert.equal(readReport("<result>not json</result>"), undefined);
  assert.equal(readReport('<result>{"pr":"x"}</result>'), undefined);
  assert.deepEqual(readReport('<result>{"summary":"old"}</result> then\n<result>\n```json\n{"summary":"s","pr":" ","issue":null,"remaining":["a",1]}\n```\n</result>'),
    { summary: "s", issue: undefined, pr: undefined, remaining: ["a"] });
});
