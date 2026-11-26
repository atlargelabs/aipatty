import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as message, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "coding" }] });
  pi.registerProvider(faux.provider);
  const task = process.argv.at(-1) ?? "";
  if (!process.env.PI_DELEGATE_BOOTSTRAP) {
    faux.setResponses([
      () => {
        const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
        assert.deepEqual(readdirSync("."), [".git"]);
        assert.equal(statSync(".").mode & 0o777, 0o700);
        assert.equal(git("rev-parse", "--show-toplevel"), process.cwd());
        assert.equal(git("for-each-ref"), "");
        assert.equal(git("remote"), "");
        for (const name of ["web_search", "web_fetch", "delegate", "delegate_parallel"]) {
          assert.ok(pi.getAllTools().some(tool => tool.name === name), name);
        }
        return message(call("delegate", { profile: "worker", name: "Prototype", task: "Write scratch file" }));
      },
      message(call("delegate", { profile: "thinktank", name: "Research", task: "Gather perspectives" })),
      message('<result>\n{"summary":"Offline scratch run finished.","issue":null,"pr":null,"remaining":[]}\n</result>'),
    ]);
  } else if (task.includes("Write scratch file")) {
    faux.setResponses([message(call("write", { path: "prototype.txt", content: "Scratch prototype" })), message("Wrote the prototype.")]);
  } else if (task.includes("Gather perspectives")) {
    faux.setResponses([
      message(call("delegate_parallel", { tasks: ["One", "Two"].map(name => ({ profile: "thinker", name, task: "Read the prototype" })) })),
      message("Synthesized perspectives."),
    ]);
  } else {
    faux.setResponses([message(call("read", { path: "prototype.txt" })), ({ messages }) => {
      assert.match(JSON.stringify(messages.findLast(entry => entry.role === "toolResult")), /Scratch prototype/);
      return message("Read the prototype.");
    }]);
  }
}
