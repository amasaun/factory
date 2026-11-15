import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readUsage, usageSection } from "../src/run/usage.ts";

const builderResult = {
  total_cost_usd: 0.0502352,
  modelUsage: { "claude-sonnet-5-5": { costUSD: 0.0502352 } },
  factory: { segments: [{ peak: 11_589, turns: 13 }], handoffs: 0 },
};

test("usage is read from the model CLI's result output", () => {
  assert.deepEqual(readUsage("builder", 1, builderResult), {
    role: "builder", attempt: 1, models: ["claude-sonnet-5-5"], usd: 0.0502352, sessions: 1, peakContext: 11_589,
  });
  assert.deepEqual(readUsage("judge", 1, { total_cost_usd: 0.0878, modelUsage: { "claude-opus-5-5": {} } }), {
    role: "judge", attempt: 1, models: ["claude-opus-5-5"], usd: 0.0878,
  });
});

test("missing, malformed or hostile usage data becomes 'not reported', never an error or markup", () => {
  for (const junk of [null, undefined, "x", [], {}, { total_cost_usd: "free" }, { total_cost_usd: -5 }, { total_cost_usd: Number.NaN }]) {
    assert.equal(readUsage("builder", 1, junk).usd, null);
  }
  // A worker job produces the builder's file, so its text is not trusted.
  const hostile = readUsage("builder", 1, { modelUsage: { "x` | [link](https://evil.example) | <img>": {} } });
  assert.deepEqual(hostile.models, ["xlinkhttpsevil.exampleimg"]);
  assert.ok(!usageSection([hostile]).includes("]("));
});

test("the usage section totals what was reported and says how to read it", () => {
  const text = usageSection([
    readUsage("builder", 1, builderResult),
    readUsage("judge", 1, { total_cost_usd: 0.0878, modelUsage: { "claude-opus-5-5": {} } }),
    readUsage("builder", 2, null),
  ]);
  assert.ok(text.includes("| 1 | builder | `claude-sonnet-5-5` | $0.05 | 1 session(s), peak context 11589 tokens |"));
  assert.ok(text.includes("| 1 | judge | `claude-opus-5-5` | $0.09 |"));
  assert.ok(text.includes("| 2 | builder | not reported | not reported |"));
  assert.ok(text.includes("Total reported: $0.14 (some sessions did not report)"));
  assert.ok(text.includes("not billed per use"));
  assert.equal(usageSection([]), "No usage was reported.");
});

test("on main, every internal workflow reference points at main, so a release can rewrite them all", () => {
  for (const file of ["run.yml", "attempt.yml"]) {
    const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const refs = text.split("\n").filter((l) => /uses: amasaun\/factory\//.test(l));
    assert.ok(refs.length > 0, file);
    for (const line of refs) assert.match(line, /@main\s*$/, `${file}: ${line.trim()}`);
  }
});

test("the release script tags a commit whose internal references all name the release", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-release-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const sh = (...args: string[]) => execFileSync(args[0]!, args.slice(1), { cwd: dir, env, encoding: "utf8" }).trim();
  const root = new URL("..", import.meta.url).pathname;
  for (const path of [".github", "scripts"]) cpSync(join(root, path), join(dir, path), { recursive: true });
  sh("git", "init", "-q", "-b", "main");
  sh("git", "add", "-A");
  sh("git", "commit", "-q", "-m", "base");
  const main = sh("git", "rev-parse", "HEAD");

  assert.throws(() => sh("bash", "scripts/release.sh", "1.0"), /usage/);
  sh("bash", "scripts/release.sh", "v1.2.3");

  // main is untouched; the tag is one commit on top of it.
  assert.equal(sh("git", "rev-parse", "HEAD"), main);
  assert.equal(sh("git", "rev-parse", "v1.2.3^"), main);
  assert.equal(sh("git", "status", "--porcelain"), "");
  for (const file of ["run.yml", "attempt.yml"]) {
    const tagged = sh("git", "show", `v1.2.3:.github/workflows/${file}`);
    assert.ok(!/uses: amasaun\/factory\/.*@main/.test(tagged), file);
    assert.match(tagged, /uses: amasaun\/factory\/actions\/setup@v1\.2\.3/);
  }
  assert.match(sh("git", "show", "v1.2.3:.github/workflows/run.yml"), /workflows\/attempt\.yml@v1\.2\.3/);
  assert.throws(() => sh("bash", "scripts/release.sh", "v1.2.3"), /already exists/);
});
