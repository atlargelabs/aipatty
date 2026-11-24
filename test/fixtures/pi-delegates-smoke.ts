import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const stub = fauxProvider({ provider: "fixture", models: [{ id: "coding" }] });
  stub.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf managed-shell" })]),
    fauxAssistantMessage([fauxToolCall("delegate_parallel", { tasks: [
      { profile: "worker", name: "fixture worker", task: "Inspect the fixture.", model: "fixture-child/reply" },
      { profile: "crmanager", name: "fixture review", task: "/review commit HEAD\nInspect the fixture.", model: "fixture-child/reply" },
    ] })]),
    fauxAssistantMessage("fixture parent done"),
  ]);
  pi.registerProvider(stub.provider);
}
