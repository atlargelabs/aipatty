import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import type { Conversation, EntryId, InputSubmissionDraft, Submission, SubmissionId } from "@earendil-works/pi-durable";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { HostError, type AgentHost } from "./host.ts";
import { messageText, streamState, type StreamFrame } from "./protocol.ts";

const maxBody = 64 * 1024;
const defaultPage = 50;
const maxPage = 100;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError || error instanceof HostError) return { status: error.status, message: error.message };
  console.error("API error:", error);
  return { status: 500, message: "Internal server error" };
}

function trustedName(name: string): string {
  if (isIP(name) === 6) return new URL(`http://[${name}]`).hostname;
  if (!name || !/^[a-z0-9.-]+$/i.test(name)) {
    throw new Error(`Expected a trusted hostname or IP address without scheme or port: ${name}`);
  }
  return name.toLowerCase();
}

function requestUrl(req: IncomingMessage, trusted: readonly string[]): URL {
  const authority = req.headers.host?.toLowerCase();
  const port = req.socket.localPort;
  const name = trusted.find(n => authority === `${n}:${port}` || (port === 80 && authority === n));
  if (!name || req.headersDistinct.host?.length !== 1) throw new HttpError(403, "Untrusted Host");
  const origin = `http://${name}${port === 80 ? "" : `:${port}`}`;
  const origins = req.headersDistinct.origin;
  if (origins && (origins.length !== 1 || origins[0] !== origin)) {
    throw new HttpError(403, "Origin is not same-origin");
  }
  const target = req.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) throw new HttpError(400, "Invalid request target");
  return new URL(target, "http://localhost");
}

function positiveInt(value: string | null, field: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === null) return undefined;
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return number;
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers["content-length"]) > maxBody) throw new HttpError(413, "Request body too large");
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Expected an object");
  }
  return value as Record<string, unknown>;
}

async function messageDraft(req: IncomingMessage): Promise<InputSubmissionDraft> {
  const { content, requestId, whenBusy } = await jsonBody(req);
  if (typeof content !== "string" || !content.trim()) throw new HttpError(400, "Expected non-empty content");
  if (requestId !== undefined && (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256)) {
    throw new HttpError(400, "requestId must be a non-empty string of at most 256 characters");
  }
  if (whenBusy !== undefined && whenBusy !== "followUp" && whenBusy !== "steer") {
    throw new HttpError(400, 'whenBusy must be "followUp" or "steer"');
  }
  return { type: "input", content, requestId, whenBusy };
}

async function conversationPage(conversation: Conversation, params: URLSearchParams) {
  const limit = positiveInt(params.get("limit"), "limit", maxPage) ?? defaultPage;
  const before = positiveInt(params.get("before"), "before");
  const watch = await conversation.watch(ctx, { min: limit, max: limit });
  const { type: _type, live: _live, ...state } = streamState(watch.value);
  await watch.stop();
  if (before === undefined) return state;

  const { items } = await conversation.entries({ maxEntryId: (before - 1) as EntryId }, limit + 1, undefined, ctx);
  const entries = items.slice(0, limit).reverse();
  return { ...state, entries, before: items.length > limit ? entries[0].id : null };
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): void {
  if (req.method === method) return;
  res.setHeader("Allow", method);
  throw new HttpError(405, "Method not allowed");
}

async function handleHttp(agent: AgentHost, health: Health, req: IncomingMessage, res: ServerResponse, trusted: readonly string[]) {
  const { pathname, searchParams } = requestUrl(req, trusted);
  if (pathname === "/health") {
    requireMethod(req, res, "GET");
    sendJson(res, 200, { ...health, ...await agent.modelStatus() });
    return;
  }
  if (pathname === "/api/models") {
    requireMethod(req, res, "GET");
    sendJson(res, 200, { models: agent.models() });
    return;
  }
  if (pathname === "/api/model") {
    requireMethod(req, res, "PUT");
    const body = await jsonBody(req);
    const { modelId } = body;
    if (typeof modelId !== "string" || !modelId.trim()) throw new HttpError(400, "Expected modelId");
    let provider = body.provider;
    if (provider === undefined) {
      const matches = agent.models().filter(model => model.modelId === modelId);
      if (!matches.length) throw new HttpError(400, "Unknown modelId; list available models with 'aipatty models'");
      if (matches.length > 1) throw new HttpError(400, "Ambiguous modelId; specify provider");
      provider = matches[0].provider;
    }
    if (typeof provider !== "string" || !provider.trim()) throw new HttpError(400, "Expected provider");
    await agent.setModel({ provider, modelId });
    sendJson(res, 200, await agent.modelStatus());
    return;
  }
  const route = /^\/api\/conversations\/([^/]+)(?:\/(messages|abort))?$/.exec(pathname);
  if (!route) throw new HttpError(404, "Not found");
  const [, id, action] = route;
  requireMethod(req, res, action ? "POST" : "GET");
  const conversation = await agent.conversation(id);
  if (!conversation) throw new HttpError(404, "Conversation not found");

  if (action === "messages") {
    const submission = await agent.submit(conversation, await messageDraft(req));
    sendJson(res, 202, { submissionId: submission.id });
  } else if (action === "abort") {
    await agent.assertAvailable();
    await conversation.abort(ctx);
    sendJson(res, 200, { ok: true });
  } else {
    sendJson(res, 200, await conversationPage(conversation, searchParams));
  }
}

async function stream(socket: WebSocket, conversation: Conversation, submission?: Submission): Promise<void> {
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, ctx);
  socket.on("close", () => controller.abort());
  socket.on("error", () => socket.terminate());
  socket.on("message", () => socket.close(1008, "Stream is read-only"));
  const send = (value: StreamFrame) => new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.send(JSON.stringify(value), error => error ? reject(error) : resolve());
  });

  try {
    const watch = await conversation.watch(context, { min: defaultPage, max: defaultPage });
    // Send the attachment value first; the watch folds changes while a client is slow.
    const initial = send(streamState(watch.value));
    watch.start(async call => {
      if (call.kind === "value") await send(streamState(call.value));
    });
    void watch.closed.then(end => {
      if (!controller.signal.aborted) socket.close(end.kind === "ended" ? 1001 : 1011, "Stream ended");
    });
    await initial;
    if (!submission) return;

    const result = await submission.wait(context);
    if (result.status === "unanswered") {
      await send({ type: "settled", submissionId: result.id, status: "unanswered", reason: result.reason });
    } else if (result.type === "input") {
      const { items: [entry] } = await conversation.entries(
        { minEntryId: result.answer, maxEntryId: result.answer }, 1, undefined, context,
      );
      const answer = entry?.model?.[0];
      if (!answer || answer.role !== "assistant") throw new Error("Missing settled answer");
      await send({ type: "settled", submissionId: result.id, status: "done", answer: messageText(answer) });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error("Stream error:", error);
      socket.close(1011, "Stream failed");
    }
  }
}

async function handleUpgrade(
  agent: AgentHost, wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, trusted: readonly string[],
) {
  const { pathname, searchParams } = requestUrl(req, trusted);
  const route = /^\/api\/conversations\/([^/]+)\/stream$/.exec(pathname);
  if (!route) throw new HttpError(404, "Not found");
  const conversation = await agent.conversation(route[1]);
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const id = positiveInt(searchParams.get("submissionId"), "submissionId");
  let submission: Submission | undefined;
  if (id !== undefined) {
    await agent.assertAvailable();
    submission = await agent.harness.submission(id as SubmissionId, ctx);
    const status = await submission?.status(ctx);
    if (!status || status.conversationId !== conversation.id || status.type !== "input") {
      throw new HttpError(404, "Submission not found");
    }
  }
  if (!socket.destroyed) {
    wss.handleUpgrade(req, socket, head, ws => { void stream(ws, conversation, submission); });
  }
}

/** Process identity returned by /health. */
export interface Health {
  ok: true;
  commit: string;
  startedAt: string;
  version: string;
}

/** Serve the root (or any conversation ID) over HTTP and WebSocket. */
export async function startApi(agent: AgentHost, health: Health, host: string, port: number, aliases: readonly string[] = []) {
  const trusted = [host, ...aliases].map(trustedName);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void handleHttp(agent, health, req, res, trusted).catch(error => {
      if (res.destroyed) return;
      const { status, message } = errorResponse(error);
      if (!req.complete) res.shouldKeepAlive = false;
      sendJson(res, status, { error: message });
    });
  });
  const upgrading = new Set<Duplex>();
  server.on("upgrade", (req, socket, head) => {
    const onError = () => socket.destroy();
    socket.on("error", onError);
    upgrading.add(socket);
    void handleUpgrade(agent, wss, req, socket, head, trusted).catch(error => {
      if (socket.destroyed) return;
      const { status, message } = errorResponse(error);
      const body = JSON.stringify({ error: message });
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    }).finally(() => {
      upgrading.delete(socket);
      socket.off("error", onError);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close() {
      return closing ??= new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of upgrading) socket.destroy();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
      });
    },
  };
}
