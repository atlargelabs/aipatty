import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readConfig } from "../src/config.ts";

for (const input of ["relative root", "~/aipatty root", "~", "/opt/aipatty root"]) {
  test(`install root resolves ${JSON.stringify(input)} and keeps pinned code release-relative`, () => {
    const root = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : resolve(input);
    const config = readConfig(["--install-dir", input], {});
    const legacy = readConfig([], {});
    assert.deepEqual([config.dataDir, config.pi.agentDir, config.workDir, config.runsDir],
      ["data", "pi", "work", "runs"].map(name => join(root, name)));
    assert.equal(config.authFile, join(root, "pi/auth.json"));
    assert.equal(config.modelsStore, join(root, "pi/models-store.json"));
    assert.equal(config.pi.cli, legacy.pi.cli);
    assert.equal(config.pi.extension, legacy.pi.extension);
    assert.equal(config.pi.reviewExtension, legacy.pi.reviewExtension);
    const faux = readConfig([`--install-dir=${input}`], { AIPATTY_FAUX: "1" });
    assert.equal(faux.dataDir, join(root, "faux"));
    assert.deepEqual([faux.pi, faux.workDir, faux.runsDir], [config.pi, config.workDir, config.runsDir]);
  });
}

test("each explicit path overrides just its root-derived default, regardless of option order or faux mode", () => {
  const root = resolve("installation root");
  const overrides = [
    ["data-dir", "relative data", resolve("relative data")],
    ["pi-dir", "~/other pi", join(homedir(), "other pi")],
    ["work-dir", "/tmp/other work", "/tmp/other work"],
    ["runs-dir", "relative runs", resolve("relative runs")],
  ] as const;
  for (const env of [{}, { AIPATTY_FAUX: "1" }]) {
    const base = readConfig(["--install-dir", root], env);
    for (const [name, input, expected] of overrides) {
      for (const args of [[`--${name}`, input, "--install-dir", root], ["--install-dir", root, `--${name}`, input]]) {
        const config = readConfig(args, env);
        assert.deepEqual([config.dataDir, config.pi.agentDir, config.workDir, config.runsDir], [
          name === "data-dir" ? expected : base.dataDir,
          name === "pi-dir" ? expected : base.pi.agentDir,
          name === "work-dir" ? expected : base.workDir,
          name === "runs-dir" ? expected : base.runsDir,
        ]);
        assert.equal(config.authFile, join(config.pi.agentDir, "auth.json"));
        assert.equal(config.modelsStore, join(config.pi.agentDir, "models-store.json"));
      }
    }
    const config = readConfig(["--install-dir", root, ...overrides.flatMap(([name, input]) => [`--${name}`, input])], env);
    assert.deepEqual([config.dataDir, config.pi.agentDir, config.workDir, config.runsDir], overrides.map(([, , expected]) => expected));
  }
});

test("the Tailscale option accepts one HTTPS origin, not a URL with credentials, a path, or a wildcard", () => {
  const origin = "https://mini.example.ts.net";
  assert.equal(readConfig([], {}).tailscaleOrigin, undefined);
  for (const input of [origin, origin + "/", origin + ":8443"]) {
    assert.equal(readConfig(["--tailscale-origin", input], {}).tailscaleOrigin, new URL(input).origin);
  }
  for (const input of ["", origin.replace("https:", "http:"), origin + "/chat", origin + "/?x", origin + "/#x",
    "https://user@mini.example.ts.net", "https://*.example.ts.net", "https://mini.example.ts.net.evil.test"]) {
    // The URL parser accepts wildcard-looking hosts, but Serve URLs are single DNS names.
    assert.throws(() => readConfig(["--tailscale-origin", input], {}), /--tailscale-origin must be the HTTPS origin/);
  }
});

test("install root requires a nonblank path and does not introduce an environment setting", () => {
  for (const value of ["", " ", "\t\n"]) {
    assert.throws(() => readConfig(["--install-dir", value], {}), /--install-dir needs a path/);
  }
  assert.throws(() => readConfig(["--install-dir"], {}), /Usage:.*\[--install-dir <path>\]/);
  assert.throws(() => readConfig([], { AIPATTY_INSTALL_DIR: "/tmp/root" }), /Unknown setting AIPATTY_INSTALL_DIR/);
});
