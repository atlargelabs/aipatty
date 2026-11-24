import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractContent } from "../../src/extensions/web-fetch-runtime.ts";

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
  pi.registerProvider("fixture-search", {
    baseUrl: process.env.FIXTURE_SEARCH_URL!, api: "openai-responses", apiKey: "fixture-key",
    models: [{ id: "search-model", name: "Loopback search fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    pi.events.emit("web-fetch:register", {
      name: "unexpected-bus-hook", matches: ["**"],
      beforeFetch() { writeFileSync(process.env.FIXTURE_MARKER!, "bus hook ran"); },
    });
    const extraction = process.env.FIXTURE_CHECK_EXTRACTOR ? await extractContent("<p>fixture HTML</p>\n") : undefined;
    writeFileSync(process.env.FIXTURE_TOOLS!, JSON.stringify({
      all: pi.getAllTools().map(tool => tool.name), active: pi.getActiveTools(), prompt: ctx.getSystemPrompt(), extraction,
    }));
  });
}
