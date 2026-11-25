/**
 * The steps every branch runs, in this order, before any that a branch adds. See ./cards.ts for what a step is.
 * The page loads this file as it is, so it may import types only, or the other modules in this directory.
 */
import type { PaneRef, Step } from "./cards.ts";
import { piRunId } from "./shared.ts";

/** The Pi run a `pi` call's progress or result names, if it names one. */
export function runIdOf(details: unknown): string | undefined {
  const runId = (details as { runId?: unknown } | null | undefined)?.runId;
  return typeof runId === "string" && piRunId.test(runId) ? runId : undefined;
}

/** The first line of a task, shortened, to tell one run's button from another's. */
function taskTitle(task: unknown): string {
  const line = typeof task === "string" ? task.trim().split("\n", 1)[0].trim() : "";
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

function openRun(pane: PaneRef & { title: string }) {
  return { buttons: [{ label: "Open Pi run" + (pane.title ? " · " + pane.title : ""), action: { type: "openPane", pane } } as const] };
}

/**
 * Adds "Open Pi run" to a `pi` call: on its live card while it runs, and on its result once that is saved. The
 * button opens the pane `{ type: "pi-run", title, ... }`, which names the run in one of two ways:
 *
 * - `runId` and `durationMs`, from a result. A result that names no run, such as a refused request, gets no button.
 * - `callId`, from a live card. The call may not have started its run yet, and its card will give way to a
 *   result, so the pane follows the call: it reads the run from the live state, and then from the result.
 */
export const piRunStep: Step = {
  name: "pi-run",
  card(precard) {
    const title = "call" in precard ? taskTitle(precard.call?.arguments.task) : "";
    if (precard.kind === "liveTool" && precard.slot.name === "pi") {
      return openRun({ type: "pi-run", title, callId: precard.slot.callId });
    }
    if (precard.kind === "toolResult" && precard.message.toolName === "pi") {
      const runId = runIdOf(precard.message.details);
      if (runId) return openRun({ type: "pi-run", title, runId, durationMs: precard.message.durationMs });
    }
  },
};

/** Render only saved conversation prose as Markdown. Live previews and tool cards stay literal. */
const markdownStep: Step = {
  name: "markdown",
  card(precard) {
    if (precard.kind === "prose" && (precard.message.role === "user" || precard.message.role === "assistant")) {
      return { format: "markdown" };
    }
  },
};

export const builtInSteps: Step[] = [piRunStep, markdownStep];
