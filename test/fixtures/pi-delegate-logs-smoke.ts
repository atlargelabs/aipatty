import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as message, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai";

const model = "fixture/coding";
const candidate = { profile: "prmanager", name: "Candidate", task: "first candidate attempt" };

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "coding" }] });
  pi.registerProvider(faux.provider);
  const task = process.argv.at(-1) ?? "";
  if (!process.env.PI_DELEGATE_BOOTSTRAP) {
    faux.setResponses([
      message(call("delegate", candidate)),
      ({ messages }) => {
        const result = messages.findLast(entry => entry.role === "toolResult");
        const text = result?.content.find(item => item.type === "text")?.text;
        const job = JSON.parse(text ?? "null");
        return message(call("delegate", { ...candidate, task: "continued candidate attempt", continue: job.id }));
      },
      message(call("delegate", { profile: "crmanager", name: "Review", task: "/review commit HEAD" })),
      message('<result>\n{"summary":"Offline delegates finished.","issue":null,"pr":null,"remaining":[]}\n</result>'),
    ]);
  } else if (task.includes("first candidate attempt")) {
    faux.setResponses([
      message(call("delegate_parallel", { tasks: ["One", "Two"].map(name => ({ profile: "thinker", name, task: "Research locally" })) })),
      message(call("delegate_verify", {})),
      message("Verified candidate."),
    ]);
  } else if (task === "/delegates-review") {
    faux.setResponses([({ messages }) => {
      if (!JSON.stringify(messages).includes("Delegated scope: Commit")) throw new Error("Missing pinned review prompt");
      return message("Overall verdict: correct");
    }]);
  } else {
    faux.setResponses([message(task.includes("continued candidate attempt") ? "Continued candidate." : "Research result.")]);
  }
}
