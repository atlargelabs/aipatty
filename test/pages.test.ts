import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { pagePath, pagesLibraryApi, pagesPath, pagesPreviewScript, publishPageTool, type PageSection } from "../src/pages/shared.ts";
import { maxHtmlBytes } from "../src/pages/store.ts";
import { messageText } from "../src/protocol.ts";
import { fauxPages } from "./fixtures/pages.ts";
import { fauxConfig, fixture } from "./helpers.ts";

const health = { ok: true as const, commit: "test", startedAt: "now", version: "0" };

test("Pages is available at startup in every branch, with durable immutable content and a separate library", { timeout: 30_000 }, async t => {
  const dir = await fixture(t);
  const config = fauxConfig(dir);
  const faux = fauxPages();
  let host = await openHost(config, { models: faux.models });
  const start = () => startApi(host, health, 0, { tailscaleOrigin: "https://mini.example.ts.net:8443" });
  let api = await start();
  const base = () => `http://127.0.0.1:${api.port}`;
  const request = (path: string, init?: RequestInit) => fetch(base() + path, init);
  const close = async () => { await api.close(); await host.close(); };
  t.after(close);
  const restart = async () => {
    await close();
    host = await openHost(config, { models: faux.models });
    api = await start();
  };
  const sections = async () => {
    const response = await request(pagesLibraryApi);
    assert.equal(response.status, 200);
    return (await response.json() as { sections: PageSection[] }).sections;
  };
  const edit = (body: object, method = "POST", headers?: Record<string, string>) => request(pagesLibraryApi, {
    method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  });
  const raw = (path: string, headers?: Record<string, string>) => new Promise<number | undefined>((resolve, reject) => {
    get({ host: "127.0.0.1", port: api.port, path, headers }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });

  assert.ok((await stat(join(dir, "pages.sqlite"))).isFile());
  assert.deepEqual(await sections(), [{ id: 1, name: "Unsorted", pages: [] }]);
  const chat = await request("/");
  assert.match(await chat.text(), /href="\/pages">Pages</);
  assert.match(chat.headers.get("content-security-policy")!, /frame-src 'self'/);
  assert.equal((await request(pagesPath)).status, 200);
  assert.equal((await request(pagesPreviewScript)).status, 200);
  const independent = String((await host.newBranch("Independent branch")).id);
  assert.deepEqual(await host.branchApps((await host.conversation(independent))!), []);

  const title = "The same title <test>";
  const contents = ["<!doctype html><h1>One</h1>", "<!doctype html><h1>Two</h1>", "<!doctype html><h1>Three</h1>"];
  const publish = (branch: string, index: number, interactive?: boolean) =>
    faux.publish(host, branch, { title, html: contents[index], ...(interactive === undefined ? {} : { interactive }) });
  const first = await publish("root", 0);
  const second = await publish(independent, 1, true);
  assert.notEqual(first.page.id, second.page.id);
  for (const [index, { page, text }] of [first, second].entries()) {
    const path = pagePath(page.id);
    assert.equal(page.title, title);
    assert.equal(page.mode, index ? "interactive" : "static");
    assert.ok(text.includes(path));
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), contents[index]);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const csp = response.headers.get("content-security-policy")!;
    assert.equal(csp.split("; ")[0], index ? "sandbox allow-scripts" : "sandbox");
    for (const restriction of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'"]) {
      assert.ok(csp.includes(restriction));
    }
    assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
    assert.equal((await request(path, { method: "HEAD" })).headers.get("content-length"), String(Buffer.byteLength(contents[index])));
    assert.equal((await request(path, { method: "POST" })).status, 405);
  }
  for (const args of [{ title: " ", html: contents[0] }, { title, html: "🟢".repeat(maxHtmlBytes / 4 + 1) }]) {
    const { result } = await faux.runPublish(host, "root", args);
    assert.ok(result?.role === "toolResult" && result.isError);
    assert.match(messageText(result), /Expected (a page title|non-empty HTML)/);
  }

  for (const path of [pagesPath, "/apps/gym/"]) {
    const response = await request(path);
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.doesNotMatch(response.headers.get("content-security-policy")!, /frame-src/);
  }
  assert.equal(await raw(pagePath(first.page.id), { Host: "mini.example.ts.net:8443", Origin: "https://mini.example.ts.net:8443" }), 200);
  assert.equal(await raw(pagesPath, { Host: "other.example.ts.net:8443" }), 403);
  for (const path of [pagesPath, pagesLibraryApi, pagePath(first.page.id)]) {
    assert.equal((await request(path, { headers: { Origin: "null" } })).status, 403);
  }
  for (const path of ["/pages/ai-patty-usage", "/pages/%2e%2e/health", "/pages/%2Fetc%2Fhosts/", "/pages/a/../library.json"]) {
    assert.equal(await raw(path), 404);
  }
  assert.equal((await edit({ id: "../aipatty.sqlite" }, "DELETE")).status, 400);
  assert.equal((await edit({ id: first.page.id }, "DELETE", { Origin: "null" })).status, 403);
  assert.equal((await edit({ id: first.page.id }, "DELETE", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await request(pagesLibraryApi, { method: "OPTIONS" })).status, 405);
  assert.deepEqual(await sections(), [{ id: 1, name: "Unsorted", pages: [first.page, second.page] }]);

  assert.equal((await edit({ action: "create", name: "Reports" }, "POST", { Origin: base() })).status, 200);
  const [, reports] = await sections();
  for (const { page } of [first, second]) {
    assert.equal((await edit({ action: "move", id: page.id, section: reports.id })).status, 200);
  }
  assert.equal((await edit({ action: "step", id: second.page.id, direction: "up" })).status, 200);
  await restart();
  assert.deepEqual(await sections(), [
    { id: 1, name: "Unsorted", pages: [] },
    { ...reports, pages: [second.page, first.page] },
  ]);
  assert.equal(await (await request(pagePath(first.page.id))).text(), contents[0]);
  const third = await publish(independent, 2);
  assert.equal((await edit({ id: first.page.id }, "DELETE")).status, 200);
  await restart();
  assert.deepEqual(await sections(), [
    { id: 1, name: "Unsorted", pages: [third.page] },
    { ...reports, pages: [second.page] },
  ]);
  assert.equal((await request(pagePath(first.page.id))).status, 404);
  assert.ok(JSON.stringify(await (await request("/api/conversations/root")).json()).includes(pagePath(first.page.id)), "deleting does not change the transcript");
});

test("an unopenable Pages database leaves chat running", async t => {
  const dir = await fixture(t);
  const db = join(dir, "pages.sqlite");
  await mkdir(db);
  const log = t.mock.method(console, "error", () => {});
  const faux = fauxPages();
  const host = await openHost(fauxConfig(dir), { models: faux.models });
  const api = await startApi(host, health, 0);
  t.after(async () => { await api.close(); await host.close(); });
  const base = `http://127.0.0.1:${api.port}`;
  assert.equal(log.mock.calls[0]?.arguments[0], `Pages unavailable at ${db}:`);
  assert.ok((await stat(db)).isDirectory());
  assert.equal((await fetch(base + pagesPath)).status, 404);
  const chat = await fetch(base);
  assert.equal(chat.status, 200);
  assert.doesNotMatch(await chat.text(), /href="\/pages"/);
  assert.doesNotMatch(chat.headers.get("content-security-policy")!, /frame-src/);
  assert.doesNotMatch(await (await fetch(base + "/app.js")).text(), /\/pages\/preview\.js/);
  const { tools } = await faux.turn(host, "root");
  assert.ok(!tools.some(tool => tool.name === publishPageTool));
});
