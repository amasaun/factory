import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ContextMonitor, contextTokens, runBuilder } from "../src/run/builder.ts";
import { parseConfig } from "../src/run/config.ts";
import { handoffSection } from "../src/run/render.ts";

const assistant = (context: number, extra = {}) => ({
  type: "assistant",
  message: { usage: { input_tokens: 10, cache_read_input_tokens: context - 20, cache_creation_input_tokens: 5, output_tokens: 5 } },
  ...extra,
});

test("context size counts everything the model has read and written", () => {
  assert.equal(contextTokens({ input_tokens: 2, cache_creation_input_tokens: 2802, cache_read_input_tokens: 649, output_tokens: 4 }), 3457);
  assert.equal(contextTokens({}), 0);
});

test("a handoff is called for once the context reaches the token limit", () => {
  const m = new ContextMonitor(100_000);
  assert.equal(m.observe(assistant(40_000)), false);
  assert.equal(m.observe(assistant(99_999)), false);
  assert.equal(m.observe(assistant(100_000)), true);
  assert.equal(m.peak, 100_000);
  assert.equal(m.turns, 3);
});

test("half the model's window applies when it is lower than the token limit", () => {
  const small = new ContextMonitor(150_000);
  small.observe({ type: "autocompact_state", value: { effective_window: 200_000 } });
  assert.equal(small.limit, 100_000);
  assert.equal(small.observe(assistant(99_000)), false);
  assert.equal(small.observe(assistant(101_000)), true);

  const large = new ContextMonitor(150_000);
  large.observe({ type: "autocompact_state", value: { effective_window: 980_000 } });
  assert.equal(large.limit, 150_000);

  const high = new ContextMonitor(900_000);
  high.observe({ type: "autocompact_state", value: { effective_window: 980_000 } });
  assert.equal(high.limit, 490_000);
});

test("subagent messages, other events and junk do not count towards the limit", () => {
  const m = new ContextMonitor(50_000);
  assert.equal(m.observe(assistant(80_000, { parent_tool_use_id: "toolu_1" })), false);
  for (const e of [null, "text", 5, {}, { type: "system" }, { type: "assistant" }, { type: "assistant", message: {} }]) {
    assert.equal(m.observe(e), false);
  }
  assert.equal(m.peak, 0);
  m.observe({ type: "result", is_error: false, result: "done" });
  assert.equal(m.result?.result, "done");
});

// A stand-in for the model CLI. It streams events the way the real one does:
// a session whose prompt has no handoff section keeps growing until it is
// stopped; a session that was handed off finishes quickly.
const dir = mkdtempSync(join(tmpdir(), "factory-builder-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fake = join(dir, "fake-claude.mjs");
writeFileSync(
  fake,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.env.FAKE_MODE;
const handoffs = (prompt.match(/handoff (\\d+)\\)/) ?? [0, 0])[1];
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ handoffs: Number(handoffs), args: process.argv.slice(2) }) + "\\n");
const say = (e) => console.log(JSON.stringify(e));
const turn = (n) => say({ type: "assistant", message: { usage: { input_tokens: n, output_tokens: 0 } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
say({ type: "autocompact_state", value: { effective_window: 980000 } });
console.log("not json at all");
if (mode === "error") { say({ type: "result", is_error: true, result: "Invalid API key" }); process.exit(1); }
if (mode === "silent") process.exit(0);
const grows = mode === "always-grows" || (mode === "grows-once" && handoffs === 0);
if (grows) {
  for (let n = 10000; ; n += 10000) { turn(n); await sleep(20); }
} else {
  turn(8000); turn(12000);
  say({ type: "result", is_error: false, result: "finished after " + handoffs + " handoff(s)", total_cost_usd: 0.01 });
}
`,
);
chmodSync(fake, 0o755);

const run = (mode: string, tokenLimit = 50_000) => {
  const log = join(dir, `${mode}-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  return runBuilder({
    command: fake,
    args: ["--model", "test"],
    cwd: dir,
    env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: log },
    prompt: "Do the task.",
    handoffPrompt: (n) => `Do the task.${handoffSection(n, " M src/a.js")}`,
    tokenLimit,
    maxHandoffs: 2,
  }).then((report) => ({ report, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
};

test("a builder that stays small runs once and is not interrupted", async () => {
  const { report, calls } = await run("small");
  assert.equal(calls.length, 1);
  assert.equal(report.handoffs, 0);
  assert.equal(report.failure, null);
  assert.deepEqual(report.segments, [{ peak: 12_000, turns: 2, handedOff: false, exitCode: 0 }]);
  assert.equal(report.result?.result, "finished after 0 handoff(s)");
  assert.deepEqual(calls[0].args, ["--model", "test"]);
});

test("a builder that outgrows the limit is stopped and a fresh one finishes the work", async () => {
  const { report, calls } = await run("grows-once");
  assert.deepEqual(calls.map((c) => c.handoffs), [0, 1]);
  assert.equal(report.handoffs, 1);
  assert.equal(report.failure, null);
  assert.equal(report.segments[0]?.handedOff, true);
  // It was stopped at the first message over the limit, not allowed to keep going.
  assert.equal(report.segments[0]?.peak, 50_000);
  assert.equal(report.segments[1]?.handedOff, false);
  assert.equal(report.result?.result, "finished after 1 handoff(s)");
});

test("a builder that keeps outgrowing the limit is stopped for good after two handoffs", async () => {
  const { report, calls } = await run("always-grows");
  assert.equal(calls.length, 3);
  assert.equal(report.handoffs, 3);
  assert.equal(report.result, null);
  assert.match(report.failure ?? "", /too large for one run/);
});

test("a builder that errors or says nothing is reported as a failure, not retried", async () => {
  const errored = await run("error");
  assert.equal(errored.calls.length, 1);
  assert.match(errored.report.failure ?? "", /exited with 1/);
  assert.equal(errored.report.result?.result, "Invalid API key");
  const silent = await run("silent");
  assert.equal(silent.calls.length, 1);
  assert.match(silent.report.failure ?? "", /without a result/);
});

test("the handoff prompt tells the new builder what exists and not to start over", () => {
  const text = handoffSection(2, " M src/a.js\n?? test/a.test.js");
  assert.ok(text.includes("handoff 2"));
  assert.ok(text.includes("Do not start over"));
  assert.ok(text.includes("?? test/a.test.js"));
  assert.ok(handoffSection(1, "").includes("(no changes yet)"));
});

test("the handoff limit comes from repository policy", () => {
  const ok = { version: 1, baseBranch: "main", approvers: ["owner"], commands: { setup: [], test: [["node", "--test"]] } };
  assert.equal(parseConfig(JSON.stringify(ok)).handoffTokens, 150_000);
  assert.equal(parseConfig(JSON.stringify({ ...ok, budget: { handoffTokens: 40_000 } })).handoffTokens, 40_000);
  for (const bad of [0, 19_999, 1.5, "150000"]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...ok, budget: { handoffTokens: bad } })), /handoffTokens/);
  }
});
