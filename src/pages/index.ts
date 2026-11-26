import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { HttpError, jsonBody, pageHeaders, requireMethod, sendJson } from "../http.ts";
import { brandHeaders } from "../web/brand.ts";
import { libraryCss, libraryHtml, libraryScriptPath, libraryStylePath } from "./library.ts";
import { maxPageTitle, pageIdPattern, pagePath, pagesLibraryApi, pagesPath, pagesPreviewScript, publishPageTool } from "./shared.ts";
import { maxHtmlBytes, openPagesStore } from "./store.ts";

export function isPagesPath(path: string): boolean {
  return path === pagesPath || path.startsWith(`${pagesPath}/`);
}

function pageCsp(interactive: boolean): string {
  return [
    interactive ? "sandbox allow-scripts" : "sandbox",
    "default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
    "style-src 'unsafe-inline'", "img-src data: https: http:",
    ...(interactive ? ["script-src 'unsafe-inline'", "connect-src https: http: wss: ws:"] : []),
  ].join("; ");
}

function script(file: string) {
  return stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"));
}

function openPagesAt(path: string) {
  const assets = new Map([
    [pagesPath, { body: libraryHtml, type: "text/html" }],
    [`${pagesPath}/`, { body: libraryHtml, type: "text/html" }],
    [libraryStylePath, { body: libraryCss, type: "text/css" }],
    [libraryScriptPath, { body: script("./library-web.ts"), type: "text/javascript" }],
    [pagesPreviewScript, { body: script("./preview.ts"), type: "text/javascript" }],
    [`${pagesPath}/shared.ts`, { body: script("./shared.ts"), type: "text/javascript" }],
  ]);
  const store = openPagesStore(path);
  const extension = defineExtension({
    name: "aipatty-pages",
    tools: [defineTool({
      name: publishPageTool,
      description: "Publish a standalone HTML page and return its link and chat preview. Each call creates a new immutable page "
        + "in the instance's Pages library. Prefer static HTML; enable interactive only for pages that need JavaScript. "
        + "Pages are sandboxed; external data is requested by the user's browser, not by aipatty. Do not bundle credentials.",
      parameters: obj({
        title: str({ minLength: 1, maxLength: maxPageTitle, description: "A short title shown in the library" }),
        html: str({ minLength: 1, maxLength: maxHtmlBytes, description: `Standalone HTML source, at most ${maxHtmlBytes / 1024} KiB in UTF-8; not a path` }),
        interactive: opt(bool({ description: "Allow inline JavaScript; default false. Inline chat previews require a click in this mode." })),
      }),
      replay: "unsafe", // An interrupted call may already have created its page.
      async execute({ title, html, interactive }, _api, context) {
        context.abortSignal?.throwIfAborted();
        const details = store.publish(title, html, interactive);
        return { output: [{ type: "text", text: `Published ${details.title} (${details.mode}): ${pagePath(details.id)}` }], details };
      },
    })],
  });
  return {
    extension, close: store.close,
    // The listener has already validated Host and Origin. This subrouter never opens a path from the request.
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string) {
      for (const [key, value] of Object.entries(pageHeaders)) res.setHeader(key, value);
      res.setHeader("Cache-Control", "no-store");
      const asset = assets.get(pathname);
      if (asset) {
        requireMethod(req, res, "GET");
        res.writeHead(200, { "Content-Type": `${asset.type}; charset=utf-8`, ...(asset.type === "text/html" && brandHeaders) });
        res.end(asset.body);
      } else if (pathname === pagesLibraryApi) {
        requireMethod(req, res, "GET", "POST", "DELETE");
        if (req.method !== "GET") {
          const body = await jsonBody(req);
          if (req.method === "DELETE") store.delete(body.id);
          else if (body.action === "create") store.createSection(body.name);
          else if (body.action === "move") store.move(body.id, body.section);
          else if (body.action === "step") store.step(body.id, body.direction);
          else throw new HttpError(400, "Unknown library action.");
        }
        sendJson(res, 200, { sections: store.library() });
      } else {
        const id = pathname.slice(pagesPath.length + 1, -1);
        if (!pageIdPattern.test(id) || pathname !== pagePath(id)) throw new HttpError(404, "Page not found.");
        requireMethod(req, res, "GET", "HEAD");
        const page = store.page(id);
        if (!page) throw new HttpError(404, "Page no longer available.");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": pageCsp(page.mode === "interactive"),
          "Content-Length": page.html.byteLength,
        });
        res.end(req.method === "HEAD" ? undefined : page.html);
      }
    },
  };
}

export type Pages = ReturnType<typeof openPagesAt>;

/** Open the instance's library at startup. A failure must not take down chat. */
export function openPages(dataDir: string): Pages | undefined {
  const path = join(dataDir, "pages.sqlite");
  try { return openPagesAt(path); }
  catch (error) { console.error(`Pages unavailable at ${path}:`, error); }
}
