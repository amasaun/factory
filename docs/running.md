# Running the factory on a repository

This describes the current pipeline version. It takes one approved task issue and, if an attempt is accepted, opens one draft pull request. A failed attempt can be sent back to the builder. There is no resume or plugin command yet.

## One-time setup of a target repository

1. Commit `.factory/config.json`:

   ```json
   {
     "version": 1,
     "baseBranch": "main",
     "approvers": ["your-login"],
     "commands": { "setup": [], "test": [["node", "--test"]] },
     "extraProtected": [],
     "budget": { "repairRounds": 1, "handoffTokens": 150000, "builderUsd": 1, "judgeUsd": 0.5, "runsPerDay": 10 },
     "evaluation": { "model": "sonnet", "minScore": 4.5, "minAreaScore": 4 }
   }
   ```

   Commands are argument arrays and run without a shell. Every `budget` and `evaluation` setting is optional; the values shown are the defaults. See "Cost" below for what they do.

2. Commit a workflow that calls the factory, for example `.github/workflows/factory.yml`:

   ```yaml
   name: factory
   on:
     issues:
       types: [labeled]
     workflow_dispatch:
       inputs:
         issue:
           description: Number of the task issue to build
           required: true
           type: string
   concurrency:
     group: factory-${{ github.event.issue.number || inputs.issue }}
     cancel-in-progress: false
   permissions: {}
   jobs:
     run:
       if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'factory'
       permissions:
         contents: write
         pull-requests: write
         issues: write
         actions: read
       uses: amasaun/factory/.github/workflows/run.yml@v0.2.0
       with:
         issue: ${{ format('{0}', github.event.issue.number || inputs.issue) }}
       secrets:
         CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
         ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

   Name a release (`@v0.2.0`), not `@main`: the repository then runs exactly that version of every part of the factory until someone changes the line. Releases are listed on the factory repository's tags page.
3. Add one model credential as a repository secret (Settings → Secrets and variables → Actions → Repository secrets):
   - `ANTHROPIC_API_KEY`: an Anthropic API key, billed per use to whoever owns the key; or
   - `CLAUDE_CODE_OAUTH_TOKEN`: a Claude subscription token generated with `claude setup-token`, which counts against that subscription's limits.

   The credential belongs to whoever should pay for the work. If both are set, the API key is used. The names must match exactly.
4. Settings → Actions → General → Workflow permissions: allow GitHub Actions to create pull requests.
5. If the repository's organization restricts which actions and workflows may run, allow `amasaun/factory`.

## Starting a run

1. Write a task issue. Its body carries the task twice: written out for people, and as a data block the factory reads (the marker `<!-- factory-task:v1 -->` followed by one fenced `json` block, schema in `schemas/task.schema.json`). `/factory:spec` in the [Claude Code plugin](plugin.md) writes both from one source.
2. Have a person review it.
3. Add the `factory` label to the issue. The run starts at once, whatever state the issue is in.

Adding the label is the approval. Only a login listed under `approvers` counts, and the task text is fixed at that moment: the run records its digest, and later edits to the issue do not affect the run. A run can also be started by hand from the Actions tab with the issue number; the same checks apply.

## The ticket evaluation

Before anything is recorded or built, the factory checks that the ticket says enough to be built well. It scores seven areas from 1 to 5:

| Area | What is looked for |
|---|---|
| Description | A short, clear `summary`. |
| User story | `story`: who it is for, what they want, and why. |
| Acceptance criteria | Each criterion has a Given / When / Then in `gherkin`, with concrete values and exact expected results. |
| Test cases | `testCases` exist, are concrete, and every criterion is covered by at least one. |
| Repository | `repository` names this repository, and the permitted scope is narrow and consistent with the goal. |
| Impact on other areas | `impactedAreas` names other parts of the system, teams or users affected. |
| Ready to build | Taken as a whole, enough for a careful engineer to build it without guessing. |

A ticket passes with an average of at least 4.5 and no area below 4 (`evaluation.minScore` and `evaluation.minAreaScore`).

The check has two layers. Plain code looks for what is missing or malformed: no test cases, a criterion without Given / When / Then, the wrong repository. Any such gap fixes that area at 1, and the model is not asked at all, so a ticket with a gap costs nothing to refuse. Otherwise one model session, with no tools and nothing to read but the ticket, scores the quality of each area. The model is `evaluation.model`, `sonnet` by default; `haiku` is cheaper.

When a ticket does not pass, the factory removes the label, comments on the issue with each area's score and reason, and records nothing, so the ticket can be improved and labelled again. Scores from a model vary a little from one run to the next, so a ticket close to the threshold may pass on one try and not the next.

## Status on the issue

The factory marks the task issue as it goes: `factory:in-progress` when work starts, `factory:review` when the draft pull request is open, `factory:needs-attention` when it stopped without one. It also comments at each of those points.

## What a run does

A run is `admit`, `baseline`, one or more attempts, then `finish`.

| Job | Trust | What it does |
|---|---|---|
| `admit` | trusted; holds the model credential for the ticket evaluation | Checks the approver, the daily run limit and the task, runs the ticket evaluation, and only then records the first events on the issue. |
| `baseline` | worker | Runs the test commands on the base commit. |
| `build` | worker, holds the model credential | Runs Claude Code as the builder, then bundles the working tree as one commit. |
| `freeze` | trusted | Imports the bundle and checks its shape, scope and protected paths. |
| `verify` | worker, no secrets | Checks out exactly the frozen commit in a fresh machine and runs the test commands. |
| `judge` | holds the model credential, runs no repository code | Runs Claude Code read-only at the base commit with the diff as data, and returns a structured verdict. |
| `finish` | trusted, the only job that can write | Repeats intake for the accepted attempt, checks the verified and judged commit is the same one, records events, pushes `factory/<issue>` and opens the draft pull request. |

Trusted jobs never execute code from the target repository. Worker jobs hold a read-only token.

The run's history is the sequence of `factory event` comments on the task issue.

## Repair

`build`, `freeze`, `verify` and `judge` together are one attempt. When an attempt fails for a reason the builder can act on, the next attempt starts from the previous attempt's changes and is told why it was not accepted:

| Previous attempt ended with | The builder is given |
|---|---|
| Intake refused it (out of scope or a protected path) | The list of offending paths |
| The test commands failed | The failing command and the end of its output |
| The judge rejected it | The unmet criteria and blocking findings, with the judge's reasoning |

Rules that keep repair from wasting runs:

- A repair whose result is identical to the previous attempt stops the run before it is verified or judged again.
- The judge only runs on a candidate that passed the test commands.
- An inconclusive verdict, a builder that produced nothing, or a broken job is not repaired. The run stops and says why.
- When the attempts allowed by `budget.repairRounds` are used up, the run stops in `needs-human`.

Each attempt's candidate is a single commit on top of the base, so only the accepted attempt's changes appear in the pull request.

## Context handoff

A long builder session costs more on every turn, because the whole conversation is read again each time, and its work gets less reliable. Keeping tasks small is the real fix. As a backstop, the pipeline watches how much context the builder has used:

- The limit is `budget.handoffTokens`, or half the model's context window if that is lower.
- When a builder passes the limit it is stopped before its next action. A fresh builder then starts with the full task, the list of files changed so far, and those changes in the working tree, and is told to continue, not start over.
- After two handoffs in one attempt the run stops and reports that the task is too large and should be split.

A handoff happens inside one attempt and does not use up a repair round. On a small task it never triggers and costs nothing. The judge is a single read-only pass and is not monitored.

## Cost

Every pull request the factory opens has a "Model usage" section listing, per attempt, the model used and the model CLI's estimate of what the builder and the judge cost.

Measured on small tasks accepted on the first attempt:

- **GitHub Actions:** 7 jobs, each under a minute and each billed as one minute to the owner of the repository where the run happens. A repair attempt adds up to 4 jobs. Skipped jobs use nothing.
- **Model usage:** about $0.05 for the builder (Sonnet) and $0.09 for the judge (Opus) at list prices. With an API key that is what is billed. With a subscription token it counts against the plan's limits and is not billed per use.

The `budget` settings bound a run:

| Setting | Default | Effect |
|---|---|---|
| `repairRounds` | 1 | How many times a failed attempt may go back to the builder (0 to 2). |
| `builderUsd` | 1 | A builder session that passes this estimated spend is stopped and the run ends. |
| `judgeUsd` | 0.5 | The same for a judge session. |
| `handoffTokens` | 150000 | Context size at which the builder is replaced by a fresh one. |
| `runsPerDay` | 10 | Runs that may start in the repository per UTC day. A label added after the limit is refused. |
| `evaluation.usd` | 0.25 | Spending cap for the ticket evaluation's one model session. |

The caps are per model session and are estimates made by the model CLI, checked after each model response, so a session can end slightly above its cap. With the defaults, the most a run with one repair round can spend on models is about 2 × ($1 + $0.50) = $3, or more if a builder is handed off, since each fresh session has its own cap. Typical runs are far below that.

## Releases

On `main`, the factory's workflows refer to each other at `@main`. `scripts/release.sh vX.Y.Z` makes one commit on top of `main` in which those references name the release, and tags it, so a repository that pins `@vX.Y.Z` gets every part of the factory from that release. Use `@main` only for trying out unreleased changes.

## Known limits of this version

- **Approval** is "an approver added the label". A session holding that person's GitHub login could add it too.
- **The trigger is a GitHub issue label.** Starting from a Jira or Linear ticket is not built yet.
- **Event log identity** is `github-actions[bot]`, so any workflow in the target repository with permission to comment on issues could write events. A dedicated GitHub App fixes this.
- **The builder's model credential** is on the same machine as the code the builder writes and the tests it runs.
- **Workers have unrestricted outbound network access.**
- **No hidden scenarios, mutation testing, revert-the-fix check or secret scanning.** Verification is the repository's own tests plus the judge.
- **CI on the factory's pull request waits for a person.** GitHub holds workflow runs caused by the workflow's own token. Closing and reopening the pull request starts CI under your account. The run's event log therefore ends in `ci-pending`; a dedicated GitHub App would let CI start by itself.
- **Repair is bounded and simple.** At most two repair rounds, the same builder model every time, and no escalation to a stronger model.
- **One run per task issue.** A second run on the same issue is refused.
- **Models are named by alias** (`sonnet` for the builder, `opus` for the judge), not pinned versions. The pull request records which model actually ran.
