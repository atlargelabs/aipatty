import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs, { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Config } from "../src/config.ts";
import { openHost, type AgentHost } from "../src/host.ts";
import { openPiRuns, outcomeText, type RunOutcome, type RunRequest } from "../src/pi-run.ts";
import { readReport, readReview } from "../src/pi-trace.ts";
import { listProcesses, newOwned, remember, runProcesses, stopRun, trackRunProcesses } from "../src/processes.ts";
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
      repoUrl: origin, gh: join(checkout, "test/fixtures/fake-gh.mjs"), pollMs: 50, retryMs: 10,
    },
  };
}

type Step = Record<string, unknown>;
const scenario = (config: Config, steps: Step[], extra: object = {}) =>
  writeFile(join(config.pi.agentDir, "fake-scenario.json"), JSON.stringify({ steps, ...extra }));
const github = (config: Config, known: object) => writeFile(join(config.dataDir, "fake-gh.json"), JSON.stringify(known));
/** What GitHub says a PR closes. */
const closing = (number: number, owner = "atlargelabs", name = "aipatty") => [{ number, repository: { name, owner: { login: owner } } }];
const openPr = { "pr 12": { state: "OPEN", headRefOid: head, baseRefName: "main", closingIssuesReferences: closing(11) }, "issue 11": { number: 11, state: "OPEN" } };

function usage(cost: number) {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function assistant(text: string, cost = 0.5, stopReason = "stop", errorMessage?: string): Step {
  return { emit: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: usage(cost), stopReason, errorMessage } } };
}
const settled: Step = { emit: { type: "agent_settled", aborted: false } };
const report = (fields: object = {}) => `Done.\n<result>\n${JSON.stringify({ summary: "Added the thing.", issue: issueUrl, pr: prUrl, remaining: [], ...fields })}\n</result>`;

/** A delegate call and its result, as the delegates extension reports them. */
function delegate(callId: string, job: { id: string; profile: string; task: string; cost: number; sha?: string; summary?: string; success?: boolean; prUrl?: string; continue?: string; remote?: string }): Step[] {
  const args = { profile: job.profile, name: "job", task: job.task, ...(job.continue ? { continue: job.continue } : {}) };
  const result = {
    id: job.id, name: "job", profile: job.profile, model: "openai/gpt-6.2-sol", execution: "stopped", success: job.success ?? true,
    summary: job.summary ?? "", workspace: { kind: "clone", baseSha: job.sha, remoteUrl: job.remote ?? "git@github.com:atlargelabs/aipatty.git" }, verification: { status: "not-run", checks: [] },
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
const review = (callId: string, id: string, fields: { sha?: string; summary?: string; success?: boolean; task?: string; remote?: string } = {}) => delegate(callId, {
  id, profile: "crmanager", task: fields.task ?? "/review pr 12\nLook at the tests.", cost: 0.25, sha: fields.sha ?? head,
  summary: fields.summary ?? "No findings.\n\nOverall verdict: correct", success: fields.success, remote: fields.remote,
});

const request = (fields: Partial<RunRequest> = {}): RunRequest => ({
  conversationId: 1, taskId: 101, task: "Add the thing.", pr: true, base: "main", model: "openai/gpt-6.2-sol",
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
  for (const rule of [/only Steve merges/, /npm run check/, /npm test/, /`Closes #N`, as plain text/, /\/review pr <number>/, /crmanager/, /<result>/, /do not look for or report the cost/]) assert.match(rules, rule);
  assert.deepEqual(await readdir(config.runsDir), []);
  assert.ok(existsSync(join(outcome.logDir, "events.jsonl")));
  assert.deepEqual(JSON.parse(await readFile(join(outcome.logDir, "result.json"), "utf8")), { outcome, reconciled: true, taskId: 101 });
  assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
});

test("the result is confirmed with gh, and delegate spend is charged once", async t => {
  const config = await setup(t);
  await github(config, openPr);
  await scenario(config, [
    assistant("Working.", 0.5, "toolUse"),
    ...delegate("c1", { id: "job-pr", profile: "prmanager", task: "Implement it.", cost: 2, prUrl }),
    // The same job continued after a review: a new call, reporting the spend of that call.
    ...delegate("c2", { id: "job-pr", profile: "prmanager", task: "Fix the finding.", cost: 1, prUrl, continue: "job-pr" }),
    ...review("c3", "job-review"),
    // Model work a tool of Pi's own did, such as a codemode classifier call.
    { emit: { type: "tool_execution_start", toolCallId: "c4", toolName: "codemode", args: {} } },
    { emit: { type: "tool_execution_end", toolCallId: "c4", toolName: "codemode", isError: false, result: { content: [], usage: usage(0.125) } } },
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
  // Pi's two messages, both calls of the prmanager, the review and the tool: not the streaming update, the
  // tool result's own copy of a delegate's usage, or agent_end's copy of the messages.
  assert.equal(outcome.usage.cost.total, 0.5 + 0.25 + 2 + 1 + 0.25 + 0.125);
  assert.equal(outcome.usageComplete, true);

  // A delegate call that ended without a result spent something nobody reported.
  await scenario(config, [
    { emit: { type: "tool_execution_start", toolCallId: "c1", toolName: "delegate", args: { profile: "worker", name: "job", task: "x" } } },
    { emit: { type: "tool_execution_end", toolCallId: "c1", toolName: "delegate", isError: true, result: { content: [{ type: "text", text: "launch failed" }] } } },
    ...review("c2", "job-review-2"), assistant(report()), settled,
  ]);
  const unaccounted = await (await openPiRuns(config)).run(request({ taskId: 102 }));
  assert.equal(unaccounted.usageComplete, false);
  assert.match(unaccounted.problems.join("\n"), /1 delegate call\(s\) ended without a result/);
  assert.match(await readFile(join(config.dataDir, "fake-gh-calls.txt"), "utf8"), /^pr view 12 --repo atlargelabs\/aipatty --json \S*closingIssuesReferences/);
});

test("a run is completed and reviewed only when the last finished review covers the PR at its head, clean", async t => {
  const config = await setup(t);
  await github(config, openPr);
  const runs = await openPiRuns(config);
  const run = async (steps: Step[]) => {
    await scenario(config, [...steps, assistant(report()), settled]);
    return runs.run(request());
  };
  /** A run whose PR exists but is not reviewed clean is not completed. */
  const unreviewed = async (steps: Step[], status: string) => {
    const outcome = await run(steps);
    assert.equal(outcome.review.status, status, JSON.stringify(outcome.review));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.pr?.confirmed, true);
    assert.match(outcome.problems.join("\n"), /The PR is not reviewed clean\./);
    return outcome;
  };
  await unreviewed([], "missing");

  const p1 = await unreviewed(review("c1", "r1", { summary: "[P1] src/a.ts:3 breaks the build.\nOverall verdict: needs attention" }), "findings");
  assert.deepEqual(p1.review, { status: "findings", verdict: "needs attention", sha: head, important: 1, lesser: 0 });
  // A verdict of "correct" beside a P0 is still a finding, and so is a review that states no verdict.
  await unreviewed(review("c1", "r2", { summary: "[P0] src/a.ts:3 loses data.\nVerdict: correct" }), "findings");
  await unreviewed(review("c1", "r3", { summary: "Looks fine to me." }), "findings");
  await unreviewed(review("c1", "r3b", { summary: "I could not determine whether the change is correct." }), "findings");

  const stale = await unreviewed(review("c1", "r4", { sha: other }), "stale");
  assert.deepEqual(stale.review, { status: "stale", verdict: "correct", sha: other, important: 0, lesser: 0 });
  // The right commit under another request is not a review of the PR's diff: one commit of it, another PR, a branch.
  await unreviewed(review("c1", "r4b", { task: `/review commit ${head}` }), "stale");
  await unreviewed(review("c1", "r4c", { task: "/review pr 13" }), "stale");
  await unreviewed(review("c1", "r4d", { task: "/review pr https://github.com/someone/else/pull/12" }), "stale");
  // PR 12 of a fork, in a clone whose origin is the fork.
  await unreviewed(review("c1", "r4e", { remote: "git@github.com:someone/aipatty.git" }), "stale");
  await unreviewed(review("c1", "r4f", { summary: 'I cannot give this patch the verdict "correct".' }), "findings");
  // A PR review, then a branch review after it: the last finished review decides.
  await unreviewed([...review("c1", "r5"), ...review("c2", "r6", { task: "/review branch main" })], "stale");
  // A review of uncommitted changes names no reviewed commit.
  await unreviewed(review("c1", "r7", { task: "/review uncommitted" }), "stale");
  // Only a failed review: nothing finished.
  await unreviewed(review("c1", "r10", { success: false, summary: "verdict: correct" }), "missing");

  // A clean review followed by one that failed to finish still counts the clean one, and the PR may be named by URL.
  const clean = await run([...review("c1", "r8", { task: `/review pr ${prUrl}`, remote: "https://github.com/atlargelabs/aipatty" }), ...review("c2", "r9", { success: false, summary: "" })]);
  assert.equal(clean.review.status, "clean");
  assert.equal(clean.status, "completed", JSON.stringify(clean.problems));

  const text = outcomeText(stale);
  assert.match(text, /^Pi run \S+: failed/);
  assert.match(text, /Review: NOT REVIEWED: the last review was not a `\/review pr` of this PR, in this repository, at its head commit and current base/);

  // A PR retargeted after its review has another diff under the same head; one retargeted before it does not.
  const retargeted = (created_at: string) => github(config, { ...openPr, "events 12": [{ event: "labeled", created_at }, { event: "base_ref_changed", created_at }] });
  await retargeted(new Date(Date.now() + 3_600_000).toISOString());
  await unreviewed(review("c1", "r11"), "stale");
  await retargeted("2020-01-01T00:00:00Z");
  assert.equal((await run(review("c1", "r12"))).status, "completed");
  // The review's start is what counts: a base changed while a long review was running is not what it reviewed.
  const startedAt = Date.now();
  await github(config, { ...openPr, "events 12": [{ event: "base_ref_changed", created_at: new Date(startedAt + 2_000).toISOString() }] });
  const [started, , ended] = review("c1", "r13");
  await unreviewed([started, { sleep: 3_000 }, ended], "stale");
  // A change on a later page of a long history is found.
  await github(config, { ...openPr, "events 12": [...Array.from({ length: 150 }, () => ({ event: "labeled", created_at: "2020-01-01T00:00:00Z" })), { event: "base_ref_changed", created_at: new Date(Date.now() + 3_600_000).toISOString() }] });
  await unreviewed(review("c1", "r14"), "stale");
  await github(config, openPr);

  // Reviews of one parallel call finished in no known order: a clean one does not outweigh a blocking one.
  const both = (results: Step[][]) => {
    const jobs = results.map(steps => (steps[2].emit as { result: { details: { delegateResult: object } } }).result.details.delegateResult);
    const tasks = results.map(steps => (steps[0].emit as { args: object }).args);
    return [
      { emit: { type: "tool_execution_start", toolCallId: "p1", toolName: "delegate_parallel", args: { tasks } } },
      { emit: { type: "tool_execution_end", toolCallId: "p1", toolName: "delegate_parallel", isError: false, result: { content: [], details: { delegateResult: jobs } } } },
    ];
  };
  const blocking = await unreviewed(both([review("x", "r15", { summary: "[P1] broken\nVerdict: needs attention" }), review("x", "r16")]), "findings");
  assert.equal(blocking.review.important, 1);
  assert.equal((await run(both([review("x", "r17"), review("x", "r18")]))).status, "completed");
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

  // A merged or closed PR, one against another base, and one GitHub does not list as closing its issue, are reported.
  await github(config, { "pr 12": { state: "MERGED", headRefOid: head, baseRefName: "release", closingIssuesReferences: [] }, "issue 11": { number: 11 } });
  await scenario(config, [...review("c1", "r2"), assistant(report()), settled]);
  const merged = await runs.run(request());
  assert.equal(merged.status, "failed");
  assert.match(merged.problems.join("\n"), /The PR is merged, not open\.[^]*The PR targets release, not main\.[^]*GitHub does not list issue #11 as one the PR closes/);
  // Only GitHub's own reading of the body counts: not text in it that merely looks like a link, another
  // repository's issue 11, or issue 110.
  for (const [id, references] of [["r2b", closing(11, "someone", "elsewhere")], ["r2c", closing(110)], ["r2d", undefined]] as const) {
    await github(config, { "pr 12": { ...openPr["pr 12"], body: "<!-- Closes #11 -->", closingIssuesReferences: references }, "issue 11": { number: 11 } });
    await scenario(config, [...review("c1", id), assistant(report()), settled]);
    const unlinked = await runs.run(request());
    assert.equal(unlinked.status, "failed", id);
    assert.match(unlinked.problems.join("\n"), /GitHub does not list issue #11 as one the PR closes/);
  }
  // It was asked again before giving up, since GitHub works the links out a moment after the PR is written.
  assert.equal((await readFile(join(config.dataDir, "fake-gh-calls.txt"), "utf8")).trim().split("\n").slice(-5).filter(call => call.startsWith("pr view 12")).length, 3);

  // The link arrives on the second answer: accepted. But the answer that has it stands as a whole: if the head
  // moved meanwhile, the review of the earlier head does not cover it.
  const late = (pr: object) => [{ ...openPr["pr 12"], closingIssuesReferences: [] }, { ...openPr["pr 12"], ...pr }];
  await rm(join(config.dataDir, "fake-gh-calls.txt"));
  await github(config, { "pr 12": late({}), "issue 11": { number: 11 } });
  await scenario(config, [...review("c1", "r2e"), assistant(report()), settled]);
  assert.equal((await runs.run(request())).status, "completed");
  await rm(join(config.dataDir, "fake-gh-calls.txt"));
  await github(config, { "pr 12": late({ headRefOid: other }), "issue 11": { number: 11 } });
  await scenario(config, [...review("c1", "r2f"), assistant(report()), settled]);
  const moved = await runs.run(request());
  assert.equal(moved.status, "failed");
  assert.equal(moved.pr?.headSha, other);
  assert.equal(moved.review.status, "stale");

  // A reviewed PR with no issue is not the workflow either.
  await github(config, openPr);
  await scenario(config, [...review("c1", "r3"), assistant(report({ issue: null })), settled]);
  const noIssue = await runs.run(request());
  assert.equal(noIssue.status, "failed");
  assert.match(noIssue.problems.join("\n"), /No issue was reported for this change/);

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
  assert.match(clone.problems.join("\n"), /Could not clone atlargelabs\/aipatty at no-such-branch: no such branch, tag or commit/);
  // A file of the tree is not a base, though `git checkout` would take it.
  const file = await runs.run(request({ base: "README.md" }));
  assert.match(file.problems.join("\n"), /Could not clone atlargelabs\/aipatty at README\.md: no such branch, tag or commit/);
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
  await assert.rejects(runs.run(request({ conversationId: 4, taskId: 102 })),
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
    // What the cut-off call left: a running job and the job it started, each with its own spend so far, and a
    // finished job whose spend already includes its child's.
    { job: { id: "job-running", cost: 0.75 } },
    { job: { id: "job-nested", parentId: "job-running", cost: 0.25, session: "another-session", source: join(config.pi.agentDir, "delegates/jobs/job-running/workspace") } },
    { job: { id: "job-finished", cost: 0.5, finishedAt: "2026-01-01T00:00:00Z" } }, { job: { id: "job-finished-child", parentId: "job-finished", cost: 0.125 } },
    { job: { id: "job-unrelated", session: "someone-else", source: "/elsewhere", cost: 64 } },
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
    assert.equal(await readFile(join(outcome.logDir, "delegates/job-done/child-1.log"), "utf8"), "reported delegate log");
    // What was spent before the stop is charged: Pi's message, the delegate that reported, and what the jobs of
    // the cut-off call had recorded. It is marked incomplete.
    assert.equal(outcome.usage.cost.total, 0.5 + 1 + 0.75 + 0.25 + 0.5);
    assert.equal(outcome.usageComplete, false);
    assert.match(outcome.problems.join("\n"), /1 delegate call\(s\) were cut off before they reported/);
    assert.doesNotMatch(outcome.problems.join("\n"), /manifest/);
    assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
    return outcome;
  };

  // A job directory that is a link is never followed, whatever its manifest says.
  const victim = join(config.dataDir, "victim");
  await mkdir(join(victim, "workspace"), { recursive: true });
  await writeFile(join(victim, "job.json"), JSON.stringify({ id: "linked", ownerSession: "fake-session", workspace: { source: "/" } }));
  await mkdir(jobs, { recursive: true });
  await symlink(victim, join(jobs, "linked"));

  // A job the run reported is the run's even with its manifest damaged: its logs are kept and its clone goes.
  await mkdir(join(jobs, "job-done", "workspace"), { recursive: true });
  await writeFile(join(jobs, "job-done", "job.json"), "{ damaged");
  await writeFile(join(jobs, "job-done", "child-1.log"), "reported delegate log");
  // Nor is an old job's damaged manifest this run's problem.
  await mkdir(join(jobs, "ancient"));
  await writeFile(join(jobs, "ancient", "job.json"), "{ damaged");
  await utimes(join(jobs, "ancient", "job.json"), new Date(0), new Date(0));

  await scenario(config, steps);
  const controller = new AbortController();
  const aborted = runs.run(request(), controller.signal);
  await until(async () => (await spawned(config)).length === 2);
  controller.abort();
  await check(await aborted, "aborted");

  // A run that ignores SIGTERM is killed, and a timeout reports any PR the run had already published.
  await github(config, openPr);
  await scenario(config, [...delegate("c0", { id: "job-pr", profile: "prmanager", task: "Publish.", cost: 0, prUrl }), ...steps], { ignoreTerm: true });
  const timedOut = await check(await runs.run(request({ timeoutMs: 3_000 })), "timed_out");
  assert.equal(timedOut.pr?.confirmed, true);
  assert.equal(timedOut.review.status, "missing");
  assert.match(timedOut.summary, /stopped after/);
  assert.ok(existsSync(join(victim, "workspace")) && !existsSync(join(victim, "discarded")), "the linked directory is untouched");
});

test("after a crash, the next start stops the surviving processes, cleans up, and reports the call interrupted", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  await scenario(config, [
    assistant("Working.", 0.5, "toolUse"),
    ...delegate("c1", { id: "job-pr", profile: "prmanager", task: "Publish.", cost: 1, prUrl }),
    { job: { id: "job-running", cost: 0.5 } }, { spawn: true }, { hang: true },
  ]);
  // A host process that starts the run and is then killed outright.
  const script = `
    import { openPiRuns } from ${JSON.stringify(join(checkout, "src/pi-run.ts"))};
    const runs = await openPiRuns(${JSON.stringify(config)});
    await runs.run(${JSON.stringify(request({ conversationId: 7, taskId: 107 }))});`;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise(resolve => host.once("exit", resolve));
  t.after(() => { host.kill("SIGKILL"); });
  await until(async () => (await spawned(config)).length === 1, Boolean, 20_000);
  const [child] = await spawned(config);
  // Long enough for the host to have persisted this group's own observation time.
  await until(async () => {
    const saved = JSON.parse(await readFile(join(config.dataDir, "pi-run.json"), "utf8"));
    return saved.groups.some(([pgid, seenAt]: [number, number | null]) => pgid === child && Number.isSafeInteger(seenAt));
  });
  host.kill("SIGKILL");
  await exited;
  const [pi] = await launches(config);
  assert.ok(alive(pi.pid) && alive(child), "the run outlives its host");

  const runs = await openPiRuns(config);
  assert.ok(!alive(pi.pid) && !alive(child));
  assert.deepEqual(await readdir(config.runsDir), []);
  assert.ok(!existsSync(join(config.pi.agentDir, "delegates/jobs/job-running/workspace")));
  assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
  assert.equal(runs.active(), undefined);
  const outcome = await runs.settled(107);
  assert.equal(outcome?.status, "interrupted");
  assert.deepEqual(outcome?.pr, { url: prUrl, number: 12, confirmed: false });
  // Pi's message, the delegate that reported, and what the running job had recorded.
  assert.equal(outcome?.usage.cost.total, 0.5 + 1 + 0.5);
  assert.equal(outcome?.usageComplete, false);
  assert.match(outcome!.summary, /is not run again/);
  assert.equal(await runs.settled(999), undefined);

  // Never rerun: only the one launch, and a third start still knows the call.
  assert.equal((await launches(config)).length, 1);
  assert.equal((await (await openPiRuns(config)).settled(107))?.status, "interrupted");
});

for (const leaderExits of [true, false]) test(`a crash during adoption blocks recovery cleanup without signalling the ${leaderExits ? "orphan" : "unmarked leader or its child"}`, { timeout: 30_000 }, async t => {
  const config = await setup(t);
  const pidsFile = join(config.dataDir, "setup-pids.json");
  const scanStarted = join(config.dataDir, "scan-started");
  const git = config.pi.git;
  config.pi.git = join(config.dataDir, "fake-git");
  // The first setup command leaves an unmarked member in its group, then either exits or stays alive.
  await writeFile(config.pi.git, `#!/usr/bin/env node
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { env: {}, stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ leader: process.pid, survivor: child.pid }));
    child.unref();
    ${leaderExits ? "" : "setTimeout(() => {}, 60000);"}
  `, { mode: 0o700 });
  // Stall the first process-table read in the host only and hide the setup command's environment marker.
  const script = `
    import cp from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const execFile = cp.execFile;
    cp.execFile = (file, ...args) => file === "ps" ? writeFileSync(${JSON.stringify(scanStarted)}, "") : execFile(file, ...args);
    const spawn = cp.spawn;
    cp.spawn = (file, args, options) => {
      if (!options?.detached) return spawn(file, args, options);
      const { PATTY_RUN_ID, ...env } = options.env;
      return spawn(file, args, { ...options, env });
    };
    syncBuiltinESMExports();
    const { openPiRuns } = await import(${JSON.stringify(join(checkout, "src/pi-run.ts"))});
    const runs = await openPiRuns(${JSON.stringify(config)});
    await runs.run(${JSON.stringify(request({ pr: false }))});`;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise(resolve => host.once("exit", resolve));
  const readPids = async () => {
    const text = await readFile(pidsFile, "utf8").catch(() => "");
    return text ? JSON.parse(text) as { leader: number; survivor: number } : undefined;
  };
  let pids: Awaited<ReturnType<typeof readPids>>;
  try {
    pids = await until(readPids, Boolean);
    const { leader, survivor } = pids!;
    await until(() => existsSync(scanStarted) && (!leaderExits || !alive(leader)));
    host.kill("SIGKILL");
    await exited;
    const stateFile = join(config.dataDir, "pi-run.json");
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(saved.groups, [[leader, null]], "the group's unknown cutoff was already saved before ps");
    assert.deepEqual(saved.procs, []);

    t.mock.method(console, "error", () => {});
    config.pi.git = git;
    const recovered = await openPiRuns(config);
    await assert.rejects(recovered.run(request({ pr: false })), new RegExp(
      `${leaderExits ? 1 : 2} process\\(es\\) could not be stopped, or could not be told from the run's`,
    ));
    assert.ok(alive(survivor) && (leaderExits || alive(leader)), "unknown group evidence does not authorize a signal");
    assert.ok(existsSync(saved.workspace) && existsSync(stateFile), "the survivor blocks cleanup");
  } finally {
    host.kill("SIGKILL");
    await exited;
    const children = pids ?? await readPids();
    for (const pid of [children?.survivor, leaderExits ? undefined : children?.leader]) {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }
});

test("a failed group checkpoint prevents the setup command from starting and retries the record", { timeout: 30_000 }, async t => {
  const config = await setup(t);
  config.pi.git = join(config.dataDir, "slow-git");
  const pidFile = join(config.dataDir, "git-pid");
  await writeFile(config.pi.git, `#!/usr/bin/env node
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setTimeout(() => {}, 60000);
  `, { mode: 0o700 });
  const stateFile = join(config.dataDir, "pi-run.json");
  let pid = 0;
  let retried = false;
  const rename = fs.rename;
  const renameMock = t.mock.method(fs, "rename", async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (to === stateFile) {
      const { groups } = JSON.parse(await readFile(from, "utf8"));
      if (groups.length && !pid) {
        pid = groups[0][0];
        assert.deepEqual(groups, [[pid, null]]);
        assert.ok(alive(pid), "the detached launcher is waiting for permission");
        await sleep(500); // Give a command that was incorrectly launched time to leave its marker.
        throw new Error("test group checkpoint failure");
      }
      if (groups.some(([pgid, cutoff]: [number, number | null]) => pgid === pid && cutoff === null)) retried = true;
    }
    await rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const runs = await openPiRuns(config);
    const outcome = await runs.run(request({ pr: false, timeoutMs: 10_000 }));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.problems.join("\n"), /could not save process group \d+: test group checkpoint failure/);
    assert.ok(pid && !alive(pid) && retried, "stop the launcher and retry the unknown group record");
    assert.ok(!existsSync(pidFile), "the actual command never ran");
    assert.ok(!existsSync(stateFile));
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("a stop finds a held, unmarked setup tree even when adoption could not read ps", { timeout: 30_000 }, async t => {
  const config = await setup(t);
  const task = join(config.dataDir, "setup-task.cjs");
  const pidsFile = join(config.dataDir, "setup-pids.json");
  await writeFile(task, `
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"],
      { detached: true, stdio: "ignore", env: {} });
    require("node:fs").writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, child.pid]));
    setTimeout(() => {}, 60000);
  `);
  config.pi.git = join(config.dataDir, "fake-git");
  await writeFile(config.pi.git, `#!/bin/sh\nunset PATTY_RUN_ID\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(task)}\n`, { mode: 0o700 });

  // Fail only the first process-table read in adoption. Subsequent stop scans must use the held child as a root.
  const ps = join(config.dataDir, "ps");
  const failed = JSON.stringify(join(config.dataDir, "ps-failed"));
  await writeFile(ps, `#!/bin/sh\nif [ ! -f ${failed} ]; then : > ${failed}; exit 1; fi\nexec /bin/ps "$@"\n`, { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = `${config.dataDir}:${path ?? ""}`;
  const controller = new AbortController();
  let pids: number[] = [];
  let running: Promise<RunOutcome> | undefined;
  try {
    const runs = await openPiRuns(config);
    running = runs.run(request({ pr: false, timeoutMs: 10_000 }), controller.signal);
    const text = await until(() => readFile(pidsFile, "utf8").catch(() => ""));
    pids = JSON.parse(text);
    const stateFile = join(config.dataDir, "pi-run.json");
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).procs, [], "adoption recorded no exact identities");
    controller.abort();
    const outcome = await running;
    assert.equal(outcome.status, "aborted");
    assert.deepEqual(outcome.problems, []);
    assert.ok(pids.every(pid => !alive(pid)), "the held leader and its unmarked child in a separate group stopped");
    assert.ok(!existsSync(stateFile));
  } finally {
    controller.abort();
    await running?.catch(() => {});
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("polling records an unmarked delegate from the held Pi handle before Pi exits", { timeout: 30_000 }, async t => {
  const config = await setup(t);
  await scenario(config, [{ spawn: true }, { waitForFile: "let-pi-exit" }, assistant(report({ pr: null, issue: null })), settled]);
  // Hide Pi's marker and fail its adoption read, but leave setup reads and subsequent polls alone.
  const script = `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { promisify } from "node:util";
    let failNextPs = false;
    const spawn = cp.spawn;
    cp.spawn = (file, args, options) => {
      if (!options?.detached || args[3] !== ${JSON.stringify(config.pi.node)}) return spawn(file, args, options);
      failNextPs = true;
      const { PATTY_RUN_ID, ...env } = options.env;
      return spawn(file, args, { ...options, env });
    };
    const execFile = cp.execFile;
    const exec = promisify(execFile);
    cp.execFile = (...args) => execFile(...args);
    cp.execFile[promisify.custom] = async (file, ...args) => {
      if (file === "ps" && failNextPs) {
        failNextPs = false;
        throw new Error("test adoption scan failure");
      }
      return exec(file, ...args);
    };
    syncBuiltinESMExports();
    const { openPiRuns } = await import(${JSON.stringify(join(checkout, "src/pi-run.ts"))});
    const runs = await openPiRuns(${JSON.stringify(config)});
    await runs.run(${JSON.stringify(request({ pr: false, timeoutMs: 20_000 }))});`;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise(resolve => host.once("exit", resolve));
  try {
    const [delegatePid] = await until(() => spawned(config), pids => pids.length === 1);
    const [pi] = await launches(config);
    assert.equal(pi.env.PATTY_RUN_ID, undefined);
    const stateFile = join(config.dataDir, "pi-run.json");
    await until(async () => JSON.parse(await readFile(stateFile, "utf8")).procs.some(([pid]: [number, string]) => pid === delegatePid));
    await writeFile(join(config.pi.agentDir, "let-pi-exit"), "");
    assert.equal(await exited, 0);
    assert.ok(!alive(delegatePid), "cleanup can still find the unmarked delegate after its parent has exited");
    assert.ok(!existsSync(stateFile));
    const outcome = await (await openPiRuns(config)).settled(101);
    assert.equal(outcome?.status, "completed", JSON.stringify(outcome));
  } finally {
    host.kill("SIGKILL");
    await exited;
    const pids = [...(await launches(config).catch(() => [])).map(pi => pi.pid), ...await spawned(config)];
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
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
  assert.deepEqual(readReview("[P2] a\n[P3] b\n**Verdict:** correct"), { verdict: "correct", important: 0, lesser: 2 });
  // Findings open their line, in a list, a heading or a table. A tag later in a line, in a quote or in an example is a mention.
  assert.deepEqual(readReview("1. **[P1] a**\n- [P0] b\n### [P2] c\n| [P1] | `src/x.ts` | d |\n**Verdict: needs attention.**"), { verdict: "needs attention", important: 3, lesser: 1 });
  assert.deepEqual(readReview("1. `[P1]` Missed child\n+ [P1] Another\n* _[P3]_ Small\nVerdict: correct"), { verdict: "correct", important: 2, lesser: 1 });
  assert.deepEqual(readReview("The previous [P1] finding is resolved.\n> [P0] old\n```\n[P1] example\n```\nVerdict: correct"), { verdict: "correct", important: 0, lesser: 0 });
  for (const clean of ["The verdict is correct.", "## Final verdict — `correct`", "- **Overall verdict:** \"correct\" (no blocking issues)",
    "**Verdict: correct.** Nothing blocks.", "Verdict: correct", "## Verdict\n\n**correct**: no blocking issues.\n\n## Callouts", "### Verdict\n\nCorrect.",
    "> Verdict: needs attention\n\nThat earlier review is resolved.\n\nVerdict: correct"]) {
    assert.equal(readReview(clean).verdict, "correct", clean);
  }
  for (const blocking of ["**Verdict: needs attention.**", "## Verdict\n\nneeds attention", "Verdict: needs_attention",
    "Verdict: correct, though it needs attention", "## Verdict\n\nThis needs attention before merging.",
    // Any declared "needs attention" wins, wherever it stands.
    "Verdict: correct\nOn reflection.\nVerdict: needs attention", "Verdict: needs attention\n\nOnce fixed it would read:\n\nVerdict: correct"]) {
    assert.equal(readReview(blocking).verdict, "needs attention", blocking);
  }
  // Prose that uses the word, a negation, a request, someone else's verdict, or a summary cut off before its own.
  for (const prose of ["Mostly correct.", "The code is incorrect.", "I could not determine whether the change is correct.",
    'I cannot give this patch the verdict "correct".', "No verdict of correct is warranted.", "Verdict: not correct", "Verdict: incorrect",
    "Verdict: correct the cleanup first", "Verdict: correctness is unclear",
    "## Verdict\n\nCorrect the cleanup before merging.", "## Verdict\n\nCorrect `cleanUp` before merging.", "Verdict: correct `x` first",
    "## Verdict\n\nThe change is not correct.", "## Verdict",
    "> Verdict: correct\nI disagree; the cleanup is still broken.",
    "The review should end like this:\n```\nVerdict: correct\n```\nbut I am not there yet.",
    "Verdict: correct\n\n## Verdict\n\nUnclear.",
    "No verdict is possible; correct me if I am wrong.", "[P2] a finding, and then the text was cut"]) {
    assert.equal(readReview(prose).verdict, "unknown", prose);
  }
  // A fenced example does not override the reviewer's own declaration, nor does a fence shown inside one.
  assert.equal(readReview("Verdict: needs attention\n\n~~~\nVerdict: correct\n~~~").verdict, "needs attention");
  assert.equal(readReview("~~~markdown\n```\nVerdict: correct\n~~~\nVerdict: needs attention").verdict, "needs attention");
  assert.equal(readReview("````\n```\nVerdict: correct\n```\n````\nVerdict: needs attention").verdict, "needs attention");
  assert.equal(readReport("no block"), undefined);
  assert.equal(readReport("<result>not json</result>"), undefined);
  assert.equal(readReport('<result>{"pr":"x"}</result>'), undefined);
  assert.deepEqual(readReport('<result>{"summary":"old"}</result> then\n<result>\n```json\n{"summary":"s","pr":" ","issue":null,"remaining":["a",1]}\n```\n</result>'),
    { summary: "s", issue: undefined, pr: undefined, remaining: ["a"] });
});

test("an outcome settled before the harness committed it survives a restart, and an abort while it settles does not change it", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  await github(config, { ...openPr, delayMs: 1_500 });
  await scenario(config, [...review("c1", "r1"), assistant(report()), settled]);
  const runs = await openPiRuns(config);
  const controller = new AbortController();
  const running = runs.run(request({ conversationId: 5, taskId: 105 }), controller.signal);
  // Pi is done and the host is asking GitHub: the run ends as it ended.
  await until(() => existsSync(join(config.dataDir, "fake-gh-calls.txt")), Boolean, 20_000);
  controller.abort();
  const late = runs.settled(105);
  const outcome = await running;
  assert.equal(outcome.status, "completed", JSON.stringify(outcome.problems));
  assert.equal(outcome.review.status, "clean");
  assert.deepEqual(await late, outcome);

  // The process dies before the harness commits the tool result: the next start still has it, by call.
  const next = await openPiRuns(config);
  assert.deepEqual(await next.settled(105), outcome);
  assert.equal(await next.settled(998), undefined);

  // With the index unreadable, it is rebuilt from the copies in the run logs.
  t.mock.method(console, "error", () => {});
  await writeFile(join(config.dataDir, "pi-outcomes.json"), "{ not json");
  const rebuilt = await (await openPiRuns(config)).settled(105);
  assert.equal(rebuilt?.status, "completed");
  assert.equal(rebuilt?.runId, outcome.runId);
  // The rebuilt index was saved: another restart still has the outcome.
  assert.equal((await (await openPiRuns(config)).settled(105))?.runId, outcome.runId);

  // The process died after the run's own copy of the result was written and before the index and the record caught
  // up: the settled result stands, and is not replaced by an interruption.
  await rm(join(config.dataDir, "pi-outcomes.json"));
  await writeFile(join(config.dataDir, "pi-run.json"), JSON.stringify({
    runId: outcome.runId, conversationId: 5, taskId: 105, pr: true, startedAt: "", procs: [], groups: [], asOf: Date.now(),
    workspace: join(config.runsDir, outcome.runId), logDir: outcome.logDir,
  }));
  const ahead = await openPiRuns(config);
  assert.equal((await ahead.settled(105))?.status, "completed");
  assert.ok(!existsSync(join(config.dataDir, "pi-run.json")));
  assert.equal(ahead.active(), undefined);
});

test("a cut-off continuation charges the new attempt once, and never the earlier one again", { timeout: 60_000 }, async t => {
  const config = await setup(t);
  const runs = await openPiRuns(config);
  const first = delegate("c1", { id: "job-pr", profile: "prmanager", task: "Implement.", cost: 2, prUrl });
  const again = { emit: { type: "tool_execution_start", toolCallId: "c2", toolName: "delegate", args: { profile: "prmanager", name: "job", task: "Fix.", continue: "job-pr" } } };
  const stop = async (steps: Step[]) => {
    await rm(join(config.pi.agentDir, "fake-pids.txt"), { force: true });
    await scenario(config, [...first, again, ...steps, { spawn: true }, { hang: true }]);
    const controller = new AbortController();
    const running = runs.run(request(), controller.signal);
    await until(async () => (await spawned(config)).length === 1, Boolean, 20_000);
    controller.abort();
    return (await running).usage.cost.total;
  };
  // Stopped before the extension replaced the manifest: it still holds the first attempt, already charged. A job
  // the first attempt started is under it too.
  assert.equal(await stop([
    { job: { id: "job-pr", cost: 2, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:10:00.000Z", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 3 } } },
    { job: { id: "job-old-child", parentId: "job-pr", cost: 0.5, startedAt: "2026-01-01T00:05:00.000Z", finishedAt: "2026-01-01T00:06:00.000Z" } },
  ]), 2);
  // Stopped during the new attempt: its spend so far and its own child's are added; the first attempt's child is not.
  assert.equal(await stop([
    { job: { id: "job-pr", cost: 0.75, startedAt: "2026-01-01T01:00:00.000Z" } },
    { job: { id: "job-old-child", parentId: "job-pr", cost: 0.5, startedAt: "2026-01-01T00:05:00.000Z", finishedAt: "2026-01-01T00:06:00.000Z" } },
    { job: { id: "job-new-child", parentId: "job-pr", cost: 0.25, startedAt: "2026-01-01T01:05:00.000Z" } },
  ]), 2 + 0.75 + 0.25);
  // A continuation that ended without a result: what its manifest recorded is still charged.
  assert.equal(await stop([
    { emit: { type: "tool_execution_end", toolCallId: "c2", toolName: "delegate", isError: true, result: { content: [{ type: "text", text: "failed" }] } } },
    { job: { id: "job-pr", cost: 0.5, startedAt: "2026-01-01T02:00:00.000Z", finishedAt: "2026-01-01T02:10:00.000Z" } },
  ]), 2 + 0.5);
});

test("a run record that cannot be used blocks new runs and deletes nothing", async t => {
  const config = await setup(t);
  await scenario(config, [assistant(report({ pr: null, issue: null })), settled]);
  const logged = t.mock.method(console, "error", () => {});
  const stateFile = join(config.dataDir, "pi-run.json");

  await writeFile(stateFile, "{ not json");
  await assert.rejects((await openPiRuns(config)).run(request({ pr: false })), /pi-run\.json, cannot be used[^]*No new run starts until it is inspected/);
  assert.equal(await readFile(stateFile, "utf8"), "{ not json");

  // A record naming a directory that is not the run's own is not followed.
  const victim = join(config.dataDir, "precious");
  await mkdir(victim);
  await writeFile(join(victim, "keep.txt"), "keep");
  await writeFile(stateFile, JSON.stringify({
    runId: "20260101T000000-deadbeef", conversationId: 1, callId: "c", pr: false, startedAt: "", workspace: victim,
    logDir: join(config.dataDir, "logs/runs/20260101T000000-deadbeef"), procs: [], groups: [],
  }));
  await assert.rejects((await openPiRuns(config)).run(request({ pr: false })), /does not describe a run of this data directory/);
  assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "keep");
  assert.ok(logged.mock.callCount() >= 2);
  assert.ok(!existsSync(join(config.pi.agentDir, "fake-launches.jsonl")), "nothing was launched");

  // A record that parses to nothing is still a record.
  const shaped = { runId: "20260101T000000-deadbeef", conversationId: 1, taskId: 1, pr: false, startedAt: "", asOf: 0, groups: [],
    workspace: join(config.runsDir, "20260101T000000-deadbeef"), logDir: join(config.dataDir, "logs/runs/20260101T000000-deadbeef") };
  for (const damaged of ["null", "0", '""', "[]", JSON.stringify({ ...shaped, procs: [null] }), JSON.stringify({ ...shaped, procs: [], groups: ["x"] })]) {
    await writeFile(stateFile, damaged);
    await assert.rejects((await openPiRuns(config)).run(request({ pr: false })), /does not describe a run of this data directory/, damaged);
  }

  // Removed by hand, the slot opens again.
  await rm(stateFile);
  assert.equal((await (await openPiRuns(config)).run(request({ pr: false }))).status, "completed");
});

test("nothing is launched without a saved record, and a record that cannot be removed keeps the slot closed", async t => {
  const config = await setup(t);
  await scenario(config, [assistant(report({ pr: null, issue: null })), settled]);
  t.mock.method(console, "error", () => {});
  const runs = await openPiRuns(config);
  // The record cannot be written: a directory is in its place.
  const stateFile = join(config.dataDir, "pi-run.json");
  await mkdir(join(stateFile, "blocker"), { recursive: true });
  const outcome = await runs.run(request({ pr: false }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.problems.join("\n"), /The run failed in the host/);
  assert.ok(!existsSync(join(config.pi.agentDir, "fake-launches.jsonl")), "nothing was launched");
  assert.deepEqual(await readdir(config.runsDir), []);
  // The settled outcome is still returned and kept by call, and the slot stays closed until someone looks.
  assert.match(outcome.problems.join("\n"), /The run's record could not be closed/);
  assert.deepEqual(await runs.settled(101), outcome);
  await assert.rejects(runs.run(request({ pr: false })), /could not be cleaned up[^]*No new run starts until that is resolved/);
});

test("a process scan cannot prune groups added or changed while it was in flight", async () => {
  const changed = Number.MAX_SAFE_INTEGER;
  const added = changed - 1;
  const future = added - 1;
  const now = Date.now();
  const owned = newOwned([], [[changed, now - 2_000], [future, now + 60_000]]);
  // The future cutoff triggers a write mid-scan. Simulate a concurrent updater during that pause.
  await trackRunProcesses(owned, "no-such-run", async () => {
    owned.groups.set(changed, now - 1_000);
    owned.groups.set(added, null);
  });
  assert.deepEqual([...owned.groups], [[changed, now - 1_000], [added, null]]);
  await trackRunProcesses(owned, "no-such-run");
  assert.deepEqual([...owned.groups], [], "a later scan can forget the empty groups");
});

test("a run's processes are found by environment marker and by the groups they led, not by their arguments", { timeout: 30_000 }, async t => {
  const marker = `test-${process.pid}-${Date.now()}`;
  const idle = "setTimeout(() => {}, 600000)";
  const started: number[] = [];
  t.after(() => { for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL"); });
  const start = (args: string[], env: NodeJS.ProcessEnv = {}, detached = false) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"], detached });
    started.push(child.pid!);
    return child;
  };
  const marked = start(["-e", idle], { PATTY_RUN_ID: marker }, true);
  // The marker among the arguments, as a search for it would have.
  const bystander = start(["-e", idle, `PATTY_RUN_ID=${marker}`]);
  // A detached leader, as a delegate is, whose child stays in its group after the leader is gone.
  const leader = start(["-e", `
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(idle)}], { stdio: "ignore", env: {} });
    console.log(child.pid);
    ${idle}`], {}, true);
  const orphan = Number(await new Promise<string>(resolve => leader.stdout!.once("data", chunk => resolve(String(chunk)))));
  started.push(orphan);

  const owned = newOwned();
  const table = await until(async () => {
    const procs = await listProcesses();
    return [marked.pid, bystander.pid, leader.pid, orphan].every(pid => procs.some(proc => proc.pid === pid)) ? procs : undefined;
  });
  // The group is remembered from any of its members, so it need not be the leader that was seen.
  const orphanProc = table!.find(proc => proc.pid === orphan)!;
  const nextSecond = Date.parse(orphanProc.start) + 1_000;
  await until(() => Date.now() >= nextSecond);
  remember(owned, [orphanProc], Date.now());
  assert.deepEqual([...owned.groups.keys()], [leader.pid]);
  owned.procs.clear();
  leader.kill("SIGKILL");
  await until(() => !alive(leader.pid!));

  const found = (await runProcesses(owned, marker)).map(proc => proc.pid);
  assert.ok(found.includes(marked.pid!), "found by its environment");
  assert.ok(found.includes(orphan), "found by the group its dead leader led");
  assert.ok(!found.includes(bystander.pid!), "the marker in an argument is not ownership");
  assert.ok(!found.includes(process.pid));

  // A member that started after the run last saw the group may be a late child of the run's, or a stranger in a
  // group whose ID was reused: it is not killed, and it is not passed over as if the run were gone.
  const staleTime = nextSecond - 60_000;
  const stale = newOwned([], [[leader.pid!, staleTime]]);
  assert.equal(await trackRunProcesses(stale, "another-run"), false, "an empty poll provides no evidence");
  assert.equal(await trackRunProcesses(stale, marker), true, "the marked process is tracked in its own group");
  await trackRunProcesses(stale, marker);
  assert.equal(stale.groups.get(leader.pid!), staleTime, "polls of another group do not advance this group's cutoff");
  assert.deepEqual((await runProcesses(stale, marker)).map(proc => proc.pid), [marked.pid]);
  assert.deepEqual((await stopRun(stale, marker, undefined, 0)).map(proc => proc.pid), [orphan]);
  assert.ok(!alive(marked.pid!) && alive(orphan));

  const sameSecond = newOwned([], [[leader.pid!, nextSecond - 1]]);
  assert.deepEqual(await runProcesses(sameSecond, "another-run"), [], "a whole-second start time is ambiguous within that second");

  // The old poller could have used the recent run-wide cutoff to record processes without evidence of ownership.
  // Retain them as blockers (even outside the remembered group), including on a subsequent restart.
  const config = await setup(t);
  t.mock.method(console, "error", () => {});
  const runId = "20260101T000000-deadbeef";
  const stateFile = join(config.dataDir, "pi-run.json");
  const workspace = join(config.runsDir, runId);
  const logDir = join(config.dataDir, "logs/runs", runId);
  await mkdir(workspace, { recursive: true });
  await mkdir(logDir, { recursive: true });
  const record = { runId, workspace, logDir, conversationId: 1, taskId: 101, startedAt: "", pr: false };
  const legacyProcs = table!.filter(proc => proc.pid === orphan || proc.pid === bystander.pid).map(proc => [proc.pid, proc.start]);
  await writeFile(stateFile, JSON.stringify({ ...record, procs: legacyProcs, groups: [leader.pid], asOf: Date.now() }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovered = await openPiRuns(config);
    await assert.rejects(recovered.run(request({ pr: false })), /2 process\(es\) could not be stopped, or could not be told from the run's/);
    assert.ok(alive(orphan) && alive(bystander.pid!) && existsSync(workspace));
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(saved.groups, [[leader.pid, null]]);
    assert.deepEqual(saved.unverifiedProcs, legacyProcs);
    assert.deepEqual(saved.procs, []);
    assert.ok(!("asOf" in saved));
  }

  const withClock = async <T>(times: number[], run: (reads: () => number) => Promise<T>): Promise<T> => {
    let readings = 0;
    const clock = t.mock.method(Date, "now", () => times[Math.min(readings++, times.length - 1)]);
    try {
      return await run(() => readings);
    } finally {
      clock.mock.restore();
    }
  };
  const cutoff = Date.now() + 1_000;
  const catchingUp = newOwned([], [[leader.pid!, cutoff]]);
  let savedCutoff = false;
  assert.equal(await withClock([cutoff - 1, cutoff + 1], reads => trackRunProcesses(catchingUp, "another-run", async () => {
    assert.equal(reads(), 1, "persist before waiting for the process snapshot");
    assert.equal(catchingUp.groups.get(leader.pid!), null);
    savedCutoff = true;
  })), true);
  assert.ok(savedCutoff);
  assert.equal(catchingUp.groups.get(leader.pid!), null, "a future cutoff at poll entry stays invalid after the scan");
  assert.equal(catchingUp.procs.size, 0, "the cutoff did not confer ownership");

  const futureRecord = JSON.stringify({ ...record, procs: [], groups: [[leader.pid, cutoff]] });
  const eventsFile = join(logDir, "events.jsonl");
  // Recovery takes another clock reading when replaying the tool start. The bad timestamp must stay invalid
  // even after the clock catches up during replay, before the first process scan.
  await writeFile(eventsFile, JSON.stringify(delegate("c1", { id: "replay", profile: "crmanager", task: "Review.", cost: 0 })[0].emit) + "\n");
  for (const times of [[cutoff - 1, cutoff + 1], [cutoff + 1, cutoff - 1, cutoff + 1]]) {
    await writeFile(stateFile, futureRecord);
    const recovered = await withClock(times, () => openPiRuns(config));
    await assert.rejects(recovered.run(request({ pr: false })), /1 process\(es\) could not be stopped, or could not be told from the run's/);
    assert.ok(alive(orphan) && existsSync(workspace));
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).groups, [[leader.pid, null]]);
  }

  // If the clock steps back after load and the transcript can't be read, the stop scan must still save the
  // invalidation, even when no owned process is found and recovery exits without finalizing the record.
  await rm(eventsFile);
  await mkdir(eventsFile);
  await writeFile(stateFile, futureRecord);
  const unreadable = await withClock([cutoff + 1, cutoff + 1, cutoff - 1], () => openPiRuns(config));
  await assert.rejects(unreadable.run(request({ pr: false })), /events could not be read/);
  assert.ok(alive(orphan) && existsSync(workspace));
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).groups, [[leader.pid, null]]);

  // Even when the initial correction cannot be written, recovery stops independently verified processes and
  // leaves the ambiguous process, workspace and run slot alone.
  await rm(eventsFile, { recursive: true });
  const verified = start(["-e", idle], {}, true);
  const verifiedProc = await until(async () => (await listProcesses()).find(proc => proc.pid === verified.pid));
  await writeFile(stateFile, JSON.stringify({ ...record, procs: [[verified.pid, verifiedProc!.start]], groups: [[leader.pid, cutoff]] }));
  const rename = fs.rename;
  const renameMock = t.mock.method(fs, "rename", async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (to === stateFile) throw new Error("test state update failure");
    await rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const writeFailed = await withClock([cutoff - 1, cutoff + 1], () => openPiRuns(config));
    await assert.rejects(writeFailed.run(request({ pr: false })), /the process record could not be saved: test state update failure/);
    assert.ok(!alive(verified.pid!) && alive(orphan) && existsSync(workspace));
    assert.ok(!(await readdir(config.dataDir)).some(name => name.startsWith("pi-run.json.") && name.endsWith(".tmp")));
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
  }

  // A stop saves what it learns of the tree before it signals anything.
  const learning = newOwned();
  let recorded: number[] = [];
  await stopRun(learning, "no-such-run", undefined, 0, undefined, async () => { recorded = [...learning.procs.keys()]; });
  assert.deepEqual(recorded, []);
  const fresh = start(["-e", idle], { PATTY_RUN_ID: `${marker}-b` }, true);
  await until(async () => (await listProcesses()).some(proc => proc.pid === fresh.pid));
  const rolledBack = newOwned([], [[fresh.pid!, cutoff]]);
  assert.equal(await withClock([cutoff, cutoff - 1], () => trackRunProcesses(rolledBack, `${marker}-b`)), true);
  assert.ok(rolledBack.procs.has(fresh.pid!), "keep the confirmed identity from the poll");
  assert.equal(rolledBack.groups.get(fresh.pid!), null, "do not restore a future cutoff after a rollback");
  const records: { groups: number[]; alive: boolean }[] = [];
  assert.deepEqual(await stopRun(learning, `${marker}-b`, undefined, 0, undefined, async () => {
    records.push({ groups: [...learning.groups.keys()], alive: alive(fresh.pid!) });
  }), []);
  assert.deepEqual(records[0], { groups: [fresh.pid], alive: true });
  assert.deepEqual(records.at(-1)?.groups, [], "the forgotten group is also persisted");

  const detached = start(["-e", idle], {}, true);
  const detachedProc = await until(async () => (await listProcesses()).find(proc => proc.pid === detached.pid));
  const known = newOwned([[detached.pid!, detachedProc!.start]]);
  let writes = 0;
  await assert.rejects(stopRun(known, "no-such-run", undefined, 0, undefined, async () => {
    writes++;
    throw new Error("test write failure");
  }), /the process record could not be saved: test write failure/);
  assert.ok(writes > 1, "retry the failed record");
  assert.ok(!alive(detached.pid!), "record failure still allows confirmed processes to be stopped");

  const path = process.env.PATH;
  try {
    process.env.PATH = join(config.dataDir, "without-ps");
    const writeFailure = new Error("test pending write failure");
    await assert.rejects(stopRun(newOwned(), "no-such-run", undefined, 0, undefined, async () => {
      throw writeFailure;
    }, () => true), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].code, "ENOENT");
      assert.equal(error.errors[1], writeFailure);
      return true;
    });
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }

  assert.deepEqual(await stopRun(owned, marker, undefined, 0), []);
  await until(() => !alive(marked.pid!) && !alive(orphan));
  assert.ok(alive(bystander.pid!));
  // A group with no member left is forgotten, so its ID cannot be matched later.
  await runProcesses(owned, marker);
  assert.deepEqual([...owned.groups], []);
});
