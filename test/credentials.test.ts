import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FileCredentialStore } from "../src/credentials.ts";
import { checkout, fixture } from "./helpers.ts";

const oauth = { type: "oauth" as const, access: "fake-access", refresh: "fake-refresh", expires: 0, accountId: "fake" };
const other = { type: "api_key", key: "fake" };

test("read/list of an absent auth file neither creates it nor its parent", async t => {
  const dir = await fixture(t);
  const store = new FileCredentialStore(join(dir, "missing", "auth.json"));
  assert.equal(await store.read("openai"), undefined);
  assert.deepEqual(await store.list(), []);
  await store.delete("openai");
  assert.deepEqual(await readdir(dir), []);
});

test("credentials preserve other providers, serialize updates, and atomically write private files", async t => {
  const dir = await fixture(t);
  const path = join(dir, "auth.json");
  await writeFile(path, "\uFEFF" + JSON.stringify({ other }), { mode: 0o644 });
  const first = new FileCredentialStore(path);
  const second = new FileCredentialStore(path);
  const original = await stat(path);
  await first.modify("openai", async () => oauth);
  assert.deepEqual(await second.read("openai"), oauth);
  assert.notEqual((await stat(path)).ino, original.ino);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).modify("openai", async current => {
    assert.equal(current?.type, "oauth");
    await sleep(5);
    return { ...current, count: Number(current.count ?? 0) + 1 };
  })));
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored["openai"].count, 8);
  assert.deepEqual(stored.other, other);
  await first.delete("openai");
  assert.deepEqual(await first.list(), [{ providerId: "other", type: "api_key" }]);
  assert.deepEqual(await readdir(dir), ["auth.json"]);
});

test("modify waits for a separate process using the CLI lock, even through an alias", { timeout: 8_000 }, async t => {
  const dir = await fixture(t);
  const path = join(dir, "auth.json");
  const alias = join(dir, "alias.json");
  await writeFile(path, JSON.stringify({ other }));
  await symlink(path, alias);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import lockfile from "proper-lockfile";
    import { writeFile } from "node:fs/promises";
    const path = process.argv[1];
    const release = await lockfile.lock(path, { retries: 0, stale: 30_000 });
    process.on("message", async () => {
      await writeFile(path, JSON.stringify({ other: { type: "api_key", key: "updated-fake" } }));
      await release();
      process.disconnect();
    });
    process.send("locked");
  `, path], { cwd: checkout, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const exit = once(child, "exit");
  t.after(async () => {
    child.kill("SIGKILL");
    await exit;
  });
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(2_000) });
  assert.equal(ready, "locked");
  const store = new FileCredentialStore(alias);
  const cancelled = store.modify("openai", async () => {
    assert.fail("Callback must not run while the child holds the lock");
  }, { signal: AbortSignal.timeout(50) });
  await assert.rejects(cancelled, error => error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));

  let ran = false;
  const waiting = store.modify("openai", async () => {
    ran = true;
    return oauth;
  });
  await sleep(75);
  assert.equal(ran, false);
  child.send("unlock");
  assert.deepEqual(await exit, [0, null]);
  assert.deepEqual(await waiting, oauth);
  assert.deepEqual(await store.read("other"), { type: "api_key", key: "updated-fake" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("modify initializes a missing auth file securely and rejects malformed files without replacing them", async t => {
  const dir = await fixture(t);
  const path = join(dir, "nested", "auth.json");
  const store = new FileCredentialStore(path);
  await store.modify("openai", async () => oauth);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read("openai"), oauth);
  await writeFile(path, "{ broken");
  await assert.rejects(store.modify("openai", async () => oauth), /Invalid auth.json/);
  assert.equal(await readFile(path, "utf8"), "{ broken");
});

test("an API key stored as an environment template or a command is resolved as the pi CLI resolves it", async t => {
  const dir = await fixture(t);
  const path = join(dir, "auth.json");
  const count = join(dir, "count");
  const entries = {
    literal: { type: "api_key", key: "sk-plain" },
    scoped: { type: "api_key", key: "$AIPATTY_TEST_KEY", env: { AIPATTY_TEST_KEY: "from-credential" } },
    ambient: { type: "api_key", key: "pre-${AIPATTY_TEST_KEY}-post" },
    escaped: { type: "api_key", key: "$$5 $!x ${not a name} $" },
    unset: { type: "api_key", key: "$AIPATTY_TEST_UNSET" },
    command: { type: "api_key", key: `!echo run >> '${count}'; printf ' from-command\\n'` },
    failing: { type: "api_key", key: `!echo run >> '${count}.failed'; exit 3` },
    silent: { type: "api_key", key: "!true" },
    keyless: { type: "api_key", env: { REGION: "x" } },
    oauth,
  };
  await writeFile(path, JSON.stringify(entries));
  process.env.AIPATTY_TEST_KEY = "from-process";
  t.after(() => { delete process.env.AIPATTY_TEST_KEY; });
  const store = new FileCredentialStore(path);
  const key = async (providerId: string) => (await store.read(providerId) as { key?: string }).key;

  assert.equal(await key("literal"), "sk-plain");
  assert.equal(await key("scoped"), "from-credential");
  assert.equal(await key("ambient"), "pre-from-process-post");
  assert.equal(await key("escaped"), "$5 !x ${not a name} $");
  assert.deepEqual(await store.read("keyless"), entries.keyless);
  assert.deepEqual(await store.read("oauth"), oauth);
  await assert.rejects(store.read("unset"), /API key for unset in .*auth\.json: environment variable AIPATTY_TEST_UNSET not set/);

  // A successful command runs once per process; a failure is reported without the command text and retried.
  assert.deepEqual(await Promise.all([key("command"), key("command")]), ["from-command", "from-command"]);
  assert.equal(await key("command"), "from-command");
  assert.equal(await readFile(count, "utf8"), "run\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(store.read("failing"), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /API key for failing in .*auth\.json: command failed \(exit 3\)$/);
      assert.ok(!error.message.includes("echo"));
      return true;
    });
  }
  assert.equal(await readFile(`${count}.failed`, "utf8"), "run\nrun\n");
  await assert.rejects(store.read("silent"), /command printed nothing/);

  // A rewrite sees and keeps the stored form, never the resolved secret.
  await store.modify("command", async current => {
    assert.deepEqual(current, entries.command);
    return { ...current, env: { NOTE: "kept" } } as typeof current;
  });
  assert.equal(JSON.parse(await readFile(path, "utf8")).command.key, entries.command.key);
  assert.deepEqual(await store.list(), Object.keys(entries).map(providerId => (
    { providerId, type: providerId === "oauth" ? "oauth" : "api_key" }
  )));
});
