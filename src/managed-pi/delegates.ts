import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { delegatesSource, replaceSection } from "./pins.ts";
import { managedPi } from "./policy.ts";

const policy = fileURLToPath(new URL("./policy.ts", import.meta.url));

/** Use the pinned delegates coordinator, with release policy in place of the upstream settings reader. */
export default async function managedDelegates(pi: ExtensionAPI): Promise<void> {
  const upstream = managedPi.delegatesEntry;
  let source = delegatesSource()
    .replace('import { fileURLToPath } from "node:url";', "")
    .replace("{ loadConfig, migrateSettings, readSettings, resolveConfig }", "{ resolveConfig }")
    .replace(/from "\.\/([\w/.-]+\.ts)"/g, (_, sibling: string) => `from ${JSON.stringify(join(dirname(upstream), sibling))}`);
  source = `import { readManagedDelegateSettings } from ${JSON.stringify(policy)};\n${source}`;
  source = replaceSection(source, "const agentDir = getAgentDir();", "\n\t\tprofileRoles.clear();",
    "const agentDir = getAgentDir();\n\tconst settings = readManagedDelegateSettings();\n\tconst config = () => {\n\t\tconst resolved = resolveConfig(settings);");
  source = replaceSection(source, "extensionPath: fileURLToPath(import.meta.url),", "\n\t\t\tsessionId:",
    `extensionPath: ${JSON.stringify(upstream)},`);
  source = replaceSection(source, "Object.keys(resolveConfig(readSettings(", "\n\t\t\tfalse,",
    "Object.keys(resolveConfig(settings).profiles),");
  source = replaceSection(source, 'if (action === "migrate")', "\n\t\t\t\t\tshow(\n",
    'if (action === "migrate" || action === "models") throw new Error("Managed delegates policy is set by the running release");');

  // The bundle's extension loader supplies its virtual Pi imports. Only this small entry is staged, from
  // checked release source. Children use the original pinned entry and only the coordinator's frozen bootstrap
  // context (which bypasses both local settings and interactive writes); they never use the temporary entry.
  const temp = tmpdir();
  if (!isAbsolute(temp)) throw new Error("Managed delegates needs an absolute system temp directory");
  const stage = await mkdtemp(join(temp, "aipatty-delegates-"));
  try {
    const path = join(stage, "index.ts");
    await writeFile(path, source, { mode: 0o400 });
    const { default: register } = await import(path) as { default: (api: ExtensionAPI) => void };
    register(pi);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
