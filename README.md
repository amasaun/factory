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
| Resume, hidden scenarios, mutation gates, CI observation, review feedback, plugin | Not started |

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
src/cli.ts              entry points for the pipeline's jobs
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
