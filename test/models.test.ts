import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { readConfig } from "../src/config.ts";
import { openHost } from "../src/host.ts";
import { openModels } from "../src/models.ts";
import { fixture, fixtureEnv } from "./helpers.ts";

test("newer pi CLI catalog entries are overlaid by model type and id, offline and read-only", async t => {
  const dir = await fixture(t);
  const config = readConfig(fixtureEnv(dir, { AIPATTY_FAUX: "0" }));
  const bundled = openaiProvider().getModels().find(model => model.id === "gpt-6.1-sol");
  assert.ok(bundled);
  const added = { ...bundled, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" };
  const override = { ...bundled, name: "Updated Sol" };
  const snapshot = JSON.stringify({
    "openai": {
      models: [added, override, { id: "malformed" }, { ...added, provider: "elsewhere" }],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 1_000,
      etag: '"catalog-fixture"',
      checkedAt: Date.now(),
    },
  });
  await writeFile(config.modelsStore, snapshot);
  const models = await openModels(config);
  assert.deepEqual(models.getModel("openai", "gpt-6.2-sol"), added);
  assert.deepEqual(models.getModel("openai", bundled.id), override);
  assert.ok(models.getModel("openai", "gpt-6.1-terra"));
  assert.equal(models.getModel("openai", "malformed"), undefined);

  const host = await openHost(config);
  try {
    const root = await host.conversation("root");
    assert.deepEqual((await root?.agent(ctx))?.model, { provider: "openai", modelId: "gpt-6.2-sol" });
  } finally {
    await host.harness.close(ctx);
  }
  assert.equal(await readFile(config.modelsStore, "utf8"), snapshot);
  assert.ok(!(await readdir(dir)).includes("auth.json"));
});

test("missing, malformed and stale catalog snapshots fall back to bundled models", async t => {
  const dir = await fixture(t);
  const config = readConfig(fixtureEnv(dir, { AIPATTY_FAUX: "0" }));
  async function unavailable() {
    const host = await openHost(config);
    assert.deepEqual(await host.modelStatus(), { modelStatus: "unavailable", model: { provider: "openai", modelId: "gpt-6.2-sol" } });
    await host.harness.close(ctx);
  }
  const logged = t.mock.method(console, "error", () => {});
  const ignored = () => logged.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith("Ignoring model catalog"));
  await unavailable();
  assert.deepEqual(ignored(), [], "a missing catalog is the normal fresh install");
  await writeFile(config.modelsStore, "{");
  await unavailable();
  await writeFile(config.modelsStore, "[]");
  await unavailable();
  assert.equal(ignored().length, 2);
  assert.ok(ignored().every(line => line.startsWith(`Ignoring model catalog ${config.modelsStore}: `)), ignored().join("\n"));
  assert.match(ignored()[1], /expected a JSON object$/);
  await writeFile(config.modelsStore, JSON.stringify({ "openai": { models: null, lastModified: Date.now() } }));
  await unavailable();
  await writeFile(config.modelsStore, JSON.stringify({
    "openai": {
      models: [{ ...openaiProvider().getModels()[0], id: "gpt-6.2-sol" }],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) - 1,
    },
  }));
  await unavailable();
  const existing = await openHost({ ...config, provider: "unknown" });
  assert.equal((await existing.modelStatus()).model?.provider, "openai");
  await existing.harness.close(ctx);
});

test("the default model is the openai provider's, taken from the cached catalog", async t => {
  const dir = await fixture(t);
  const config = readConfig(fixtureEnv(dir, { AIPATTY_FAUX: "0" }));
  assert.deepEqual([config.provider, config.model], ["openai", "gpt-6.2-sol"]);
  const bundled = (await openModels(config)).getModel("openai", "gpt-6.1-sol");
  assert.ok(bundled);
  const host = await openHost(config);
  assert.equal((await host.modelStatus()).modelStatus, "unavailable");
  await host.harness.close(ctx);

  await writeFile(config.modelsStore, JSON.stringify({
    openai: {
      models: [
        { ...bundled, id: "gpt-6.2-sol" },
        { ...bundled, id: "other-api", api: "not-served-by-this-provider" },
        { ...bundled, id: "classifier", type: "classifier" },
      ],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) + 1_000,
    },
  }));
  const models = await openModels(config);
  assert.equal(models.getModel("openai", "gpt-6.2-sol")?.api, bundled.api);
  assert.equal(models.getModel("openai", "other-api"), undefined);
  assert.equal(models.getModel("openai", "classifier"), undefined);
});
