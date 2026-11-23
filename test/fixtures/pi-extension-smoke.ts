import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const stub = fauxProvider({ provider: "fixture", models: [{ id: "coding" }] });
  stub.setResponses([
    fauxAssistantMessage([
      fauxToolCall("web_fetch", { pages: [{ url: "https://127.0.0.1/" }, { url: "https://93.184.215.14/" }] }),
      fauxToolCall("web_search", { query: "fixture search query" }),
    ]),
    fauxAssistantMessage("unrelated coding turn completed"),
  ]);
  pi.registerProvider(stub.provider);
  pi.on("before_agent_start", async (_event, ctx) => {
    pi.events.emit("web-fetch:register", {
      name: "unexpected-bus-hook", matches: ["**"],
      beforeFetch() { writeFileSync(process.env.FIXTURE_MARKER!, "bus hook ran"); },
    });
    writeFileSync(process.env.FIXTURE_TOOLS!, JSON.stringify({
      all: pi.getAllTools().map(tool => tool.name), active: pi.getActiveTools(), prompt: ctx.getSystemPrompt(),
    }));
  });
}
