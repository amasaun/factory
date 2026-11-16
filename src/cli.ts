/**
 * Command-line entry points for the pipeline's jobs. Each command does one
 * job's worth of work and reads its inputs from the environment and from files
 * handed over as artifacts. Trusted commands (admit, freeze, finish) never run
 * repository code; `verify` runs it and so only ever runs in a worker job.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./control/digest.ts";
import { GitHubLedger } from "./control/github-ledger.ts";
import { advance } from "./control/ledger.ts";
import { extractTask } from "./control/issue-task.ts";
import type { FactoryEvent } from "./control/run.ts";
import type { Task } from "./control/task.ts";
import { GitHub } from "./github/rest.ts";
import { type FrozenCandidate, intakeCandidate } from "./publisher/candidate.ts";
import { git } from "./publisher/git.ts";
import { ensurePullRequest, pushCandidate } from "./publisher/publish.ts";
import { runBuilder } from "./run/builder.ts";
import { MAX_HANDOFFS, type RepoConfig, parseConfig } from "./run/config.ts";
import { askEvaluator } from "./run/ask-evaluator.ts";
import { evaluateTicket, evaluationComment, failsWithoutModel } from "./run/evaluate.ts";
import { type Attempt, type StageResult, admissionEvents, planEvents } from "./run/plan.ts";
import { allowedBashRules, builderPrompt, clipFeedback, handoffSection, judgePrompt, pullRequestBody, pullRequestTitle } from "./run/render.ts";
import { type SessionUsage, readUsage, usageSection } from "./run/usage.ts";
import { type Decision, type Verdict, decide, verdictProblems } from "./run/verdict.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Environment for the model CLI. Whichever credential the repository supplied
 * is passed on; an empty variable is removed, because the CLI treats an API key
 * that is present but empty as the credential to use.
 */
function modelEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) if (!e[key]) delete e[key];
  if (!e.ANTHROPIC_API_KEY && !e.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("no model credential is available to this job");
  return e;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
const output = (key: string, value: string) => appendFileSync(env("GITHUB_OUTPUT"), `${key}=${value}\n`);
const summary = (text: string) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
};
function outFile(name: string): string {
  const dir = env("FACTORY_OUT");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}
/** A file inside a downloaded artifact; each artifact is a directory under FACTORY_IN. */
const art = (artifact: string, file: string) => join(env("FACTORY_IN"), artifact, file);
const attemptNumber = () => {
  const n = Number(env("FACTORY_ATTEMPT"));
  if (!Number.isInteger(n) || n < 1) throw new Error("FACTORY_ATTEMPT must be a positive integer");
  return n;
};

interface Admitted {
  issue: number;
  task: Task;
  taskDigest: string;
  policyDigest: string;
  base: string;
  /** Average score from the ticket evaluation. */
  ticketScore?: number;
}

/** Labels the factory puts on a task issue to show where it stands. */
const STATUS_LABELS = { inProgress: "factory:in-progress", review: "factory:review", attention: "factory:needs-attention" } as const;
const readAdmitted = (): Admitted => JSON.parse(readFileSync(art("task", "task.json"), "utf8"));

/** Policy is always read from a named commit, never from the working tree a worker may have changed. */
function configAt(repoDir: string, commit: string): RepoConfig {
  return parseConfig(git(repoDir, ["show", `${commit}:.factory/config.json`]));
}

function github(): { gh: GitHub; ledger: GitHubLedger } {
  const gh = new GitHub({ token: env("GITHUB_TOKEN"), repo: env("GITHUB_REPOSITORY"), apiUrl: process.env.GITHUB_API_URL || undefined });
  return { gh, ledger: new GitHubLedger(gh, env("FACTORY_APP_LOGIN")) };
}

async function record(ledger: GitHubLedger, taskId: string, events: FactoryEvent[]) {
  let state;
  for (const event of events) state = await advance(ledger, taskId, event);
  return state;
}

const commands: Record<string, () => Promise<void> | void> = {
  async admit() {
    const repoDir = env("FACTORY_REPO_DIR");
    const issueNumber = Number(env("FACTORY_ISSUE"));
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("the issue number is not valid");
    const actor = env("FACTORY_ACTOR");
    const defaultBranch = env("FACTORY_DEFAULT_BRANCH");
    const runUrl = env("FACTORY_RUN_URL");
    const repository = env("GITHUB_REPOSITORY");
    if (env("GITHUB_REF") !== `refs/heads/${defaultBranch}`) {
      throw new Error(`runs must be started from ${defaultBranch}, not ${env("GITHUB_REF")}`);
    }
    const base = git(repoDir, ["rev-parse", "HEAD"]).trim();
    const config = configAt(repoDir, base);
    if (config.baseBranch !== defaultBranch) throw new Error(`policy base branch ${config.baseBranch} is not ${defaultBranch}`);

    const { gh, ledger } = github();
    // Nothing has been recorded yet, so a refusal leaves the ticket free to be fixed and started again.
    const refuse = async (reason: string, detail = ""): Promise<never> => {
      await gh.removeLabel(issueNumber, config.triggerLabel);
      await gh.create(issueNumber, `The factory did not start this task: ${reason}\n\n${detail}\n\nNothing was recorded, so it can be started again once this is resolved. (${runUrl})`.replace(/\n\n\n+/g, "\n\n"));
      throw new Error(`not started: ${reason}`);
    };

    if (!config.approvers.includes(actor)) await refuse(`${actor} is not listed as an approver in .factory/config.json.`);
    const issue = await gh.getIssue(issueNumber);
    if (issue.isPullRequest) throw new Error(`#${issueNumber} is a pull request, not a task issue`);
    if (issue.state !== "open") throw new Error(`task issue #${issueNumber} is ${issue.state}`);
    const extracted = extractTask(issue.body);
    if (!extracted.ok) await refuse("the issue does not contain a valid task.", (extracted as { problems: string[] }).problems.map((p) => `- ${p}`).join("\n"));
    const task = (extracted as { task: Task }).task;
    if ((await ledger.read(String(issueNumber))).length > 0) {
      throw new Error(`task #${issueNumber} already has a run; a new attempt needs a new task issue`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const workflowFile = (env("GITHUB_WORKFLOW_REF").split("@")[0] ?? "").split("/").pop() ?? "";
    // The count includes this run.
    const runsToday = await gh.countWorkflowRuns(workflowFile, today);
    if (runsToday > config.runsPerDay) {
      await refuse(`this repository has reached its limit of ${config.runsPerDay} factory runs for today (budget.runsPerDay).`);
    }

    // The ticket evaluation. With something missing the ticket has already failed, so the model is not asked.
    let modelOutput: unknown = null;
    if (!failsWithoutModel(task, repository)) {
      let answer;
      try {
        answer = askEvaluator(task, { root: ROOT, command: process.env.FACTORY_CLAUDE, model: config.evaluation.model, usd: config.evaluation.usd, env: modelEnv() });
      } catch (e) {
        writeFileSync(outFile("evaluation-result.json"), (e as { raw?: string }).raw ?? "");
        throw e;
      }
      writeFileSync(outFile("evaluation-result.json"), answer.raw);
      modelOutput = answer.output;
      if (answer.result) {
        const u = readUsage("evaluator", 0, answer.result);
        const spend = u.usd === null ? "not reported" : `${u.usd.toFixed(4)} US dollars`;
        console.log(`Ticket evaluator: ${u.models.join(", ") || "model not reported"}, estimated spend ${spend}.`);
      }
    }
    const evaluation = evaluateTicket(task, repository, modelOutput, { minMean: config.evaluation.minScore, minArea: config.evaluation.minAreaScore });
    summary(evaluationComment(evaluation, { passed: "Ticket evaluation passed.", failed: "Ticket evaluation did not pass." }));
    if (!evaluation.passed) {
      await refuse(
        "the ticket evaluation did not pass.",
        evaluationComment(evaluation, { passed: "", failed: "Improve the areas scoring low, then add the label again." }),
      );
    }

    const admitted: Admitted = {
      issue: issueNumber,
      task,
      taskDigest: digest(task),
      policyDigest: digest(config),
      base,
      ticketScore: evaluation.mean,
    };
    const events = admissionEvents({ actor, taskDigest: admitted.taskDigest, base, runUrl });
    events[0]!.cause += `; ticket evaluation ${evaluation.mean} of 5`;
    await record(ledger, String(issueNumber), events);
    await gh.addLabels(issueNumber, [STATUS_LABELS.inProgress]);
    writeFileSync(outFile("task.json"), JSON.stringify(admitted, null, 2));
    output("base", base);
    output("max_attempts", String(1 + config.repairRounds));
    summary(`Admitted task #${issueNumber} at base \`${base}\`, started by ${actor}.`);
  },

  /**
   * Run the repository's setup and test commands. Executes repository code:
   * worker jobs only. On failure the output is saved as feedback for a repair.
   */
  verify() {
    const repoDir = env("FACTORY_REPO_DIR");
    const config = configAt(repoDir, env("FACTORY_BASE"));
    for (const argv of [...config.commands.setup, ...config.commands.test]) {
      console.log(`$ ${argv.join(" ")}`);
      const r = spawnSync(argv[0]!, argv.slice(1), {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "true" },
      });
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      process.stdout.write(text);
      if (r.status !== 0) {
        const how = r.error ? r.error.message : `exit ${r.status ?? r.signal}`;
        console.error(`command failed (${how}): ${argv.join(" ")}`);
        if (process.env.FACTORY_OUT) {
          writeFileSync(outFile("feedback.md"), clipFeedback(`The command \`${argv.join(" ")}\` failed (${how}) when run against your change in a fresh checkout. Its output:\n\n${text}`));
        }
        process.exit(1);
      }
    }
  },

  "builder-prompt"() {
    const admitted = readAdmitted();
    const attempt = attemptNumber();
    const config = configAt(env("FACTORY_REPO_DIR"), admitted.base);
    const template = readFileSync(join(ROOT, "prompts/builder.md"), "utf8");
    let repair: { attempt: number; feedback: string } | undefined;
    if (attempt > 1) {
      const path = art(`feedback-${attempt - 1}`, "feedback.md");
      repair = { attempt, feedback: existsSync(path) ? readFileSync(path, "utf8") : "" };
    }
    writeFileSync(outFile("builder-prompt.md"), builderPrompt(template, admitted.task, config.commands.test, repair));
    writeFileSync(outFile("builder-allowed.txt"), `${allowedBashRules(config.commands.test).join("\n")}\n`);
    writeFileSync(outFile("commit-message.txt"), `${pullRequestTitle(admitted.task)}\n\nTask: #${admitted.issue}\n`);
  },

  /** Run the builder, handing off to a fresh one if its context grows past the limit. Worker jobs only. */
  async build() {
    const admitted = readAdmitted();
    const repoDir = env("FACTORY_REPO_DIR");
    const config = configAt(repoDir, admitted.base);
    const prompt = readFileSync(join(env("FACTORY_OUT"), "builder-prompt.md"), "utf8");
    const rules = readFileSync(join(env("FACTORY_OUT"), "builder-allowed.txt"), "utf8").split("\n").filter(Boolean);
    const report = await runBuilder({
      command: process.env.FACTORY_CLAUDE || "claude",
      args: [
        "-p", "--safe-mode", "--permission-mode", "acceptEdits", "--permission-prompts", "none",
        "--tools", "Read,Edit,Write,Glob,Grep,Bash",
        "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", ...rules,
        "--model", env("MODEL"), "--max-turns", "40", "--no-session-persistence",
        "--max-budget-usd", String(config.builderUsd),
        "--output-format", "stream-json", "--verbose",
      ],
      cwd: repoDir,
      env: modelEnv(),
      prompt,
      // The working tree is read with plain git here: it belongs to the worker, and nothing in it is trusted.
      handoffPrompt: (n) => prompt + handoffSection(n, spawnSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }).stdout ?? ""),
      tokenLimit: config.handoffTokens,
      maxHandoffs: MAX_HANDOFFS,
      log: (line) => console.log(line),
    });
    writeFileSync(
      outFile("builder-result.json"),
      JSON.stringify({ ...(report.result ?? {}), factory: { segments: report.segments, handoffs: report.handoffs, limit: report.limit, failure: report.failure } }, null, 2),
    );
    summary(`Builder: ${report.segments.length} session(s), ${report.handoffs} handoff(s), peak context ${Math.max(...report.segments.map((s) => s.peak))} of ${report.limit} tokens.`);
    if (report.failure) throw new Error(report.failure);
  },

  freeze() {
    const admitted = readAdmitted();
    const attempt = attemptNumber();
    const repoDir = env("FACTORY_REPO_DIR");
    const config = configAt(repoDir, admitted.base);
    const c = intake(repoDir, admitted, config, attempt);
    output("tree", c.tree);
    if (c.tree === (process.env.FACTORY_PREVIOUS_TREE || "none")) {
      // Stop here: verifying and judging an identical change again would only repeat the last result.
      output("unchanged", "true");
      output("ok", "false");
      summary(`Attempt ${attempt} is identical to the previous attempt.`);
      return;
    }
    output("unchanged", "false");
    if (c.violations.length > 0) {
      const lines = c.violations.map((v) => `- ${JSON.stringify(v.path)}: ${v.kind} (${v.rule})`);
      for (const v of c.violations) console.error(`::warning::${v.kind}: ${JSON.stringify(v.path)} (${v.rule})`);
      writeFileSync(
        outFile("feedback.md"),
        `Your change was refused before any tests ran, because it touched files it may not touch. Undo these changes completely, including files you created, and stay inside the task's permitted scope:\n\n${lines.join("\n")}\n`,
      );
      output("ok", "false");
      summary(`Attempt ${attempt} refused at intake: ${c.violations.length} violation(s).`);
      return;
    }
    const diff = git(repoDir, ["diff", "--no-ext-diff", "--no-textconv", admitted.base, c.commit]);
    writeFileSync(outFile("frozen.json"), JSON.stringify({ commit: c.commit, tree: c.tree, changedPaths: c.changedPaths }, null, 2));
    writeFileSync(outFile("diff.patch"), diff);
    output("commit", c.commit);
    output("ok", "true");
    summary(`Attempt ${attempt}: frozen candidate \`${c.commit}\` touching ${c.changedPaths.length} path(s).`);
  },

  /** Print what the model CLI returned, so a failure is readable in the job log. */
  "show-result"() {
    const path = join(env("FACTORY_OUT"), process.argv[3] ?? "");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (!text.trim()) {
      console.log("(the model CLI wrote no output)");
      return;
    }
    try {
      const r = JSON.parse(text) as Record<string, unknown>;
      const brief: Record<string, unknown> = {};
      for (const k of ["subtype", "is_error", "num_turns", "total_cost_usd", "modelUsage", "factory"]) if (k in r) brief[k] = r[k];
      console.log(JSON.stringify(brief));
      console.log(typeof r.structured_output === "object" ? JSON.stringify(r.structured_output, null, 2) : String(r.result ?? "(no result text)"));
    } catch {
      console.log(text.slice(0, 4000));
    }
  },

  "judge-prompt"() {
    const admitted = readAdmitted();
    const template = readFileSync(join(ROOT, "prompts/judge.md"), "utf8");
    const diff = readFileSync(art(`frozen-${attemptNumber()}`, "diff.patch"), "utf8");
    writeFileSync(outFile("judge-prompt.md"), judgePrompt(template, admitted.task, diff, randomUUID()));
  },

  /** Run the judge: read-only tools, the base commit as its working directory, the diff as data in its prompt. */
  judge() {
    const repoDir = env("FACTORY_REPO_DIR");
    const config = configAt(repoDir, readAdmitted().base);
    const r = spawnSync(
      process.env.FACTORY_CLAUDE || "claude",
      [
        "-p", "--safe-mode", "--permission-prompts", "none",
        "--tools", "Read,Glob,Grep", "--allowedTools", "Read", "Glob", "Grep",
        "--model", env("MODEL"), "--max-turns", "30", "--no-session-persistence",
        "--max-budget-usd", String(config.judgeUsd),
        "--output-format", "json",
        "--json-schema", readFileSync(join(ROOT, "schemas/verdict.schema.json"), "utf8"),
      ],
      {
        cwd: repoDir,
        env: modelEnv(),
        input: readFileSync(join(env("FACTORY_OUT"), "judge-prompt.md"), "utf8"),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    writeFileSync(outFile("judge-result.json"), r.stdout ?? "");
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`the judge exited with ${r.status ?? r.signal}`);
  },

  /** Read the judge's output and say what it means for the run. Runs in the judge job, which executes no repository code. */
  decide() {
    const admitted = readAdmitted();
    const d = readDecision(admitted.task, join(env("FACTORY_OUT"), "judge-result.json"));
    output("decision", d.decision);
    summary(`Judge: ${d.decision}${d.reasons.length ? ` (${d.reasons.join("; ")})` : ""}.`);
    if (d.decision === "reject" && d.verdict) {
      const unmet = d.verdict.criteria
        .filter((c) => c.result !== "met")
        .map((c) => `- Criterion ${c.id} is ${c.result}: ${c.reasoning}`);
      const blocking = d.verdict.findings
        .filter((f) => f.severity === "blocking")
        .map((f) => `- Blocking finding: ${f.summary}${f.detail ? `\n  ${f.detail}` : ""}`);
      writeFileSync(
        outFile("feedback.md"),
        `Your change passed the repository's tests but an independent reviewer did not accept it:\n\n${[...unmet, ...blocking].join("\n")}\n`,
      );
    }
  },

  async finish() {
    const admitted = readAdmitted();
    const taskId = String(admitted.issue);
    const repoDir = env("FACTORY_REPO_DIR");
    const runUrl = env("FACTORY_RUN_URL");
    const { gh, ledger } = github();
    const flag = (v: string | undefined) => (v === "true" ? true : v === "false" ? false : undefined);

    try {
      const config = configAt(repoDir, admitted.base);
      const maxAttempts = 1 + config.repairRounds;
      const attempts: Attempt[] = [];
      const verdicts: (Verdict | undefined)[] = [];
      const usage: SessionUsage[] = [];
      const setStatus = async (label: string) => {
        await gh.removeLabel(admitted.issue, STATUS_LABELS.inProgress);
        await gh.addLabels(admitted.issue, [label]);
      };
      const readJson = (path: string): unknown => {
        try {
          return JSON.parse(readFileSync(path, "utf8"));
        } catch {
          return null;
        }
      };
      for (let n = 1; n <= maxAttempts; n++) {
        const get = (key: string) => process.env[`A${n}_${key}`] || undefined;
        // If the attempt's jobs failed outright, its outputs may be missing; its overall result still says so.
        const build = (get("BUILD") ?? (get("RESULT") === "failure" ? "failure" : undefined)) as StageResult | undefined;
        if (!build || build === "skipped") break;
        const a: Attempt = {
          build,
          unchanged: flag(get("UNCHANGED")) === true,
          freezeOk: flag(get("FREEZE_OK")),
          candidate: get("COMMIT"),
          verifyPassed: flag(get("VERIFY_PASSED")),
        };
        if (a.verifyPassed !== undefined && get("VERIFY_COMMIT") !== a.candidate) {
          throw new Error(`attempt ${n}: the verified commit is not the frozen candidate`);
        }
        // The decision is read again here from the judge's own output, not taken from another job's summary of it.
        const verdictPath = art(`verdict-${n}`, "judge-result.json");
        if (a.verifyPassed === true && existsSync(verdictPath)) {
          const d = readDecision(admitted.task, verdictPath);
          a.decision = d.decision;
          a.reasons = d.reasons;
          verdicts[n - 1] = d.decision === "accept" ? d.verdict : undefined;
        }
        attempts.push(a);
        usage.push(readUsage("builder", n, readJson(art(`builder-log-${n}`, "builder-result.json"))));
        if (existsSync(verdictPath)) usage.push(readUsage("judge", n, readJson(verdictPath)));
      }

      const evaluatorResult = readJson(art("task", "evaluation-result.json"));
      if (evaluatorResult) usage.unshift(readUsage("evaluator", 0, evaluatorResult));

      const plan = planEvents({
        baseline: (process.env.RESULT_BASELINE || "skipped") as StageResult,
        attempts,
        maxAttempts,
        lease: 1,
        runUrl,
      });

      let candidate: FrozenCandidate | undefined;
      const verdict = plan.publishAttempt === null ? undefined : verdicts[plan.publishAttempt];
      if (plan.publishAttempt !== null) {
        // Intake is repeated here, in the job that will push, so the push never relies on another job's word.
        candidate = intake(repoDir, admitted, config, plan.publishAttempt + 1);
        if (candidate.violations.length > 0) throw new Error("candidate has violations at publication");
        if (candidate.commit !== attempts[plan.publishAttempt]!.candidate) {
          throw new Error("candidate differs from the one frozen, verified and judged");
        }
      }

      await record(ledger, taskId, plan.events);
      if (!candidate || !verdict) {
        await setStatus(STATUS_LABELS.attention);
        await gh.create(admitted.issue, `The factory stopped work on this task after ${attempts.length} attempt(s): ${plan.summary}. (${runUrl})`);
        summary(`Run stopped after ${attempts.length} attempt(s): ${plan.summary}.`);
        process.exitCode = 1;
        return;
      }

      const pushed = pushCandidate({ repoDir, remote: "origin", taskId, candidate, expectedRemote: null });
      const pr = await ensurePullRequest(gh, {
        taskId,
        base: config.baseBranch,
        title: pullRequestTitle(admitted.task),
        body: pullRequestBody({
          task: admitted.task,
          issue: admitted.issue,
          taskDigest: admitted.taskDigest,
          base: admitted.base,
          candidate: candidate.commit,
          tree: candidate.tree,
          changedPaths: candidate.changedPaths,
          verdict,
          testCommands: config.commands.test,
          runUrl,
          attempt: plan.publishAttempt! + 1,
          usage: usageSection(usage),
          ticketScore: admitted.ticketScore,
        }),
      });
      await record(ledger, taskId, [
        { type: "published", candidate: candidate.commit, cause: `pushed to ${pushed.branch}; draft pull request #${pr.number} (${runUrl})` },
      ]);
      await setStatus(STATUS_LABELS.review);
      await gh.create(admitted.issue, `The factory opened draft pull request #${pr.number} for this task. It is ready for review. (${runUrl})`);
      summary(`Published \`${candidate.commit}\` to \`${pushed.branch}\` as draft pull request #${pr.number}, accepted on attempt ${plan.publishAttempt! + 1}.`);
    } catch (e) {
      // Leave a terminal record so the run is never silently stuck, then fail the job.
      const message = e instanceof Error ? e.message : String(e);
      try {
        await record(ledger, taskId, [{ type: "control-error", cause: `${message} (${runUrl})` }]);
      } catch (inner) {
        console.error(`could not record the failure: ${inner instanceof Error ? inner.message : inner}`);
      }
      throw e;
    }
  },
};

function readDecision(task: Task, path: string): { decision: Decision; reasons: string[]; verdict?: Verdict } {
  let structured: unknown;
  try {
    structured = (JSON.parse(readFileSync(path, "utf8")) as { structured_output?: unknown }).structured_output;
  } catch {
    return { decision: "inconclusive", reasons: ["the judge's output could not be read"] };
  }
  const d = decide(task, structured);
  return { ...d, verdict: verdictProblems(task, structured).length === 0 ? (structured as Verdict) : undefined };
}

function intake(repoDir: string, admitted: Admitted, config: RepoConfig, attempt: number): FrozenCandidate {
  return intakeCandidate({
    repoDir,
    bundlePath: art(`candidate-${attempt}`, "candidate.bundle"),
    baseCommit: admitted.base,
    taskId: String(admitted.issue),
    attempt,
    scope: admitted.task.scope,
    extraProtected: config.extraProtected,
  });
}

const name = process.argv[2] ?? "";
const command = commands[name];
if (!command) {
  console.error(`usage: cli.ts <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
try {
  await command();
} catch (e) {
  console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
