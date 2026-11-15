# factory

An autonomous software delivery system for Claude Code. It turns a small, approved task into a draft pull request backed by reproducible verification and independent review. Humans approve intent, review the pull request, and decide whether to merge.

The design is in [docs/spec.md](docs/spec.md).

## Status

Early. A first pipeline exists that takes one approved task issue to a draft pull request on GitHub Actions; see [docs/running.md](docs/running.md) for how to run it and what it does not do yet.

| Area | State |
|---|---|
| State machine and transition table (spec §9) | Implemented, tested |
| Budgets (spec §13) | Implemented, tested; active-time accounting not yet |
| Lease and candidate-identity checks (spec §11, §13) | Implemented, tested |
| Event ledger interface, in-memory backend (spec §3) | Implemented, tested |
| Task contract and approval digests (spec §7) | Implemented, tested |
| Publisher path guards: protected paths and scope (spec §5) | Implemented, tested |
| Event ledger on issue comments (spec §3) | Implemented, tested against a fake client only |
| Milestone 0 proof: a read-only worker token cannot push, create check runs or write events | Workflow `boundary` |
| Other Milestone 0 proofs: egress, model credential, CI secrets, approval channel | Not started |
| Publisher intake: import a worker's Git bundle and check it before any push (spec §4) | Implemented, tested against real temporary repositories |
| Publisher push and draft pull request (spec §9, §15) | Implemented; push tested against real temporary repositories, pull requests against a fake client |
| GitHub REST client and task-issue format | Implemented; tested against a local fake API server, not the real API |
| Pipeline: admit, baseline, build, freeze, verify, judge, publish (`.github/workflows/run.yml`, `attempt.yml`) | Implemented; one task has been taken from issue to merged pull request on the practice repository |
| Repair loop: a failed attempt goes back to the builder with the reasons (spec §9, §13) | Implemented; every sequence of attempt outcomes is tested against the state machine, and the repair path has been exercised locally but not yet on GitHub |
| Context handoff: a builder that passes its context limit is stopped and a fresh one continues | Implemented; tested against a stand-in for the model CLI, not yet triggered on a real run |
| Either model credential (API key or subscription token), per-session spending caps, model usage in the pull request, numbered releases | Implemented; the spending cap and credential handling are checked locally, the rest by tests |
| Claude Code plugin: `/factory:init`, `/factory:spec`, `/factory:run`, `/factory:status` ([docs/plugin.md](docs/plugin.md)) | Implemented; the helpers are tested and status has been run against a real repository, the commands themselves have not yet been used in a Claude Code session |
| Ticket evaluation before any build, and starting work by adding a label to the task issue | Implemented; the admit step is tested end to end against stand-ins for GitHub and the model, not yet run on GitHub |
| Golden sets for the ticket evaluator (17 labelled tickets) and the judge (13 labelled code changes), with a harness that reports wrong decisions and disagreement between identical runs ([evals/README.md](evals/README.md)) | Implemented; labels have had a first-pass review, and neither set has been run against a real model |
| Golden set for the builder, starting from a Jira or Linear ticket, resume, hidden scenarios, mutation gates, CI observation, review feedback | Not started |

## Use it from Claude Code

```
/plugin marketplace add amasaun/factory
/plugin install factory@amasaun-factory
```

Then `/factory:init` in a repository to set it up, `/factory:spec` to write a task, and `/factory:status` to see every run. See [docs/plugin.md](docs/plugin.md).

## Layout

```text
docs/spec.md            the specification
schemas/                JSON schemas for factory documents
src/control/
  states.ts             states, triggers and the transition table
  budget.ts             invocation limits and accounting
  run.ts                run state as a fold over events
  ledger.ts             event log interface and in-memory backend
  github-ledger.ts      event log stored as issue comments
  guards.ts             protected-path and scope checks for candidates
  task.ts               task contract validation and approval binding
  digest.ts             canonical JSON digests
  issue-task.ts         the task block inside a task issue
src/github/
  rest.ts               minimal GitHub REST client for the trusted side
src/run/
  config.ts             repository policy file
  plan.ts               events to record for a run's outcome
  verdict.ts            validation and reading of the judge's verdict
  render.ts             prompts and pull request body
  builder.ts            runs the builder, watches its context size and hands off
  usage.ts              model usage for the pull request
  evaluate.ts           the ticket evaluation: plain checks, scoring and the pass rule
scripts/release.sh      create a numbered release
src/evals/              golden-set harness
evals/                  golden sets: labelled cases and how to run them
src/cli.ts              entry points for the pipeline's jobs
src/plugin-cli.ts       helpers behind the plugin's commands
src/plugin/             GitHub access through gh, status across repositories, setup files
skills/                 the plugin's commands
.claude-plugin/         plugin and marketplace manifests
prompts/                builder and judge prompts
actions/setup/          makes the factory's code available to a job
src/publisher/
  git.ts                hardened git invocation for the trusted side
  candidate.ts          candidate intake from a worker's Git bundle
  publish.ts            push to factory/<task> and keep one draft pull request
test/                   node:test suites
```

## Development

Requires Node 22.18 or later; CI and the pipeline run on Node 26, the current LTS. TypeScript runs directly through Node's type stripping, so there is no build step.

```bash
npm ci
```

```bash
npm test
```

```bash
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
