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
  const missing = /Model openai\/gpt-6\.2-sol not found\. Available ids for openai: .*gpt-6\.1-sol/;
  await assert.rejects(openHost(config), missing);
  assert.deepEqual(await readdir(dir), []);

  await writeFile(config.modelsStore, "{");
  await assert.rejects(openHost(config), missing);
  await writeFile(config.modelsStore, JSON.stringify({ "openai": { models: null, lastModified: Date.now() } }));
  await assert.rejects(openHost(config), missing);
  await writeFile(config.modelsStore, JSON.stringify({
    "openai": {
      models: [{ ...openaiProvider().getModels()[0], id: "gpt-6.2-sol" }],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? Date.now()) - 1,
    },
  }));
  await assert.rejects(openHost(config), missing);
  await assert.rejects(openHost({ ...config, provider: "unknown" }), /Available ids for unknown: \(none\)/);
});

test("the default model is the openai provider's, taken from the cached catalog", async t => {
  const dir = await fixture(t);
  const config = readConfig(fixtureEnv(dir, { AIPATTY_FAUX: "0" }));
  assert.deepEqual([config.provider, config.model], ["openai", "gpt-6.2-sol"]);
  const bundled = (await openModels(config)).getModel("openai", "gpt-6.1-sol");
  assert.ok(bundled);
  await assert.rejects(openHost(config), /Model openai\/gpt-6\.2-sol not found/);

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
