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
    description: "Run one Pi session on a bounded coding or research task and wait for its result.\n\n"
      + "For research or coding without a PR, set `pr: false`. Pi can investigate, prototype, debug, or run tests without publishing anything. "
      + "It uses a disposable checkout of `atlargelabs/aipatty` by default; set `clone: false` if the task doesn’t need the repository. "
      + "For research, Pi can use `web_search` and `web_fetch` where configured, run independent delegates in parallel, or convene a "
      + "`thinktank` delegate to compare perspectives. The workspace is deleted after the run, so ask for any code or small patch you want to keep in the report.\n\n"
      + "For changes that should become a PR, use `pr: true` (the default). Pi works in a fresh clone of `atlargelabs/aipatty`, "
      + "opens an issue, a task branch, and a PR, runs the checks, and has a `crmanager` delegate review the final commit. Only Steve merges. "
      + "The result reports the PR and head commit as confirmed by GitHub and whether the last review covered that commit. "
      + "A result that says `NOT REVIEWED` or lists problems is not finished work.\n\n"
      + "Only one Pi run can be active per conversation branch at a time, including cleanup. Once cleanup completes, you can run Pi again "
      + "on the same branch. Other branches can run independently. Each run starts fresh and sees neither this conversation nor previous runs, "
      + "so include the goal, relevant context, and what done means in `task`. The run’s cost is charged to the calling branch.",
    parameters: obj({
      task: str({ minLength: 1, maxLength: 60_000, description: "The complete task and its context" }),
      pr: opt(bool({ description: "True (default) requires a reviewed PR. False allows research or scratch coding and returns a report; publish nothing." })),
      clone: opt(bool({ description: "True (default) checks out atlargelabs/aipatty. False starts in a disposable scratch workspace; requires pr: false and no base." })),
      base: opt(str({ minLength: 1, maxLength: 200, description: "Branch, tag or commit to check out when cloning; default main. Omit with clone: false." })),
      model: opt(str({ minLength: 1, maxLength: 200, description: `Pi's model as provider/id; default ${defaultModel}. Use claude-code/<model-id> only when explicitly requested.` })),
      thinking: opt(str({ description: "Thinking level: off, minimal, low, medium, high, xhigh or max; default high" })),
      timeoutMinutes: opt(int({ minimum: 1, maximum: maxMinutes, description: `Stop the run after this long; default ${defaultMinutes}` })),
    }),
    // Not from a codemode script: a run is one call of the model's, whose result and cost the branch records.
    callers: ["model"],
    // The harness's own bound comes after the tool has clipped the summary and the lists.
    outputLimits: { maxBytes: 24_000, maxLines: 400, retain: "head" },
    async execute(args, api, context) {
      const model = args.model ?? defaultModel;
      if (!/^[\w][\w./:-]*$/.test(model)) throw new Error(`Not a model reference: ${model}`);
      const thinking = args.thinking ?? "high";
      if (!thinkingLevels.some(level => level === thinking)) throw new Error(`Expected a thinking level: ${thinkingLevels.join(", ")}`);
      return result(await getRuns().run({
        conversationId: api.conversationId, taskId: api.taskId, task: args.task, pr: args.pr ?? true, clone: args.clone, base: args.base, model, thinking,
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
      try {
        const outcome = await getRuns().settled(api.taskId, api.conversationId);
        return outcome ? result(outcome) : undefined;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ...written, isError: true, output: [...(written.output ?? []), { type: "text", text: `Pi outcome recovery failed: ${reason}` }] };
      }
    },
  });

  return defineExtension({ name: "aipatty-pi", tools: [pi], hooks: [afterPi] });
}
