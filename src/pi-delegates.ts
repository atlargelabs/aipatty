import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const patch = fileURLToPath(new URL("../patches/pi-delegates-a66e6d8.patch", import.meta.url));

/** Pi's loader and its children use the same staged entry. Never patch the release or a shared setting. */
export async function stageDelegates(
  entry: string, workspace: string, logRoot: string, git: (args: string[], cwd: string) => Promise<unknown>,
): Promise<string> {
  if (!isAbsolute(logRoot)) throw new Error("The managed delegate log root must be absolute");
  const stage = join(workspace, "managed-delegates");
  await mkdir(stage, { mode: 0o700 });
  const source = join(stage, "src");
  await cp(dirname(entry), source, { recursive: true, errorOnExist: true, force: false });
  try {
    // Apply against the copy, even if runsDir happens to be inside a Git checkout.
    await git(["--git-dir=./.no-git", "apply", "--no-index", patch], stage);
  } catch (error) {
    throw new Error(`Could not apply the managed pi-delegates patch to ${entry}; check the release's pinned dependency: ${error}`);
  }
  // Both paths come from the host, not tool arguments, settings or the repository being worked on.
  await writeFile(join(source, "aipatty-run.ts"), `export const logRoot = ${JSON.stringify(logRoot)};\n`, { mode: 0o600, flag: "wx" });
  return join(source, basename(entry));
}
