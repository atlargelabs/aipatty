import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** No inherited tokens, runner/project settings, or relative PATH entries for Chrome or the extractor. */
export function childEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const temp = tmpdir();
  return {
    PATH: "/usr/bin:/bin",
    ...(isAbsolute(home) ? { HOME: home } : {}),
    ...(isAbsolute(temp) ? { TMPDIR: temp } : {}),
    ...(process.env.PATTY_RUN_ID ? { PATTY_RUN_ID: process.env.PATTY_RUN_ID } : {}),
  };
}

/** Require an operator-provisioned filtering proxy; never let Chrome fall back to direct egress. */
export function egressProxy(): string {
  try {
    const url = new URL(process.env.PI_WEB_FETCH_EGRESS_PROXY ?? "");
    if (["http:", "https:"].includes(url.protocol) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash) {
      return url.origin;
    }
  } catch {
    // Missing or invalid proxy configuration must not enable direct browsing.
  }
  throw new Error("Set PI_WEB_FETCH_EGRESS_PROXY to the HTTP(S) origin of a trusted proxy that blocks private destinations at connection time");
}

export function extractorPath(): string {
  const path = process.env.PI_WEB_FETCH_TRAFILATURA;
  if (path && isAbsolute(path)) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // Report the same actionable error for missing, relative, or non-executable paths.
    }
  }
  throw new Error("Set PI_WEB_FETCH_TRAFILATURA to the absolute path of a preinstalled trafilatura executable");
}

export async function extractContent(
  html: string, signal?: AbortSignal,
): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> {
  if (signal?.aborted) return { ok: false, error: "Aborted" };
  return new Promise(resolve => {
    const proc = execFile(extractorPath(), ["--markdown", "--formatting"], {
      cwd: getAgentDir(), env: { ...childEnv(), PYTHONIOENCODING: "utf-8" },
      timeout: 10_000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL", signal,
    }, (error, stdout) => {
      if (signal?.aborted) resolve({ ok: false, error: "Aborted" });
      else if (error) resolve({ ok: false, error: `Trafilatura extraction failed: ${error.code ?? error.signal ?? "unknown error"}` });
      else if (!stdout.trim()) resolve({ ok: false, error: "Trafilatura extracted no content from the page" });
      else resolve({ ok: true, markdown: stdout.trim() });
    });
    // The CLI can exit before reading HTML (including on abort or launch error).
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(html);
  });
}
