/**
 * Run a golden set:
 *
 *   node src/evals/cli.ts tickets [--trials 3] [--model sonnet] [--max-usd 2]
 *   node src/evals/cli.ts judge   [--trials 2] [--model opus]   [--max-usd 4]
 *
 * Common options: --only id,id   --dry-run   --yes   --out file
 *
 * A real run spends model usage. It prints an estimate first and needs --yes
 * to go ahead; --dry-run shows the estimate and stops.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { askEvaluator } from "../run/ask-evaluator.ts";
import { askJudge, buildJudgePrompt } from "../run/ask-judge.ts";
import { DEFAULT_EVALUATION, DEFAULT_JUDGE_USD } from "../run/config.ts";
import { loadJudgeCases, renderJudgeReport, runJudge } from "./judge.ts";
import { estimate, loadCases, renderReport, runTickets } from "./tickets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Per-suite defaults. The cost per call is measured on real runs and used only for the estimate. */
const SUITES = {
  tickets: { trials: "3", model: DEFAULT_EVALUATION.model as string, maxUsd: "2", usdPerCall: 0.025 },
  judge: { trials: "2", model: "opus", maxUsd: "4", usdPerCall: 0.1 },
} as const;

const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};

const suite = process.argv[2] as keyof typeof SUITES;
if (!(suite in SUITES)) fail("usage: evals/cli.ts <tickets|judge> [--trials n] [--model name] [--only id,...] [--max-usd n] [--dry-run] [--yes] [--out file]");
const defaults = SUITES[suite];

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    trials: { type: "string", default: defaults.trials },
    model: { type: "string", default: defaults.model },
    only: { type: "string" },
    "max-usd": { type: "string", default: defaults.maxUsd },
    "dry-run": { type: "boolean" },
    yes: { type: "boolean" },
    out: { type: "string" },
  },
});
const trials = Number(values.trials);
const maxUsd = Number(values["max-usd"]);
const model = values.model!;
if (!Number.isInteger(trials) || trials < 1 || trials > 10) fail("--trials must be 1 to 10");
if (!(maxUsd > 0)) fail("--max-usd must be above 0");

function pick<T extends { id: string }>(all: T[]): T[] {
  if (!values.only) return all;
  const wanted = new Set(values.only.split(","));
  const chosen = all.filter((c) => wanted.has(c.id));
  if (chosen.length !== wanted.size) fail("--only names a case that does not exist");
  return chosen;
}

/** Print the estimate, and stop unless the person has said to spend. */
function confirm(line: string) {
  console.error(`${line}, capped at $${maxUsd.toFixed(2)}.`);
  if (values["dry-run"]) process.exit(0);
  if (!values.yes) fail("This spends model usage. Re-run with --yes to go ahead, or --dry-run to see the estimate only.");
}

const env = { ...process.env };
for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) if (!env[key]) delete env[key];
const cost = (result: Record<string, unknown> | null) => (typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null);
const save = (report: unknown) => {
  if (!values.out) return;
  writeFileSync(values.out, JSON.stringify({ suite, model, trials, report }, null, 2));
  console.error(`full results written to ${values.out}`);
};

if (suite === "tickets") {
  const cases = pick(loadCases(join(ROOT, "evals/tickets")));
  const e = estimate(cases, trials, defaults.usdPerCall);
  confirm(`${cases.length} case(s): ${e.free} decided by plain checks at no cost, ${e.modelCalls} model call(s) on ${model}, about $${e.usd.toFixed(2)}`);
  const report = await runTickets(cases, {
    trials,
    maxUsd,
    thresholds: { minMean: DEFAULT_EVALUATION.minScore, minArea: DEFAULT_EVALUATION.minAreaScore },
    ask: (task) => {
      const a = askEvaluator(task, { root: ROOT, command: process.env.FACTORY_CLAUDE, model, usd: DEFAULT_EVALUATION.usd, env });
      return { output: a.output, usd: cost(a.result) };
    },
    onTrial: (c, t, i) => console.error(`  ${c.id} #${i + 1}: ${t.verdict}, average ${t.evaluation.mean}`),
  });
  console.log(renderReport(report, { model, trials }));
  save(report);
} else {
  const cases = pick(loadJudgeCases(join(ROOT, "evals/judge/cases")));
  confirm(`${cases.length} case(s): ${cases.length * trials} model call(s) on ${model}, about $${(cases.length * trials * defaults.usdPerCall).toFixed(2)}`);
  const report = await runJudge(cases, {
    trials,
    maxUsd,
    baseRepo: join(ROOT, "evals/judge/base"),
    ask: (c, m) => {
      const a = askJudge({ root: ROOT, repoDir: m.baseDir, prompt: buildJudgePrompt(ROOT, c.task, m.diff), command: process.env.FACTORY_CLAUDE, model, usd: DEFAULT_JUDGE_USD, env });
      return { output: a.output, usd: cost(a.result) };
    },
    onTrial: (c, t, i) => console.error(`  ${c.id} #${i + 1}: ${t.verdict} (judge said ${t.decision})`),
  });
  console.log(renderJudgeReport(report, { model, trials }));
  save(report);
}
