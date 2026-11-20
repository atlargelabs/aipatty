import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { get } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { fixture, fauxConfig } from "./helpers.ts";

test("HTTP and WS require a configured host and listener port even without an Origin", async t => {
  const agent = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(agent, { ok: true, startedAt: "now", version: "test", commit: "test" }, "127.0.0.1", 0, ["mini.test"]);
  t.after(async () => { await api.close(); await agent.harness.close(ctx); });
  const base = `127.0.0.1:${api.port}`;
  function http(headers: Record<string, string>) {
    return new Promise<number | undefined>((resolve, reject) => {
      get(`http://${base}/health`, { headers }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
  }
  function stream(headers: Record<string, string>) {
    return new Promise<number | undefined>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/api/conversations/root/stream`, { headers });
      ws.once("error", reject);
      ws.once("open", () => { resolve(101); ws.close(); });
      ws.once("unexpected-response", (req, res) => { resolve(res.statusCode); req.destroy(); });
    });
  }
  for (const [probe, ok] of [[http, 200], [stream, 101]] as const) {
    const alias = `mini.test:${api.port}`;
    assert.equal(await probe({ Host: base }), ok);
    assert.equal(await probe({ Host: alias, Origin: `http://${alias}` }), ok);
    assert.equal(await probe({ Host: `other.test:${api.port}` }), 403);
    assert.equal(await probe({ Host: "mini.test:1" }), 403);
    assert.equal(await probe({ Host: alias, Origin: `http://${base}` }), 403);
  }
});

test("a wildcard listen address needs trusted hosts, and a zoned IPv6 address is refused by name", async t => {
  const agent = await openHost(fauxConfig(await fixture(t)));
  t.after(() => agent.harness.close(ctx));
  const start = (host: string, aliases: string[] = []) =>
    startApi(agent, { ok: true, startedAt: "now", version: "test", commit: "test" }, host, 0, aliases);
  for (const host of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]) {
    await assert.rejects(start(host), /Listening on every address \(.*\) needs AIPATTY_TRUSTED_HOSTS/);
  }
  await assert.rejects(start("fe80::1%lo0"), /Expected an IPv6 address without a zone: fe80::1%lo0/);
  await assert.rejects(start("127.0.0.1", ["fe80::1%lo0"]), /without a zone/);
});
