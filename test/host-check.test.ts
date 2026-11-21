import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { get } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { startApi } from "../src/api.ts";
import { openHost } from "../src/host.ts";
import { fixture, fauxConfig } from "./helpers.ts";

test("HTTP and WS require a loopback name and the listener port, and a same-origin Origin if there is one", async t => {
  const agent = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(agent, { ok: true, startedAt: "now", version: "test", commit: "test" }, 0);
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
    const name = `localhost:${api.port}`;
    assert.equal(await probe({ Host: base }), ok);
    assert.equal(await probe({ Host: base, Origin: `http://${base}` }), ok);
    assert.equal(await probe({ Host: name, Origin: `http://${name}` }), ok);
    assert.equal(await probe({ Host: `LOCALHOST:${api.port}` }), ok);
    // Another site's name pointed at this address, as in DNS rebinding.
    assert.equal(await probe({ Host: `other.test:${api.port}` }), 403);
    // The far end of an SSH forward must use the same port number.
    assert.equal(await probe({ Host: "localhost:1" }), 403);
    assert.equal(await probe({ Host: "localhost" }), 403);
    // A cross-site request, and one from another origin on this machine.
    assert.equal(await probe({ Host: base, Origin: "http://other.test" }), 403);
    assert.equal(await probe({ Host: name, Origin: `http://${base}` }), 403);
    assert.equal(await probe({ Host: base, Origin: `https://${base}` }), 403);
  }
});

test("the server listens on loopback only", async t => {
  const agent = await openHost(fauxConfig(await fixture(t)));
  const api = await startApi(agent, { ok: true, startedAt: "now", version: "test", commit: "test" }, 0);
  t.after(async () => { await api.close(); await agent.harness.close(ctx); });
  assert.deepEqual(api.address, { address: "127.0.0.1", family: "IPv4", port: api.port });
});
