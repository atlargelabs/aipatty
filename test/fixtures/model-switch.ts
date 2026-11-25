import { awaitWithContext } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { int, obj } from "@earendil-works/pi-schema";
import { openHost } from "../../src/host.ts";
import { fauxConfig } from "../helpers.ts";

export const oldModel = { provider: "faux", modelId: "faux-1" };
export const nextModel = { provider: "faux", modelId: "faux-next" };
export const otherModel = { provider: "faux", modelId: "faux-other" };

/** Real Durable tool tasks and provider calls, held at explicit barriers with no subprocess or network access. */
export function modelSwitchFixture(dir: string, count = 1) {
  const faux = fauxProvider({ models: [oldModel, nextModel, otherModel].map(({ modelId: id }) => ({ id })) });
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = Array.from({ length: count }, (_, i) => ({
    started: Promise.withResolvers<void>(), done: Promise.withResolvers<void>(), result: `tool ${i} completed`,
  }));
  const extension = defineExtension({ name: "test-controlled-tools", tools: [defineTool({
    name: "hold_tool", description: "Hold for the test to release", parameters: obj({ index: int({}) }), replay: "safe",
    async execute({ index }, _api, context) {
      const tool = tools[index];
      tool.started.resolve();
      await awaitWithContext(tool.done.promise, context);
      return { output: [{ type: "text", text: tool.result }] };
    },
  })] });
  const open = (...extensions: Extension[]) => openHost(fauxConfig(dir), {
    models, extensions: [extension, ...extensions],
  });
  const start = async (host: Awaited<ReturnType<typeof open>>) => {
    faux.appendResponses([fauxAssistantMessage(tools.map((_, index) => fauxToolCall("hold_tool", { index })), { stopReason: "toolUse" })]);
    const root = (await host.conversation("root"))!;
    const submission = await host.submit(root, { type: "input", content: "Run the tools" });
    await Promise.all(tools.map(tool => tool.started.promise));
    return { root, submission };
  };
  return { faux, models, tools, open, start };
}
