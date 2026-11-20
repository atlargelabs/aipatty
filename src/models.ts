import {
  contentText, createModels, fauxAssistantMessage, fauxProvider, getModelType,
  type AnyModel, type Api, type Model, type Models, type Provider,
} from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Accept a cached chat model only if it belongs to `provider` and uses an API the provider already serves. */
function isChatModel(value: unknown, provider: string, apis: ReadonlySet<string>): value is Model<Api> {
  return record(value) && (value.type === undefined || value.type === "chat")
    && value.provider === provider && typeof value.api === "string" && apis.has(value.api)
    && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string"
    && typeof value.baseUrl === "string" && URL.canParse(value.baseUrl)
    && typeof value.reasoning === "boolean"
    && Array.isArray(value.input) && value.input.every(input => input === "text" || input === "image")
    && typeof value.contextWindow === "number" && value.contextWindow > 0
    && typeof value.maxTokens === "number" && value.maxTokens > 0
    && record(value.cost)
    && ["input", "output", "cacheRead", "cacheWrite"].every(key => {
      const rate = (value.cost as Record<string, unknown>)[key];
      return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
    });
}

/**
 * The pi CLI's cached catalog, or an empty one when it is missing or unreadable. The CLI owns the file. Only a missing
 * file is silent: any other failure can leave the default model unavailable, so it is logged.
 */
async function readCatalog(path: string): Promise<Record<string, unknown>> {
  try {
    const cache: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (record(cache)) return cache;
    console.error(`Ignoring model catalog ${path}: expected a JSON object`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Ignoring model catalog ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return {};
}

/** The cached chat models of one provider, if the cache is newer than the bundled catalog. */
function cachedModels(catalog: Record<string, unknown>, base: Provider): Model<Api>[] {
  const entry = catalog[base.id];
  const bundledAt = getBuiltinModelDataGeneratedAt();
  const newer = record(entry) && (bundledAt === undefined
    || (typeof entry.lastModified === "number" && entry.lastModified > bundledAt));
  if (!newer || !Array.isArray(entry.models)) return [];
  const apis = new Set<string>(base.getModels().map(model => model.api));
  return entry.models.filter(model => isChatModel(model, base.id, apis));
}

// Equivalent to the CLI's offline withRemoteCatalog restore, without refreshing or consulting auth.
function withOverlay(base: Provider, overlay: readonly Model<Api>[]): Provider {
  function merge<T extends AnyModel>(baseline: readonly T[]): (T | Model<Api>)[] {
    return [...new Map([...baseline, ...overlay].map(model => [`${getModelType(model)}\0${model.id}`, model])).values()];
  }
  return {
    ...base,
    getModels: () => merge(base.getModels()),
    getAllModels: () => merge(base.getAllModels?.() ?? base.getModels()),
  };
}

function demoProvider(): Provider {
  const faux = fauxProvider({ tokensPerSecond: 80, tokenSize: { min: 3, max: 3 } });
  const respond = () => faux.appendResponses([context => {
    const input = context.messages.findLast(message => message.role === "user");
    return fauxAssistantMessage(`Faux reply: ${input ? contentText(input.content) : "Hello!"}`);
  }]);
  return {
    ...faux.provider,
    stream(model, context, options) {
      respond();
      return faux.provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      respond();
      return faux.provider.streamSimple(model, context, options);
    },
  };
}

/** Build the local chat catalog. Startup never refreshes a catalog or token over the network. */
export async function openModels(config: Config): Promise<Models> {
  if (config.faux) {
    const models = createModels();
    models.setProvider(demoProvider());
    return models;
  }
  const models = createModels({ credentials: new FileCredentialStore(config.authFile) });
  const catalog = await readCatalog(config.modelsStore);
  const base = openaiProvider();
  // Don't fall back to OPENAI_API_KEY when the subscription login is missing.
  models.setProvider({ ...withOverlay(base, cachedModels(catalog, base)), auth: { oauth: base.auth.oauth } });
  return models;
}
