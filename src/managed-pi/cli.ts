import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { managedPi, readManagedDelegateSettings } from "./policy.ts";
import { modelsChunk, piModelsSource, piSettingsSource, replaceSection, settingsChunk } from "./pins.ts";

// Both the root and every delegate re-execute this entry, in the same process shape as the pinned CLI.
// There is no CLI settings override in 1.6.0. Keep its argv, modes and state paths; use its own in-memory
// SettingsManager for CLI defaults and bypass just the separate API-key migration from legacy settings.
readManagedDelegateSettings();
process.argv[1] = managedPi.cli; // Delegates re-execute argv[1], even if this entry was started via a symlink.
process.env.PI_WEB_SEARCH_CONFIG = managedPi.webSearchConfig;
let settings = replaceSection(piSettingsSource(), "static create(cwd,agentDir=getAgentDir(),options={}){",
  "static fromStorage(storage,options={})", "static create(_cwd,_agentDir,options={}){return _SettingsManager.inMemory({},options)}");
settings = replaceSection(settings, "if(existsSync19(settingsPath))try{let content=readFileSync19(settingsPath,",
  "return Object.keys(migrated).length>0", "");
settings = replaceSection(settings, "discoverSystemPromptFile(){let projectPath=", "isUnderPath(target,root)",
  "discoverSystemPromptFile(){return undefined}discoverAppendSystemPromptFile(){return undefined}");

// The top level already passes --no-context-files. Keep checkout instructions for delegates and reviews,
// without inheriting them from the agent dir, checkout ancestors, or links out of the checkout.
settings = settings.replace("function loadContextFileFromDir(dir){", "function loadContextFileFromDir(dir,root){")
  .replace("if(existsSync13(filePath))try{if(!statSync7(filePath).isFile())continue;",
    "if(existsSync13(filePath))try{if(!isPathWithin(root,canonicalizePath(filePath))||!statSync7(filePath).isFile())continue;");
settings = replaceSection(settings, "function findShadowedContextFile(cwd){", "var DefaultResourceLoader=", `
function loadProjectContextFiles(options){
  const cwd=canonicalizePath(resolvePath(options.cwd));
  const root=findGitPaths(cwd)?.repoDir;
  const files=[];
  if(!root)return files;
  for(let dir=cwd;;dir=dirname12(dir)){
    const file=loadContextFileFromDir(dir,root);
    if(file)files.unshift(file);
    if(dir===root)break;
  }
  return files;
}
`);

// models.json is another config input, not the model catalog cache. Don't load provider overrides from it,
// but keep Pi's file-backed model cache and AuthStorage at the same state paths.
const models = replaceSection(piModelsSource(), "modelsPath=options.modelsPath===null?void 0:", "builtinModelDataGeneratedAt=",
  'modelsPath=void 0,config=await ModelConfig.load(modelsPath),modelsStore=options.modelsStore??new FileModelsStore(options.modelsStorePath??join2(getAgentDir(),"models-store.json")),');

// Two exact modules of the immutable bundle, for the duration of its import. No preload, fs wrapper, on-disk
// patch, or change to their module URLs (the bundle resolves resources relative to them).
const adapted = new Map([
  [pathToFileURL(realpathSync(settingsChunk)).href, settings],
  [pathToFileURL(realpathSync(modelsChunk)).href, models],
]);
const hook = registerHooks({
  load(url, context, nextLoad) {
    const source = adapted.get(url);
    return source === undefined ? nextLoad(url, context) : { format: "module", source, shortCircuit: true };
  },
});
try {
  await import(pathToFileURL(managedPi.bundleCli).href);
} finally {
  hook.deregister();
}
