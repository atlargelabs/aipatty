import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import type { Conversation, EntryId, InputSubmissionDraft, Submission, SubmissionId } from "@earendil-works/pi-durable";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { LOOPBACK } from "./config.ts";
import { HttpError, type AgentHost } from "./host.ts";
import { pageCss, pageHtml, pageJs } from "./page.ts";
import { messageText, shutdownHeader, streamState, streamUpdate, type StreamFrame } from "./protocol.ts";
import { transcriptPage } from "./transcript.ts";

const maxBody = 64 * 1024;
const defaultPage = 50;
const maxPage = 100;
const defaultHeartbeatMs = 30_000;

/** What the listener keeps about its open streams, so a close or a silent client can end them. */
interface Streams {
  /** Aborted before the harness closes, so a shutdown is not reported as a stream failure. */
  readonly controllers: Set<AbortController>;
  /** Sockets that answered the last ping, or opened after it. */
  readonly alive: WeakSet<WebSocket>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  console.error("API error:", error);
  return { status: 500, message: "Internal server error" };
}

/** The names a client can use for the loopback listener, on this machine or at the near end of an SSH port forward. */
const loopbackNames = [LOOPBACK, "localhost"];

/**
 * The request's URL, once its Host names this listener and its Origin, if any, is the same origin. A page on another
 * site that points its own name at this address, or sends a cross-site request, fails one of the two.
 */
function requestUrl(req: IncomingMessage): URL {
  const authority = req.headers.host?.toLowerCase();
  const port = req.socket.localPort;
  const name = loopbackNames.find(n => authority === `${n}:${port}` || (port === 80 && authority === n));
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

  return { ...state, ...await transcriptPage(conversation, ctx, limit, before) };
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): void {
  if (req.method === method) return;
  res.setHeader("Allow", method);
  throw new HttpError(405, "Method not allowed");
}

async function handleHttp(
  agent: AgentHost, health: Health, req: IncomingMessage, res: ServerResponse,
  shutdown?: (res: ServerResponse) => void,
) {
  const { pathname, searchParams } = requestUrl(req);
  if (pathname === "/api/shutdown" && shutdown) {
    requireMethod(req, res, "POST");
    const marker = req.headersDistinct[shutdownHeader];
    if (marker?.length !== 1 || marker[0] !== "1") throw new HttpError(403, `Expected ${shutdownHeader}: 1`);
    shutdown(res);
    return;
  }
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
  if (pathname === "/" || pathname === "/index.html") {
    requireMethod(req, res, "GET");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(pageHtml);
    return;
  }
  if (pathname === "/app.js" || pathname === "/app.css") {
    requireMethod(req, res, "GET");
    const js = pathname === "/app.js";
    res.writeHead(200, {
      "Content-Type": js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(js ? pageJs : pageCss);
    return;
  }
  if (pathname === "/api/branches") {
    requireMethod(req, res, "GET");
    sendJson(res, 200, await agent.branches());
    return;
  }
  // The root's model and thinking level, kept from step 1 for the CLI's defaults.
  if (pathname === "/api/model" || pathname === "/api/thinking") {
    requireMethod(req, res, "PUT");
    const root = (await agent.conversation("root"))!;
    await (pathname === "/api/model" ? setModel(agent, root, req) : setThinking(agent, root, req));
    sendJson(res, 200, await agent.modelStatus(root));
    return;
  }
  const route = /^\/api\/conversations\/([^/]+)(?:\/(messages|abort|fork|title|model|thinking|search))?$/.exec(pathname);
  if (!route) throw new HttpError(404, "Not found");
  const [, id, action] = route;
  const method = !action || action === "search" ? "GET"
    : action === "title" || action === "model" || action === "thinking" ? "PUT" : "POST";
  requireMethod(req, res, method);
  const conversation = await agent.conversation(id);
  if (!conversation) throw new HttpError(404, "Conversation not found");

  if (action === "messages") {
    const submission = await agent.submit(conversation, await messageDraft(req));
    sendJson(res, 202, { submissionId: submission.id });
  } else if (action === "abort") {
    await agent.abort(conversation);
    sendJson(res, 200, { ok: true });
  } else if (action === "fork") {
    const { title, at } = await jsonBody(req);
    if (typeof title !== "string") throw new HttpError(400, "Expected title");
    if (at !== undefined && (typeof at !== "number" || !Number.isSafeInteger(at) || at < 1)) {
      throw new HttpError(400, "at must be an entry ID");
    }
    sendJson(res, 201, await agent.fork(conversation, { title, at }));
  } else if (action === "title") {
    const { title } = await jsonBody(req);
    if (typeof title !== "string") throw new HttpError(400, "Expected title");
    await agent.rename(conversation, title);
    sendJson(res, 200, await agent.branch(conversation));
  } else if (action === "model") {
    await setModel(agent, conversation, req);
    sendJson(res, 200, await agent.branch(conversation));
  } else if (action === "thinking") {
    await setThinking(agent, conversation, req);
    sendJson(res, 200, await agent.branch(conversation));
  } else if (action === "search") {
    const query = searchParams.get("q") ?? "";
    if (!query.trim() || query.length > 200) throw new HttpError(400, "Expected q of 1 to 200 characters");
    const limit = positiveInt(searchParams.get("limit"), "limit", maxPage);
    const before = positiveInt(searchParams.get("before"), "before");
    sendJson(res, 200, await agent.search(conversation, query, { limit, before }));
  } else {
    const [page, branch, totalCost] = await Promise.all([
      conversationPage(conversation, searchParams), agent.branch(conversation), agent.totalCost(),
    ]);
    sendJson(res, 200, { ...page, branch, totalCost });
  }
}

async function setModel(agent: AgentHost, conversation: Conversation, req: IncomingMessage): Promise<void> {
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
  await agent.setModel({ provider, modelId }, conversation);
}

async function setThinking(agent: AgentHost, conversation: Conversation, req: IncomingMessage): Promise<void> {
  const { level } = await jsonBody(req);
  if (typeof level !== "string") throw new HttpError(400, "Expected level");
  await agent.setThinking(level, conversation);
}

async function stream(socket: WebSocket, streams: Streams, conversation: Conversation, submission?: Submission): Promise<void> {
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, ctx);
  streams.controllers.add(controller);
  streams.alive.add(socket);
  socket.on("pong", () => streams.alive.add(socket));
  socket.on("close", () => {
    streams.controllers.delete(controller);
    controller.abort();
  });
  socket.on("error", () => socket.terminate());
  socket.on("message", () => socket.close(1008, "Stream is read-only"));
  // A frame that cannot be written means the client is gone, or was dropped by the heartbeat: end the stream, not fail it.
  const send = (value: StreamFrame) => new Promise<void>(resolve => {
    if (socket.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.send(JSON.stringify(value), error => {
      if (error) {
        controller.abort();
        socket.terminate();
      }
      resolve();
    });
  });

  try {
    const watch = await conversation.watch(context, { min: defaultPage, max: defaultPage });
    // Send the attachment value first; the watch folds changes while a client is slow.
    let sent = watch.value;
    const initial = send(streamState(sent));
    watch.start(async call => {
      if (call.kind !== "value") return;
      // A partial answer changes only the live document; do not serialise the whole window again for it.
      const frame = streamUpdate(sent, call.value);
      sent = call.value;
      await send(frame);
    });
    void watch.closed.then(end => {
      if (!controller.signal.aborted) socket.close(end.kind === "ended" ? 1001 : 1011, "Stream ended");
    });
    await initial;
    if (!submission) return;

    const result = await submission.wait(context);
    if (result.status === "unanswered") {
      await send({
        type: "settled", submissionId: result.id, status: "unanswered", reason: result.reason, detail: result.detail,
      });
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
  agent: AgentHost, wss: WebSocketServer, streams: Streams, req: IncomingMessage, socket: Duplex, head: Buffer,
) {
  const { pathname, searchParams } = requestUrl(req);
  const route = /^\/api\/conversations\/([^/]+)\/stream$/.exec(pathname);
  if (!route) throw new HttpError(404, "Not found");
  const conversation = await agent.conversation(route[1]);
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const id = positiveInt(searchParams.get("submissionId"), "submissionId");
  let submission: Submission | undefined;
  if (id !== undefined) {
    // Waiting resumes scheduling, which would run work blocked on an unavailable model.
    await agent.assertRunning();
    submission = await agent.harness.submission(id as SubmissionId, ctx);
    const status = await submission?.status(ctx);
    if (!status || status.conversationId !== conversation.id || status.type !== "input") {
      throw new HttpError(404, "Submission not found");
    }
  }
  if (!socket.destroyed) {
    wss.handleUpgrade(req, socket, head, ws => { void stream(ws, streams, conversation, submission); });
  }
}

/** Process identity returned by /health. */
export interface Health {
  ok: true;
  commit: string;
  startedAt: string;
  version: string;
}

/**
 * Serve the root (or any conversation ID) over HTTP and WebSocket, on loopback only. Each stream is pinged every
 * `heartbeatMs` and dropped if it has not answered by the next ping, so a client that vanished without closing does
 * not linger.
 */
export async function startApi(agent: AgentHost, health: Health, port: number, {
  heartbeatMs = defaultHeartbeatMs, onShutdown,
}: { heartbeatMs?: number; onShutdown?: () => void } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const streams: Streams = { controllers: new Set(), alive: new WeakSet() };
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!streams.alive.delete(ws)) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, heartbeatMs).unref();
  let shutdownPending = false;
  const shutdown = onShutdown && ((res: ServerResponse) => {
    if (shutdownPending) throw new HttpError(409, "Shutdown already requested");
    shutdownPending = true;
    const stop = () => {
      clearTimeout(deadline);
      res.off("finish", stop).off("close", stop);
      onShutdown();
    };
    // Normally finish hands the acknowledgement to the OS before close() destroys sockets. A disconnected
    // client or a write stuck behind an earlier pipelined response must not block an accepted shutdown.
    const deadline = setTimeout(stop, 1_000).unref();
    res.once("finish", stop).once("close", stop);
    res.shouldKeepAlive = false;
    sendJson(res, 202, { status: "shutdown-requested" });
  });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void handleHttp(agent, health, req, res, shutdown).catch(error => {
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
    void handleUpgrade(agent, wss, streams, req, socket, head).catch(error => {
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
    server.listen(port, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    /** Where the listener is bound. */
    address: { address: address.address, family: address.family, port: address.port },
    close() {
      return closing ??= new Promise<void>(resolve => {
        clearInterval(heartbeat);
        // Before any socket closes: the harness may close, and reject a stream's wait, ahead of the close events.
        for (const controller of streams.controllers) controller.abort();
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of upgrading) socket.destroy();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
      });
    },
  };
}
