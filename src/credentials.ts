import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

type Data = Record<string, unknown>;
const staleMs = 30_000;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function credential(value: unknown): Credential | undefined {
  if (value && typeof value === "object" && "type" in value) {
    if (value.type === "api_key" || value.type === "oauth") return value as Credential;
  }
  return undefined;
}

async function acquire(path: string, signal: AbortSignal | undefined, onCompromised: (error: Error) => void) {
  const deadline = Date.now() + staleMs;
  let epermRetries = 0;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await lockfile.lock(path, { retries: 0, stale: staleMs, onCompromised });
    } catch (error) {
      signal?.throwIfAborted();
      const code = errorCode(error);
      const retry = code === "ELOCKED" || (code === "EPERM" && process.platform === "win32" && ++epermRetries <= 5);
      const remaining = deadline - Date.now();
      if (!retry || remaining <= 0) throw error;
      const delay = Math.min(Math.round(Math.min(10 * 2 ** attempt, 1000) * (1 + Math.random())), remaining);
      await sleep(delay, undefined, { signal });
    }
  }
}

/** The pi CLI's auth.json format and cross-process lock, with atomic writes. */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  private async target(create: boolean): Promise<string | undefined> {
    try {
      return await realpath(this.path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (!create) return undefined;

    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.init`;
    try {
      // Establish a complete file without overwriting one created by another writer.
      await writeFile(temp, "{}", { mode: 0o600, flag: "wx" });
      try {
        await link(temp, this.path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    } finally {
      await rm(temp, { force: true });
    }
    return realpath(this.path);
  }

  private async load(path: string): Promise<Data> {
    const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Invalid auth.json: invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid auth.json: expected an object");
    }
    return Object.assign(Object.create(null) as Data, parsed);
  }

  private async locked<T>(
    create: boolean,
    fn: (data: Data) => Promise<{ value: T; write?: boolean }>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const path = await this.target(create);
    signal?.throwIfAborted();
    if (!path) return (await fn(Object.create(null) as Data)).value;

    let compromised: Error | undefined;
    const release = await acquire(path, signal, error => { compromised = error; });
    const check = () => {
      if (compromised) throw compromised;
      signal?.throwIfAborted();
    };
    try {
      check();
      const data = await this.load(path);
      check();
      const result = await fn(data);
      check();
      if (result.write) {
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          check();
          await rename(temp, path);
        } finally {
          await rm(temp, { force: true });
        }
      }
      if (compromised) throw compromised;
      return result.value;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!compromised) throw error;
      }
    }
  }

  /** Read the subscription login without creating a missing auth file. */
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.locked(false, async data => {
      const value = credential(data[providerId]);
      if (value?.type === "api_key") {
        throw new Error("API keys are not supported. Sign in to the ChatGPT subscription with the pi CLI.");
      }
      return { value };
    }, options);
  }

  /** List provider IDs and credential types, never secrets. */
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.locked(false, async data => {
      const value: CredentialInfo[] = [];
      for (const [providerId, entry] of Object.entries(data)) {
        const type = credential(entry)?.type;
        if (type) value.push({ providerId, type });
      }
      return { value };
    }, options);
  }

  /** Update one provider under the CLI's lock; an undefined replacement is a no-op. */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.locked(true, async data => {
      const current = credential(data[providerId]);
      const next = await fn(current);
      if (next === undefined) return { value: current };
      data[providerId] = next;
      return { value: next, write: true };
    }, options);
  }

  /** Delete one provider without disturbing other entries. */
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.locked(false, async data => {
      const write = Object.hasOwn(data, providerId);
      delete data[providerId];
      return { value: undefined, write };
    }, options);
  }
}
