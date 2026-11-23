import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function managedClaudeCode(pi: ExtensionAPI): Promise<void> {
  const id = process.env.PATTY_CLAUDE_CODE_MODEL;
  if (!id) throw new Error("Select an explicit claude-code/<model-id> for this run");
  for (const key of ["PI_CLAUDE_CODE_COMMAND", "PI_CLAUDE_CODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"]) {
    if (process.env[key] && !isAbsolute(process.env[key])) throw new Error(`${key} must be absolute in managed Pi runs`);
  }

  const entry = (name: string) => fileURLToPath(new URL(`../../node_modules/@earendil-works/pi-claude-code/src/${name}.ts`, import.meta.url));
  const { createClaudeCodeProvider } = await import(entry("index")) as { createClaudeCodeProvider(): Provider };
  const { getClaudeStatus } = await import(entry("claude-cli")) as {
    getClaudeStatus(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ subscription: boolean; detail?: string }>;
  };
  const signal = AbortSignal.timeout(25_000);
  const status = await getClaudeStatus(process.env, signal);
  if (!status.subscription) {
    throw new Error(status.detail ?? "Claude Code must be signed in to a subscription under the service account");
  }
  const provider = createClaudeCodeProvider();

  // Pi CLI 1.6.0 does cache-only refresh before --model selection. Use the native provider's refresh hook
  // in the async extension factory, publishing only to memory. Then register exactly the requested model
  // from the account's catalog, not the upstream static fallback or Pi's fuzzy/custom model selection.
  let refreshed = false;
  await provider.refreshModels?.({ allowNetwork: true, signal, async publish({ update }) {
    if (signal.aborted || !update) return false;
    update();
    refreshed = true;
    return true;
  } });
  signal.throwIfAborted();
  if (!refreshed || !provider.filterModels) throw new Error("Claude Code did not publish an account catalog");
  const discovered = provider.filterModels(provider.getModels(), undefined);
  const model = discovered.find(model => model.id === id);
  if (!model) throw new Error(`Claude Code did not discover the requested model: ${id}. Available: ${discovered.map(model => model.id).join(", ") || "(none)"}`);
  pi.registerProvider({ ...provider, getModels: () => [model], getAllModels: () => [model], refreshModels: undefined });
}
