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
     "budget": { "repairRounds": 1 }
   }
   ```

   Commands are argument arrays and run without a shell. `budget.repairRounds` is optional: 0, 1 or 2, default 1.

2. Commit a workflow that calls the factory, for example `.github/workflows/factory.yml`:

   ```yaml
   name: factory
   on:
     workflow_dispatch:
       inputs:
         issue:
           description: Number of the task issue to build
           required: true
           type: number
   concurrency:
     group: factory-${{ inputs.issue }}
     cancel-in-progress: false
   permissions: {}
   jobs:
     run:
       permissions:
         contents: write
         pull-requests: write
         issues: write
       uses: amasaun/factory/.github/workflows/run.yml@main
       with:
         issue: ${{ fromJSON(inputs.issue) }}
       secrets:
         CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
   ```
3. Add the repository secret `CLAUDE_CODE_OAUTH_TOKEN`, generated with `claude setup-token`.
4. Settings → Actions → General → Workflow permissions: allow GitHub Actions to create pull requests.
5. If the repository's organization restricts which actions and workflows may run, allow `amasaun/factory`.

## Starting a run

1. Open an issue whose body contains a task block: the marker `<!-- factory-task:v1 -->` followed directly by one fenced `json` block holding the task contract (`schemas/task.schema.json`).
2. From the Actions tab, start the `factory` workflow on the default branch and give it the issue number.

Starting the workflow is the approval. Only a login listed under `approvers` may do it, and the task text is fixed at that moment: the run records its digest, and later edits to the issue do not affect the run.

## What a run does

A run is `admit`, `baseline`, one or more attempts, then `finish`.

| Job | Trust | What it does |
|---|---|---|
| `admit` | trusted | Checks the model credential is configured, the approver and the task; records the first events on the issue. |
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

## Cost

Measured on the first successful run (a small task, accepted on the first attempt):

- **GitHub Actions:** 7 jobs, each under a minute and each billed as one minute. A repair attempt adds up to 4 jobs. Jobs that are skipped use nothing.
- **Claude usage:** the builder (Sonnet) reported the equivalent of about $0.05 at list prices and the judge (Opus) about $0.09. With a subscription token this counts against the plan's limits; it is not billed per use.

So a repair round costs at most about 4 Actions minutes plus one more builder run and, if its tests pass, one more judge run. Setting `budget.repairRounds` to 0 turns repair off.

## Known limits of this version

- **Approval** is "an approver started the workflow". A session holding that person's GitHub login could start it too.
- **Event log identity** is `github-actions[bot]`, so any workflow in the target repository with permission to comment on issues could write events. A dedicated GitHub App fixes this.
- **The builder's model credential** is on the same machine as the code the builder writes and the tests it runs.
- **Workers have unrestricted outbound network access.**
- **No hidden scenarios, mutation testing, revert-the-fix check or secret scanning.** Verification is the repository's own tests plus the judge.
- **CI does not start on the pull request**, because pull requests opened with the workflow's own token do not trigger workflows. The run therefore ends in `ci-pending`.
- **Repair is bounded and simple.** At most two repair rounds, the same builder model every time, and no escalation to a stronger model.
- **One run per task issue.** A second run on the same issue is refused.
- **Models are named by alias** (`sonnet` for the builder, `opus` for the judge), not pinned versions.
