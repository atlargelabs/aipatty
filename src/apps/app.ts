import type { Extension } from "@earendil-works/pi-durable";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A trusted, in-process module. `path` is the pathname relative to `/apps/<id>` (e.g. `/branch.js`). */
export interface ConnectedApp {
  id: string;
  title: string;
  instructions: string;
  open(dataDir: string): OpenApp;
}

export interface OpenApp {
  extension: Extension;
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
  close(): void;
}

/** Encounters with an installed app that failed to open can still report why. */
export type AppStatus = Pick<ConnectedApp, "title"> & (
  { opened: OpenApp; instructions: string } | { opened?: undefined; unavailable: string }
);
