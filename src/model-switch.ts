import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure, defineDoc, defineExtension, GenerationTask, hook, LiveDoc,
  type ConversationId, type GenerationCheckpoint, type Harness, type ModelRef, type Tx,
} from "@earendil-works/pi-durable";

export type ModelSelection = { model: ModelRef; thinkingLevel?: ModelThinkingLevel };

// Durable gives each tool round its own generation task. Its documents survive reopen, never fork, and
// are retired automatically if the generation ends without reaching afterTools (e.g. an explicit abort).
export const PendingModelDoc = defineDoc<{ selection?: ModelSelection }>({
  kind: "aipatty.pending-model", version: 1, scope: "task", initial: () => ({}), checkpointWhen: () => true,
});

async function toolRound(tx: Tx, conversationId: ConversationId) {
  const { run, tools } = await tx.doc(LiveDoc, conversationId);
  if (!run || !tools?.length) return;
  const task = await tx.task(run.taskId);
  if (!task || task.kind !== GenerationTask.definition.name || task.abortRequested) return;
  const checkpoint = task.state.checkpoint as GenerationCheckpoint | undefined;
  if (checkpoint?.phase === "tools") return { taskId: run.taskId, checkpoint };
}

/** Use the task states, not lingering tool slots: afterTools may already be running once the last task settles. */
export async function queueModel(tx: Tx, conversationId: ConversationId, selection: ModelSelection): Promise<boolean> {
  const round = await toolRound(tx, conversationId);
  if (!round) return false;
  let waiting = round.checkpoint.pending.length > 0; // Sequential calls not yet started.
  for (const id of round.checkpoint.tools) {
    if (waiting) break;
    const tool = await tx.task(id);
    waiting = tool !== undefined && tool.state.status !== "terminal";
  }
  if (!waiting) return false;
  (await tx.doc(PendingModelDoc, round.taskId)).selection = selection;
  return true;
}

/** A later explicit thinking setting takes precedence over any thinking level bundled with an older selection. */
export async function configureThinking(tx: Tx, conversationId: ConversationId, thinkingLevel: ModelThinkingLevel) {
  const round = await toolRound(tx, conversationId);
  if (round) {
    const { selection } = await tx.doc(PendingModelDoc, round.taskId);
    if (selection) delete selection.thinkingLevel;
  }
  await configure(tx, conversationId, { thinkingLevel });
}

export function modelSwitchExtension(harness: () => Harness) {
  return defineExtension({
    name: "aipatty-model-switch",
    hooks: [hook(GenerationTask, {
      async afterTools(assistant, _results, api, context) {
        if (!(await api.snapshot(PendingModelDoc, api.taskId, context))?.selection) return;
        // Off the host admission lines: abort can be waiting there for this generation to exit.
        // Durable awaits this commit before handing over to the generation that prepares the next request.
        const unavailable = await harness().commit(async tx => {
          const round = await toolRound(tx, api.conversationId);
          if (round?.taskId !== api.taskId || round.checkpoint.assistant !== assistant) return;
          const pending = await tx.doc(PendingModelDoc, api.taskId);
          const selection = pending.selection;
          if (!selection) return;
          const { provider, modelId } = selection.model;
          delete pending.selection;
          if (!api.models.getModel(provider, modelId)) return `${provider}/${modelId}`;
          await configure(tx, api.conversationId, selection);
        }, context);
        if (unavailable) console.warn(`Dropped queued model ${unavailable} for branch ${api.conversationId}: unavailable in the local catalog`);
        return undefined;
      },
    })],
  });
}
