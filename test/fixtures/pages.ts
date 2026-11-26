import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import type { AgentHost } from "../../src/host.ts";
import { publishPageTool, readPageDetails } from "../../src/pages/shared.ts";
import { messageText } from "../../src/protocol.ts";

/** Exercise actual model declaration, execution and saved results, not a direct store publish. */
export function fauxPages() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let next = 0;
  async function turn(host: AgentHost, branch: string, call?: ReturnType<typeof fauxToolCall>) {
    let tools: Tool[] | undefined;
    const reply = fauxAssistantMessage("Faux Pages turn finished.");
    faux.setResponses([request => {
      tools = getCurrentTools(request.messages);
      return call ? fauxAssistantMessage(call, { stopReason: "toolUse" }) : reply;
    }, ...(call ? [reply] : [])]);
    const conversation = (await host.conversation(branch))!;
    assert.equal((await (await host.submit(conversation, { type: "input", content: "Pages fixture" })).wait(ctx)).status, "done");
    assert.ok(tools);
    const result = call && (await conversation.entries({}, 10, undefined, ctx)).items.flatMap(entry => entry.model ?? [])
      .find(message => message.role === "toolResult" && message.toolCallId === call.id);
    return { tools, result };
  }
  const runPublish = (host: AgentHost, branch: string, args: Parameters<typeof fauxToolCall>[1]) =>
    turn(host, branch, fauxToolCall(publishPageTool, args, { id: `publish-fixture-${++next}` }));
  async function publish(host: AgentHost, branch: string, args: Parameters<typeof fauxToolCall>[1]) {
    const { tools, result } = await runPublish(host, branch, args);
    const declaration = tools.find(tool => tool.name === publishPageTool);
    assert.match(declaration?.description ?? "", /standalone HTML.*immutable.*sandboxed/);
    assert.ok(result?.role === "toolResult" && !result.isError, result && messageText(result));
    assert.equal(result.toolName, publishPageTool);
    const page = readPageDetails(result.details);
    assert.ok(page);
    return { page, text: messageText(result) };
  }
  return { models, turn, runPublish, publish };
}

/** A different loopback origin with a public, synthetic API. It accepts only sandboxed CORS requests. */
export async function pagesBrowserFixture(t: TestContext, branch: number) {
  const requests: string[] = [];
  const reports: unknown[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    requests.push(url.pathname);
    if (url.pathname.endsWith(".svg")) {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
    } else if (req.headers.origin === "null" && (url.pathname === "/cors" || url.pathname === "/checked")) {
      if (url.pathname === "/checked") reports.push(JSON.parse(url.searchParams.get("report")!));
      res.writeHead(200, { "Access-Control-Allow-Origin": "null", "Content-Type": "text/plain" });
      res.end("Fixture data");
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const external = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const archive = `/api/conversations/${branch}/archive`;
  const html = (variant: "static" | "interactive") => `<!doctype html>
    <h1>Published ${variant} fixture</h1>
    <img src="${external}/${variant}-render.svg" alt="">
    <img id="api-image" src="/api/branches" alt="">
    <form method="post" action="${archive}"><button id="probe-form">Check form sandbox</button></form>
    <script>
      // Image loads are permitted in both modes; this would be visible even if fetch were blocked by CSP.
      const marker = document.createElement('img');
      marker.src = '${external}/${variant}-script.svg';
      document.body.append(marker);
      const denied = read => { try { read(); return false; } catch { return true; } };
      (async () => {
        const embedded = parent !== self;
        const report = {
          origin: self.origin, embedded,
          parentBlocked: embedded ? denied(() => parent.document) : null,
          cookiesBlocked: denied(() => document.cookie),
          workerBlocked: denied(() => navigator.serviceWorker) || !navigator.serviceWorker,
          apiBlocked: await fetch('/api/branches').then(() => false, () => true),
          noCorsReadBlocked: await fetch('/api/branches', { mode: 'no-cors' })
            .then(async response => response.type === 'opaque' && response.status === 0 && (await response.text()) === '', () => true),
          wsBlocked: await new Promise(resolve => {
            const ws = new WebSocket('ws://' + location.host + '/api/conversations/root/stream');
            ws.onerror = () => resolve(true);
            ws.onopen = () => { ws.close(); resolve(false); };
          }),
        };
        // A bodyless POST would archive only the empty throwaway branch of this Faux instance, if allowed.
        await fetch('${archive}', { method: 'POST', mode: 'no-cors' }).catch(() => {});
        report.external = await fetch('${external}/cors').then(response => response.text());
        await fetch('${external}/checked?report=' + encodeURIComponent(JSON.stringify(report)));
      })();
    </script>`;
  return { requests, reports, html };
}
