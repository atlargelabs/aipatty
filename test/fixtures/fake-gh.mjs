#!/usr/bin/env node
// A stand-in for `gh`: answers `pr view` and `issue view` from `fake-gh.json` in the working directory.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [kind, verb, number] = process.argv.slice(2);
appendFileSync("fake-gh-calls.txt", process.argv.slice(2).join(" ") + "\n");
let known = {};
try {
  known = JSON.parse(readFileSync("fake-gh.json", "utf8"));
} catch {}
if (known.waitFor) while (!existsSync(known.waitFor)) await sleep(10);
if (known.delayMs) await sleep(known.delayMs);
if (kind === "api") {
  // `api repos/<owner>/<name>/issues/<n>/events`: the PR's timeline events.
  const issue = /\/issues\/(\d+)\/events/.exec(verb)?.[1];
  const page = Number(/[?&]page=(\d+)/.exec(verb)?.[1] ?? 1);
  process.stdout.write(JSON.stringify((known[`events ${issue}`] ?? []).slice((page - 1) * 100, page * 100)));
  process.exit(0);
}
// A list of answers is given out in order, the last one repeating.
let found = known[`${kind} ${number}`];
if (Array.isArray(found)) {
  const asked = readFileSync("fake-gh-calls.txt", "utf8").split("\n").filter(call => call.startsWith(`${kind} view ${number} `)).length;
  found = found[Math.min(asked, found.length) - 1];
}
if (verb !== "view" || !found) {
  process.stderr.write(`GraphQL: Could not resolve to a ${kind} with the number of ${number}.\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(found));
