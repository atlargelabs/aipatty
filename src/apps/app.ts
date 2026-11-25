import type { ToolRegistration as Tool } from "@earendil-works/pi-durable";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A reviewed, in-process module. The host owns the namespace and attachment. */
export interface ConnectedApp {
  /** Lower-case letters and digits. */
  id: string;
  title: string;
  instructions: string;
  /** Called once at startup. If it throws, it must not leave anything open. */
  open(context: { dataDir: string }): OpenApp;
}

export interface OpenApp {
  /** Each name starts `<id>_`. */
  tools: Tool[];
  /** `path` is the pathname after `/apps/<id>`, starting with `/`. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
  /** Browser module exporting `steps: Step[]`, served with its types removed. */
  web?: URL;
  close(): void;
}

export const appId = /^[a-z0-9]+$/;
