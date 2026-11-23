import { defineExtension, defineTool, hook, ToolTask, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { thinkingLevels } from "./branches.ts";
import { outcomeText, type PiRuns, type RunOutcome } from "./pi-run.ts";

const defaultModel = "openai/gpt-6.2-sol";
const defaultMinutes = 60;
const maxMinutes = 180;

function result(outcome: RunOutcome): ToolExecutionResult {
  return {
    output: [{ type: "text", text: outcomeText(outcome) }],
    details: outcome as unknown as JsonValue,
    // Pi's spend, its delegates' included, charged to the calling branch once.
    usage: outcome.usage,
    isError: outcome.status !== "completed",
  };
}

/** The `pi` tool, and the result of a call that was aborted or cut off by a restart. */
export function piExtension(getRuns: () => PiRuns) {
  const pi = defineTool({
    name: "pi",
    description: "Run one Pi coding session on a bounded task in a fresh clone of atlargelabs/aipatty, aipatty's own repository, and wait "
      + "for its result. Use it for every change that should become a PR: Pi opens an issue, a task branch and a PR, runs the "
      + "checks, and has a crmanager delegate review the final commit. Only Steve merges. One run at a time across all "
      + "branches; a second call is refused. Every run starts fresh and sees nothing of this conversation or of earlier "
      + "runs, so put all the context it needs in `task`: the goal, the relevant decisions, and what done means. "
      + "The result reports the PR and its head commit as confirmed with GitHub, and whether the last review covered "
      + "that commit; a result that says NOT REVIEWED or lists problems is not finished work. The run's cost is charged to this branch.",
    parameters: obj({
      task: str({ minLength: 1, maxLength: 60_000, description: "The complete task and its context" }),
      pr: opt(bool({ description: "Whether the run must end with a reviewed PR; default true. False investigates and reports, publishing nothing" })),
      base: opt(str({ minLength: 1, maxLength: 200, description: "Branch, tag or commit to start from; default main" })),
      model: opt(str({ minLength: 1, maxLength: 200, description: `Pi's model as provider/id; default ${defaultModel}. Use claude-code/<model-id> only when explicitly requested.` })),
      thinking: opt(str({ description: "Thinking level: off, minimal, low, medium, high, xhigh or max; default high" })),
      timeoutMinutes: opt(int({ minimum: 1, maximum: maxMinutes, description: `Stop the run after this long; default ${defaultMinutes}` })),
    }),
    // Not from a codemode script: a run is one call of the model's, whose result and cost the branch records.
    callers: ["model"],
    // The harness's own bound comes after the tool has clipped the summary and the lists.
    outputLimits: { maxBytes: 24_000, maxLines: 400, retain: "head" },
    async execute(args, api, context) {
      const base = args.base ?? "main";
      if (!/^[\w][\w./-]*$/.test(base) || base.includes("..")) throw new Error(`Not a branch, tag or commit: ${base}`);
      const model = args.model ?? defaultModel;
      if (!/^[\w][\w./:-]*$/.test(model)) throw new Error(`Not a model reference: ${model}`);
      const thinking = args.thinking ?? "high";
      if (!thinkingLevels.some(level => level === thinking)) throw new Error(`Expected a thinking level: ${thinkingLevels.join(", ")}`);
      return result(await getRuns().run({
        conversationId: api.conversationId, taskId: api.taskId, task: args.task, pr: args.pr ?? true, base, model, thinking,
        timeoutMs: (args.timeoutMinutes ?? defaultMinutes) * 60_000,
      }, context.abortSignal, runId => {
        // Publish only after the slot admits this exact call. Progress is best effort; the final details are durable.
        void api.details({ runId }, context).catch(() => {});
      }));
    },
  });

  // The harness writes the result of a call it ended itself: aborted, or cut off by a restart. For `pi`, replace it
  // with the run's own outcome: what it had done when it was stopped, or, when the run had already settled and
  // only the commit of its result was cut off, the result itself. Either way its spend is charged here, once.
  const ended = new Set(["aborted", "interrupted", "restart_limit"]);
  const afterPi = hook(ToolTask, {
    async afterTool(call, written, api) {
      if (call.name !== "pi" || call.parent || !written.diagnostics?.some(diagnostic => ended.has(diagnostic.code ?? ""))) return undefined;
      const outcome = await getRuns().settled(api.taskId);
      return outcome ? result(outcome) : undefined;
    },
  });

  return defineExtension({ name: "aipatty-pi", tools: [pi], hooks: [afterPi] });
}
