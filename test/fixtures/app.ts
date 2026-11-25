import { defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt } from "@earendil-works/pi-schema";
import type { ConnectedApp } from "../../src/apps/app.ts";
import { HttpError, requireMethod, sendJson } from "../../src/http.ts";

export function fixtureApp(id: string, options: { unavailable?: boolean; toolName?: string; web?: URL; close?: () => void } = {}): ConnectedApp {
  return {
    id, title: `Fixture ${id}`, instructions: `Instruction for fixture ${id}.`,
    open({ dataDir }) {
      if (options.unavailable) throw new Error("fixture could not open");
      return {
        tools: [
          defineTool({
            name: options.toolName ?? `${id}_probe`, description: `Read a sample from fixture ${id}`, parameters: obj({ fail: opt(bool()) }),
            async execute({ fail }) {
              if (fail) throw new Error(`${id} tool failed`);
              return { output: [{ type: "text", text: `${id} tool works` }] };
            },
          }),
          defineTool({
            name: `${id}_deferred`, description: `Discover the deferred ${id} tool`, parameters: obj({}), deferred: true,
            async execute() { return { output: [{ type: "text", text: `${id} deferred works` }] }; },
          }),
        ],
        async handle(req, res, path) {
          requireMethod(req, res, "GET");
          if (path === "/throw") throw new Error("fixture request failed");
          if (path === "/partial") { res.write("partial"); throw new Error("fixture failed after writing"); }
          if (path !== "/") throw new HttpError(404, "Not found");
          sendJson(res, 200, { id, dataDir });
        },
        web: options.web,
        close: options.close ?? (() => {}),
      };
    },
  };
}
