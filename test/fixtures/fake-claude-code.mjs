// Executed by the test's disposable CLI shim. No network, credentials, or sessions.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const status = args[0] === "auth" && args[1] === "status";
const write = value => process.stdout.write(JSON.stringify(value) + "\n");
appendFileSync(process.env.FIXTURE_CLAUDE_CALLS, JSON.stringify(status ? ["status"] : ["stream", model, args]) + "\n");
if (status) {
  write(process.env.FIXTURE_CLAUDE_LOGGED_OUT ? { loggedIn: false } : { loggedIn: true, subscriptionType: "max" });
} else {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of reader) {
    const frame = JSON.parse(line);
    if (model === "default" && frame.type === "control_request") {
      write({ type: "control_response", response: { request_id: frame.request_id, subtype: "success", response: { models: [
        { value: "fixture-route", resolvedModel: "fixture-discovered[1m]", displayName: "Fixture", description: "fixture model" },
      ] } } });
    } else if (model === "default" && frame.type === "user" && frame.shouldQuery === false) {
      // Discovery never queries the model. End stdout so Pi can finish reading before it waits for exit.
      process.stdout.end();
      await new Promise(resolve => setTimeout(resolve, 100));
      break;
    } else if (model === "fixture-route" && frame.type === "user" && frame.shouldQuery !== false) {
      const usage = { input_tokens: 2, output_tokens: 3 };
      write({ type: "assistant", message: { id: "stub", content: [{ type: "text", text: "Claude Code stub replied" }], stop_reason: "end_turn", usage } });
      write({ type: "stream_event", event: { type: "message_stop" } });
      write({ type: "result", subtype: "success", usage });
    } else {
      throw new Error(`Unexpected stub request for ${model}: ${line}`);
    }
  }
}
