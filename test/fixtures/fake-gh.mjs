#!/usr/bin/env node
// A stand-in for `gh`: answers `pr view` and `issue view` from `fake-gh.json` in the working directory.
import { appendFileSync, readFileSync } from "node:fs";

const [kind, verb, number] = process.argv.slice(2);
appendFileSync("fake-gh-calls.txt", process.argv.slice(2).join(" ") + "\n");
let known = {};
try {
  known = JSON.parse(readFileSync("fake-gh.json", "utf8"));
} catch {}
const found = known[`${kind} ${number}`];
if (verb !== "view" || !found) {
  process.stderr.write(`GraphQL: Could not resolve to a ${kind} with the number of ${number}.\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(found));
