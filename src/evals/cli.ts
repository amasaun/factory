/**
 * Run a golden set: node src/evals/cli.ts tickets [--trials 3] [--model sonnet] [--only id,...] [--max-usd 2] [--dry-run] [--out file]
 *
 * A real run spends model usage. It prints an estimate first and needs --yes
 * to go ahead; --dry-run shows the estimate and stops.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { askEvaluator } from "../run/ask-evaluator.ts";
import { DEFAULT_EVALUATION } from "../run/config.ts";
import { estimate, loadCases, renderReport, runTickets } from "./tickets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Measured on real runs: one scoring call on Sonnet. Used only for the estimate. */
const USD_PER_CALL = 0.025;

const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};

const suite = process.argv[2];
if (suite !== "tickets") fail("usage: evals/cli.ts tickets [--trials 3] [--model sonnet] [--only id,...] [--max-usd 2] [--dry-run] [--yes] [--out file]");

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    trials: { type: "string", default: "3" },
    model: { type: "string", default: DEFAULT_EVALUATION.model },
    only: { type: "string" },
    "max-usd": { type: "string", default: "2" },
    "dry-run": { type: "boolean" },
    yes: { type: "boolean" },
    out: { type: "string" },
  },
});
const trials = Number(values.trials);
const maxUsd = Number(values["max-usd"]);
if (!Number.isInteger(trials) || trials < 1 || trials > 10) fail("--trials must be 1 to 10");
if (!(maxUsd > 0)) fail("--max-usd must be above 0");

let cases = loadCases(join(ROOT, "evals/tickets"));
if (values.only) {
  const wanted = new Set(values.only.split(","));
  cases = cases.filter((c) => wanted.has(c.id));
  if (cases.length !== wanted.size) fail("--only names a case that does not exist");
}
const e = estimate(cases, trials, USD_PER_CALL);
console.error(`${cases.length} case(s): ${e.free} decided by plain checks at no cost, ${e.modelCalls} model call(s) on ${values.model}, about $${e.usd.toFixed(2)}, capped at $${maxUsd.toFixed(2)}.`);
if (values["dry-run"]) process.exit(0);
if (!values.yes) fail("This spends model usage. Re-run with --yes to go ahead, or --dry-run to see the estimate only.");

const env = { ...process.env };
for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) if (!env[key]) delete env[key];

const report = await runTickets(cases, {
  trials,
  maxUsd,
  thresholds: { minMean: DEFAULT_EVALUATION.minScore, minArea: DEFAULT_EVALUATION.minAreaScore },
  ask: (task) => {
    const a = askEvaluator(task, { root: ROOT, command: process.env.FACTORY_CLAUDE, model: values.model!, usd: DEFAULT_EVALUATION.usd, env });
    const usd = typeof a.result?.total_cost_usd === "number" ? a.result.total_cost_usd : null;
    return { output: a.output, usd };
  },
  onTrial: (c, t, i) => console.error(`  ${c.id} #${i + 1}: ${t.verdict}, average ${t.evaluation.mean}`),
});
const text = renderReport(report, { model: values.model!, trials });
console.log(text);
if (values.out) {
  writeFileSync(values.out, JSON.stringify({ model: values.model, trials, report }, null, 2));
  console.error(`full results written to ${values.out}`);
}
