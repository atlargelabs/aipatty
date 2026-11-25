import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const pageHeaders = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

const maxBody = 64 * 1024;

export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function requireMethod(req: IncomingMessage, res: ServerResponse, ...methods: string[]): void {
  if (req.method && methods.includes(req.method)) return;
  res.setHeader("Allow", methods.join(", "));
  throw new HttpError(405, "Method not allowed");
}
