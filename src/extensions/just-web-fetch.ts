import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const upstream = fileURLToPath(new URL("../../node_modules/just-web-fetch/src/", import.meta.url));
const helpers = fileURLToPath(new URL("./web-fetch-runtime.ts", import.meta.url));

async function pinnedSource(name: string, sha256: string): Promise<string> {
  const source = await readFile(join(upstream, name), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== sha256) {
    throw new Error(`just-web-fetch ${name} changed: review the managed compatibility patch before updating the pin`);
  }
  return source;
}

/** The source digests below bind these edits to the reviewed a933b90 pin. Never run the unguarded entry. */
function replace(source: string, from: string, to: string, text: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`just-web-fetch compatibility patch could not find ${from}`);
  return source.slice(0, start) + text + source.slice(end);
}

export default async function managedWebFetch(pi: ExtensionAPI): Promise<void> {
  let entry = await pinnedSource("index.ts", "a2870092745d012279fe716ebadb35aac46ba6a12e3f2d56f47d23c5220fc5ec");
  let browser = await pinnedSource("browser-pool.ts", "1bfc4c787366a34d486f2f99572cf61796ad7a2722674d4976f62dfc4fce9300");

  // No fetch config, local hook imports, or registration on the extension event bus. Keep upstream storage,
  // navigation, network policy, extraction results, and shutdown. Check prerequisites only on a fetch call.
  entry = replace(entry, "// --- Config ---", "const registry", `const DATA_DIR = join(getAgentDir(), "just-web-fetch", "aipatty");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const EPHEMERAL_DIR = join(DATA_DIR, "ephemeral");

`);
  entry = replace(entry, "// --- Extension Loading ---", "// --- Constants ---", "");
  entry = replace(entry, "// --- Subprocess Helpers ---", "// Exported for tests", `import { egressProxy, extractContent, extractorPath } from ${JSON.stringify(helpers)};\n\n`);
  entry = replace(entry, "\t// Dependency check", "\t\ttry {\n\t\t\tstore", '\tpi.on("session_start", async (_event, ctx) => {\n');
  entry = entry.replace("config.retentionDays ?? DEFAULT_RETENTION_DAYS", "DEFAULT_RETENTION_DAYS");
  entry = replace(entry, "\t\t// 4. Signal readiness", "\t\t// Start cache cleanup", "");
  entry = entry.replace("\t\t// 4. Fetch page", "\t\textractorPath();\n\t\tegressProxy();\n\n\t\t// 4. Fetch page");
  entry = replace(entry, "\t\tconst extractResult = await withTimeout", "\t\tif (!extractResult.ok)", "\t\tconst extractResult = await extractContent(html, signal);\n");

  // npm aliases Puppeteer to puppeteer-core: no executable config discovery, no browser download. Keep the
  // upstream system browser search and the default Chrome sandbox. Ignore relative executable overrides.
  const require = createRequire(join(upstream, "browser-pool.ts"));
  if (require("puppeteer/package.json").name !== "puppeteer-core") {
    throw new Error("Managed just-web-fetch requires puppeteer-core (no Puppeteer config discovery)");
  }
  const puppeteer = require.resolve("puppeteer");
  browser = browser.replace('from "puppeteer"', `from ${JSON.stringify(puppeteer)}`);
  browser = replace(browser, "\t\tconst executable =", "\t\ttry {\n\t\t\tthis.browser", `\t\tconst configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
		if (configured && !isAbsolute(configured)) throw new Error("PUPPETEER_EXECUTABLE_PATH must be absolute");
		const executable = findBrowserExecutable();
		if (!executable.ok) throw new Error(configured
			? "PUPPETEER_EXECUTABLE_PATH is not executable"
			: "Install Chrome/Chromium or set PUPPETEER_EXECUTABLE_PATH to its absolute path");
		this.launching = puppeteer.launch({
			headless: true, pipe: true, executablePath: executable.path, env: childEnv(),
			args: ["--proxy-server=" + egressProxy(), "--proxy-bypass-list=<-loopback>",
				"--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
		});

`);
  browser = `import { isAbsolute } from "node:path";\nimport { childEnv, egressProxy } from ${JSON.stringify(helpers)};\n${browser}`;

  // Only the two patched modules are staged. Resolve every other sibling against the pinned release rather
  // than against the worktree or a temporary project's node_modules. The bundled CLI's loader (not Node's
  // native TS loader) supplies the legacy Pi imports as virtual aliases to the *running* 1.6.0 modules.
  const siblings = (source: string) => source.replace(/from "\.\/([\w-]+)\.js"/g, (_, name: string) =>
    name === "browser-pool" ? 'from "./browser-pool.ts"' : `from ${JSON.stringify(join(upstream, `${name}.ts`))}`);
  const temp = tmpdir();
  if (!isAbsolute(temp)) throw new Error("Managed just-web-fetch needs an absolute system temp directory");
  const stage = await mkdtemp(join(temp, "aipatty-web-fetch-"));
  try {
    await writeFile(join(stage, "browser-pool.ts"), siblings(browser));
    const path = join(stage, "index.ts");
    await writeFile(path, siblings(entry));
    const { default: register } = await import(path) as { default: (pi: ExtensionAPI) => void };
    register(pi);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
