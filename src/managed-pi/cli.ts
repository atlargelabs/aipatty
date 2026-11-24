import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { managedPi, readManagedDelegateSettings } from "./policy.ts";
import { piSettingsSource, replaceSection, settingsChunk } from "./pins.ts";

// Both the root and every delegate re-execute this entry, in the same process shape as the pinned CLI.
// There is no CLI settings override in 1.6.0. Keep its argv, modes and state paths; use its own in-memory
// SettingsManager for CLI defaults and bypass just the separate API-key migration from legacy settings.
readManagedDelegateSettings();
process.argv[1] = managedPi.cli; // Delegates re-execute argv[1], even if this entry was started via a symlink.
process.env.PI_WEB_SEARCH_CONFIG = managedPi.webSearchConfig;
let source = replaceSection(piSettingsSource(), "static create(cwd,agentDir=getAgentDir(),options={}){",
  "static fromStorage(storage,options={})", "static create(_cwd,_agentDir,options={}){return _SettingsManager.inMemory({},options)}");
source = replaceSection(source, "if(existsSync19(settingsPath))try{let content=readFileSync19(settingsPath,",
  "return Object.keys(migrated).length>0", "");

// One exact module of the immutable bundle, for the duration of its import. No preload, fs wrapper, on-disk
// patch, or change to the module URL (the bundle resolves resources relative to it).
const chunk = pathToFileURL(realpathSync(settingsChunk)).href;
const hook = registerHooks({
  load(url, context, nextLoad) {
    return url === chunk ? { format: "module", source, shortCircuit: true } : nextLoad(url, context);
  },
});
try {
  await import(pathToFileURL(managedPi.bundleCli).href);
} finally {
  hook.deregister();
}
