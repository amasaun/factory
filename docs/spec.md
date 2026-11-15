# Factory: an autonomous software delivery system for Claude Code

Version: 0.2 — proposed specification, November 14, 2026.

Status: design for implementation. This document does not claim that the factory, runner adapters, or security controls have been built or tested. It replaces version 0.1.

## 0. Changes from 0.1

- **GitHub-native first.** Run state lives in GitHub (issues, an append-only event log, check runs, refs). Trusted control logic runs as short deterministic jobs, not as an always-on service. A dedicated controller service and database are added only when the escalation criteria in §3 are met.
- **Approval is out of band.** Approval happens in a channel the spec session cannot act in (§7).
- **Per-run hidden acceptance scenarios** that the builder never sees (§10).
- **Mutation gates and a defined revert-the-fix check** (§10), plus a flaky-test policy.
- **Human review feedback loop,** foreign commits and closed PRs are now part of the lifecycle (§9, §14).
- **Full transition table** with terminal states and a `needs-human` timeout (§9).
- **Readiness no longer chases the base.** A carry-forward rule replaces unconditional re-judgment (§12), and a review-queue cap limits open factory PRs.
- **Budgets are internally consistent,** with a reserve for integration refresh (§13).
- **CI workflow files are protected by default,** and CI secrets must be unreachable from factory branches (§5).
- **Judge hardening** against prompt injection; the judge can block but never waive (§8, §10).
- **One cloud runner first.** The local runner moves to Milestone 4. Automatic promotion of self-improvements is removed from this specification; proposals with human promotion remain (§17).

## 1. Purpose and success criteria

Factory turns a small, approved software task into a draft pull request backed by reproducible verification and independent acceptance review. It operates autonomously within an approved scope and budget. Humans approve intent, resolve material exceptions, review the pull request, and decide whether to merge.

The primary objective is reliably accepted work with low human effort. Token cost is a constraint and optimization metric, not the primary objective.

The system must:

- Run through Claude Code with deterministic orchestration.
- Run independent tasks concurrently against the same repository.
- Verify continuously during development and independently before delivery, including against acceptance scenarios the builder cannot read.
- Bind evidence to the exact source, environment, and policy evaluated.
- Recover from interrupted workers and interrupted control jobs without duplicate publication.
- Accept human review feedback on its pull requests and respond within the approved scope.
- Stop at critical decisions without asking humans to supervise routine execution.

Initial non-goals: autonomous merge or deployment, production credentials in workers, multi-tenant hosting, multiple cooperating builders within one task, a custom dashboard, a local runner (deferred to Milestone 4), and automatic promotion of changes to the factory itself.

## 2. Product interface

The Claude Code plugin is a thin client. It reads and writes GitHub; it holds no authority of its own. Closing the interactive session must not affect a run.

| Command | Purpose |
|---|---|
| `/factory:spec` | Clarify intent, inspect relevant code, and file a draft task issue. |
| `/factory:run <task-id>` | Request queueing of an approved task. The control plane validates approval. |
| `/factory:status [task-id]` | Show state, evidence, budgets, and required decisions from the issue, PR, and check runs. |
| `/factory:resume <task-id> [--adopt]` | Request reconciliation and continuation of an eligible stopped run. |
| `/factory:cancel <task-id>` | Request cancellation. Evidence is preserved. |
| `/factory:eval [candidate-id]` | Evaluate the installed factory or an isolated improvement proposal. |

No command performs approval. A draft task has no authority until a human approves it through the channel in §7. Requests made through the plugin are validated by the control plane against the actor's permissions; cancel and resume are safe to expose because cancel fails closed and resume cannot reset budgets.

## 3. Architecture and trust boundaries

Four responsibilities are kept separate:

1. **Control plane:** deterministic code that validates approvals, schedules stages, enforces budgets, records events, and decides transitions. It runs as short trusted jobs triggered by GitHub events and by a scheduled reconcile job. It never executes repository code and handles Git objects only as data.
2. **Workers:** disposable sandboxes for building, verification, scenario execution, and judging. They hold no GitHub write credential.
3. **Evidence store:** check runs on the candidate commit, artifacts uploaded by trusted jobs, and the event log.
4. **Publisher:** the only component that writes to Git hosting on behalf of a run. It pushes the authorized candidate and creates or updates one draft PR. It cannot merge or deploy.

### State model

- **Task record:** one GitHub issue per task. The task contract is a canonical JSON block in the issue body.
- **Event log:** append-only `factory-event:v1` comments authored by the factory GitHub App. This log is the authority for run state. Labels are a human-readable view derived from it and carry no authority; a hand-edited label is overwritten on the next reconcile.
- **Claim:** creating the ref `factory/<task-id>` at the recorded base commit is the atomic claim for a run. First creation wins; a second attempt stops.
- **Lease:** each worker stage runs under one job or session ID with a lease generation recorded in the event log. Single-flight per task is enforced with a concurrency group keyed by task ID.
- **Evidence:** a check run on the candidate commit carries the evidence manifest digest and links to artifacts. Binding to the commit is native to the check-run model.
- **Control repository:** a separate private repository holds factory code, enforcement configuration, hidden scenarios, holdouts, and the App's credentials configuration. Target-repository collaborators and workflows have no write access to it, and builder workers have no read access.

Human commands arrive as issue or PR comments in a fixed command syntax, or as PR reviews. The control plane verifies the actor against the approver and operator lists before acting. Comments from the factory App itself are never treated as human commands.

The control plane sits behind a `Ledger` interface so the event log can be replaced without changing transition logic.

### When to add a dedicated controller

Add a long-running controller service and a transactional database only when one of the following is demonstrated in practice:

- Rebuilding state from the event log exceeds API rate limits or takes longer than the reconcile interval.
- Scheduling needs sub-minute latency or global concurrency limits across many repositories.
- Event ordering races are observed that concurrency groups and the claim ref do not prevent.
- A local runner is introduced (Milestone 4), which needs a ledger that works offline; SQLite on a protected volume is the expected choice.

Until then, do not build a workflow platform.

### Trust rules

Repository code, model output, test output, review comments from non-approvers, and worker artifacts are untrusted inputs. Isolation must prevent worker processes from modifying control-plane code, credentials, policies, scenarios, or evidence through any filesystem path, process interface, mounted socket, or network service.

## 4. Runner contract

The adapter implements provision, execute, heartbeat, collect, cancel, and destroy. Requests and results carry task ID, attempt ID, lease generation, and source digest.

Each worker receives:

- A fresh clone or source snapshot at a recorded commit.
- Its own filesystem, process environment, temporary storage, network namespace, and test services.
- A pinned runtime image with bounded CPU, memory, disk, process count, and execution time.
- A clean home directory with no SSH keys, GitHub credentials, cloud credentials, browser profile, or unrelated repositories.
- An explicit network policy for its stage.

Use a VM, microVM, or suitably hardened container sandbox. Do not mount a host Docker socket, broad home directories, privileged host devices, or shared writable Git metadata. Nested containers for test services are a declared runner capability; a task that needs them is not admitted to a runner without it.

**Candidate hand-off.** A worker never pushes. The builder emits its work as a Git bundle artifact. The publisher imports the bundle with hooks, filters, and LFS smudge disabled, verifies that it descends from the recorded base, and applies the scope and protected-path checks before any push.

**Environment reuse.** To avoid repeated cold installs, a trusted provisioning step builds an immutable environment snapshot keyed by runtime image digest and dependency lockfile digest. Builder, verifier, scenario, and judge workers start from that snapshot read-only. Workers never write to a cache that a later run reads.

**Initial runner.** One cloud adapter is implemented first. Candidates are Claude Code cloud sessions with the repository attached read-only, and ephemeral CI runners with egress control. Milestone 0 selects one by testing it against this contract. Failure to provision a compliant runner stops the run; it never falls back to unsandboxed execution.

## 5. Security and capability model

All repository-controlled execution, including setup, formatting, tests, builds, scanners that load project code, scenario targets, and the judge's browser, runs inside a worker.

Network access is denied by default and granted by stage:

- Provisioning may fetch pinned dependencies from approved registries or mirrors.
- The builder may reach the approved model service.
- Verification and scenario execution have no external network access and no model credential. Integration endpoints must be declared; tests that need real third-party secrets are not supported in this version and use fakes or recorded clones.
- The judge may reach the model service; its browser reaches only the run's application and approved test services.
- Only the publisher can write to Git hosting.

**Model credential.** The builder shares a sandbox with generated code, so the model credential it uses must be scoped to the run, capped by call count, and revoked when the stage ends. A raw long-lived key is never present in a worker. Prove the effective capabilities of the chosen mechanism in Milestone 0.

**Protected paths, enforced by the publisher and not configurable by a task:**

- CI and workflow definitions (for example `.github/workflows/**`), CI configuration, and `CODEOWNERS`.
- `.factory/**`, scanner configuration, Git hooks, and Claude Code project settings, hooks, MCP configuration, and plugins.

A candidate touching these is rejected unless the task is an explicitly approved maintenance task whose checks are supplied from outside the proposed change.

**CI secrets.** Candidate test code runs in CI even when workflow files are untouched, so protecting workflow paths is not sufficient. Before the factory is enabled on a repository, one of the following must be proven by test:

- Secrets live in environments restricted to protected branches, and a run on `factory/**` cannot read them; or
- The publisher pushes to a dedicated fork so factory PRs receive fork-level secret isolation.

**Other rules.** Project settings, hooks, and plugins cannot expand permissions; factory-controlled configuration is loaded explicitly. Dependency installation defaults to lifecycle scripts disabled; approved setup procedures still run isolated. Required scanners are pinned; a missing or broken scanner produces an incomplete check, not a weaker fallback. Scan everything that will be published, including new Git history, PR text, and attached evidence. Raw logs are retained with restricted access; only sanitized artifacts are published.

**Kill switch.** A single repository-level setting disables the factory. Every trusted job and the publisher check it before acting.

## 6. Repository policy

Each repository commits `.factory/config.json`. The control plane loads it from the approved base revision, validates its schema, and records its digest. A run cannot activate configuration changes made by its builder.

The configuration declares:

- Base branch, runtime images, concurrency limit, and the review-queue cap (§12).
- Setup, formatting, build, typecheck, test, and static-analysis commands.
- Test discovery, report adapters, and the mapping that identifies test paths.
- Application startup, health probes, test services, and the scenario driver interface.
- Required scanners, sensitive areas, and risk rules.
- Mutation-testing tool, scope, and thresholds by risk level.
- Known-flaky quarantine list.
- Allowed generated files and writable build-output directories.
- Per-stage timeouts, aggregate budgets, and artifact retention.
- Required CI checks.

Commands are executable plus argument arrays where possible. Any shell command is owner-reviewed, runs only in a worker, and receives task data through structured inputs, never string interpolation.

**Risk computation.** Effective risk is the higher of the declared task risk and the computed risk. Computed risk is raised by: paths matching sensitive areas; changes to dependency manifests or lockfiles; schema or data migrations; authentication, authorization, or cryptography code; public interface changes; diff size above a policy threshold; and any test-weakening signal (§10). Policy is monotonic within a run: risk and required checks can only increase.

## 7. Approved task contract

Keep tasks small: normally one coherent behavior and one to five acceptance criteria. Larger requests are decomposed into independently verifiable tasks with explicit dependencies.

| Field | Meaning |
|---|---|
| `goal` | Intended outcome and reason. |
| `acceptance` | Stable criterion IDs, expected behavior, and required evidence type. |
| `scenarios` | Reference to the hidden acceptance scenarios for this task (§10), by digest. |
| `nonGoals` | Boundaries that prevent opportunistic expansion. |
| `scope` | Expected components, permitted changes, and forbidden changes. |
| `risk` | Declared risk and relevant concerns. |
| `context`, `reuse` | Starting files and existing components to reuse. |
| `approach` | Short high-level guidance. |
| `verification` | Regression, compatibility, visual, integration, or other checks. |
| `run` | Startup and user journeys when a real application check is needed. |
| `exceptions` | Narrow preapproved exceptions, each with rationale and replacement evidence. |
| `dependsOn` | Task dependencies or required merged prerequisites. |
| `budget` | Time, model-call, and resource limits. |

### Approval

Approval records the task digest, scenario digest, repository identity, policy digest, approver, timestamp, and authorized capabilities. The task digest is computed over the canonical JSON block, so any edit to the task after approval voids the approval.

Approval must be performed by a human in a channel the spec session cannot act in:

- The proposed mechanism is a trusted approval job gated by a protected environment with required reviewers and self-review disabled. The approver acts in the GitHub web or mobile interface, and the control plane reads the reviewing actor from the platform's record, not from any comment text.
- Factory sessions run with hooks that deny the approval endpoints. Cloud spec sessions hold no token for the approver's identity.
- A local session that holds the owner's own GitHub login can, in principle, call the same endpoints. The hook is a guardrail for that case, not a boundary. Owners who need a hard boundary run `/factory:spec` in a cloud session.

The execution base is frozen at admission. Sensitive changes may be authorized at approval. Newly discovered sensitive scope, new external access, or a material change in intent requires a new decision. Do not ask again for an exception already granted to the same scope.

## 8. Roles and model selection

- **Spec author:** a capable model clarifies intent and drafts the task with the owner.
- **Scenario author:** drafts hidden acceptance scenarios from the acceptance criteria, in a separate context from any builder. The owner reviews them at approval.
- **Scout:** an optional cheaper read-only agent that finds relevant code.
- **Builder:** implements tests and code in its sandbox. Starts with a cost-effective model and escalates under a recorded policy.
- **Judge:** a capable model in fresh context and a separate clean sandbox.
- **Control plane:** ordinary code, not a model.

Pin resolved model identifiers, prompts, CLI version, plugin version, and settings per run. Record any authorized fallback; never substitute silently.

**Judge constraints.** The judge receives the approved task, the candidate diff, relevant source, and independently collected evidence. It has no write tools and no network beyond the model service and the run's application. Diff content, logs, and builder explanations are presented as delimited data, and builder explanations are claims to check. The judge can add blocking findings; it can never waive a deterministic gate, a scenario failure, or a policy requirement. Its acceptance is necessary for publication and never sufficient on its own.

## 9. Execution lifecycle

Normal flow:

`draft → approved → queued → provisioning → baseline → building → candidate-frozen → verifying → judging → publishing → ci-pending → ready → merged`

### Transition table

| From | Event | To |
|---|---|---|
| `draft` | Verified human approval | `approved` |
| `approved` | Admission passes and claim ref created | `queued` |
| `approved` | Unmet dependency | `waiting-for-dependency` |
| `waiting-for-dependency` | Dependency merged | `approved` (base revalidated) |
| `queued` | Capacity available and review queue below cap | `provisioning` |
| `provisioning` | Environment ready | `baseline` |
| `provisioning` | Infrastructure retries exhausted | `needs-human` |
| `baseline` | Baseline classified and acceptable | `building` |
| `baseline` | Unclassified baseline failure | `needs-human` |
| `building` | Builder emits a bundle that passes scope checks | `candidate-frozen` |
| `candidate-frozen` | Verifier provisioned | `verifying` |
| `verifying` | All required checks and scenarios pass | `judging` |
| `verifying` / `judging` / `ci-pending` | Actionable failure with budget remaining | `repairing` |
| `judging` | Accept | `publishing` |
| `judging` | Inconclusive on a material point | `needs-human` |
| `repairing` | New bundle passes scope checks | `candidate-frozen` |
| `publishing` | Branch pushed and draft PR present | `ci-pending` |
| `ci-pending` | All required checks pass for the candidate | `ready` |
| `ready` | Authorized reviewer requests changes | `changes-requested` |
| `changes-requested` | Feedback within approved scope | `repairing` |
| `changes-requested` | Feedback expands scope or intent | `needs-human` |
| `ready` | Base moved and carry-forward rule not satisfied (§12) | `stale` |
| `stale` | Refresh succeeds | `ready` |
| `stale` | Conflict outside scope, or reserve exhausted | `needs-human` |
| `ready` | PR merged by a human | `merged` |
| Any state with a PR | PR closed without merge | `cancelled` |
| Any state with a branch | Commit by a non-factory author on the branch | `handed-off` |
| Any non-terminal | Budget exhausted with no eligible transition | `needs-human` |
| Any non-terminal | Authorized cancel | `cancelled` |
| `needs-human` | Human decision | The state named in the escalation |
| `needs-human` | No decision within 14 days (reminder at 3) | `cancelled` |
| Any non-terminal | Unrecoverable control-plane error | `failed` |

Terminal states are `merged`, `cancelled`, and `failed`. `handed-off` is terminal unless a human runs resume with `--adopt`, which treats the branch head as a new unverified candidate and re-enters at `candidate-frozen`. Every transition records its cause and inputs. `ready` means ready for human merge with required evidence, not merely that a PR exists.

### Stage notes

1. **Admit:** validate approval, policy, dependencies, limits, and runner capabilities.
2. **Baseline:** record the base commit, start from the environment snapshot, and run required baseline checks. Existing failures are classified before editing begins. Unexpected baseline failures do not authorize unrelated repairs; an approved quarantine may be honored and reported.
3. **Build:** give the builder the task and relevant evidence, never the hidden scenarios. Targeted checks run during implementation.
4. **Freeze:** format, inspect the full diff, compute risk, enforce scope and protected paths, and freeze the candidate as an immutable commit.
5. **Verify:** a fresh worker runs required checks, the revert-the-fix check, mutation gates, and hidden scenarios against the frozen candidate. Unexpected source mutations and undeclared artifacts are failures.
6. **Judge:** a separate clean worker assesses every criterion and required review dimension.
7. **Repair:** actionable failures return to the builder. Any change creates a new candidate and invalidates candidate-specific results.
8. **Publish:** the publisher validates the evidence bundle, pushes exactly the authorized commit to `factory/<task-id>`, and creates or updates one draft PR found by head branch.
9. **Observe CI:** await required checks for the exact candidate, with a deadline.
10. **Review:** respond to human review per §14.

## 10. Verification requirements

### Deterministic checks

Always enforce task scope, protected paths, source identity, formatting, configured build and type checks, required tests, and secret scanning. Add dependency, static-security, duplication, compatibility, or performance checks from policy and effective risk.

Record executed, failed, skipped, unavailable, and timed-out checks separately. Only an explicitly authorized exemption satisfies an omitted requirement.

### Proof matched to the change

- **Bug fixes** require a regression test that passes the revert-the-fix check.
- **New behavior** requires behavioral tests and passing hidden scenarios.
- **Refactors** use behavior-preservation, contract, or differential tests; existing tests must pass unmodified unless a change is justified.
- **Documentation and visual changes** use build, link, rendering, or browser evidence.

**Revert-the-fix check.** The verifier constructs a tree from the candidate with every non-test path reset to the base, then runs the tests mapped to each criterion. For a bug fix, those tests must fail by assertion. A collection, import, or build error does not count as proof. For new behavior, a build failure caused by the absence of the new interface is recorded as expected absence and is acceptable; it is never acceptable for a bug fix. Evidence is associated with criterion IDs; one failing test does not cover the whole task.

**Mutation gate.** Mutation testing runs on the lines changed by the candidate. Policy sets a minimum kill rate per risk level; it is required at medium and high risk and advisory at low risk until calibrated in Milestone 3. Surviving mutants in changed code are returned to the builder as actionable findings. Mutants the builder shows to be equivalent are recorded with the argument and resolved by the judge.

**Test-weakening signals.** Test deletion, renaming, assertion weakening, snapshot replacement, and new skips must be justified and reviewed. Unauthorized weakening fails the run and raises computed risk.

**Flaky tests.** A failed test is rerun up to twice in a clean process. A pass on retry is recorded as flaky and does not block, unless the test is new or changed in the candidate. New and changed tests must pass three consecutive runs. Tests on the quarantine list are reported, not enforced.

### Hidden acceptance scenarios

Each behavior-changing task has scenarios written before the build and approved with the task.

- Scenarios are black-box: they exercise the candidate through its public interface (command line, HTTP, user interface, or public API), so they do not depend on implementation choices.
- They are stored in the control repository. The builder and scout never receive them.
- The scenario driver runs in a separate container from the application under test and reaches it only over the declared interface.
- The builder receives only a control-plane-authored summary per criterion: pass or fail and a coarse failure category. Scenario text and raw driver output are never forwarded.
- Scenario feedback is limited to the repair rounds in §13, to limit fitting by trial.
- Documentation tasks and pure refactors may omit scenarios with a recorded justification at approval.

Scenario results are evaluated by deterministic code. A scenario failure blocks publication regardless of the judge's verdict.

### Independent acceptance and review

Each criterion receives `met`, `unmet`, or `inconclusive` with evidence references. All required criteria must be met.

Every candidate receives acceptance review and inspection of test changes. Medium and high risk add deeper correctness, compatibility, and security review. User-visible behavior requires a real-run check unless the approved task supplies a justified substitute.

Findings include severity, affected code, reasoning, evidence, and disposition. Executable reproduction is preferred; a precise static argument may also establish a material defect. Material unresolved uncertainty produces an inconclusive verdict. Cosmetic findings do not block.

The builder must fix or rebut every blocking finding. Rebuttals require evidence and independent resolution.

## 11. Evidence integrity

Each evidence manifest records:

- Repository, task, attempt, and lease identity.
- Task, scenario, and policy digests; base commit; candidate commit; source-tree digest; and the patch identity of the candidate relative to its base.
- Environment snapshot, runtime image, dependency lock, toolchain, scanner, prompt, model, and factory versions.
- Commands, start and end times, exit status, test discovery counts, retries, and artifact references.
- Scenario results, mutation results, criterion results, findings, exemptions, and final verdict.
- CI result identity, and any carry-forward record (§12).

The control plane records process completion through the runner interface. Text claiming a command passed is not a recorded result. Model output is schema-validated and checked for complete criterion coverage and valid artifact references.

Final verification runs from clean source with declared writable output locations. Tracked source is read-only where practical; otherwise its digest is verified before and after. Stale workers and evidence for another candidate are rejected.

The manifest digest is published as a check run on the candidate commit by the factory App. Workers cannot create or alter check runs.

This establishes provenance and catches many failure modes; it does not prove correctness.

## 12. Parallel runs in the same repository

Each run has one builder at a time, a unique task ID, the branch `factory/<task-id>`, a separate clone, isolated services and fixtures, independent evidence, and its own budget.

**Admission limits.** The scheduler enforces the repository concurrency limit and a review-queue cap: when the number of factory PRs awaiting human review reaches the cap, no new run leaves `queued`. This keeps output matched to review capacity.

**Overlap.** Track declared scope, dependencies, and actually touched paths. Disjoint work proceeds concurrently. Known conflicting tasks are ordered. Unexpected overlap triggers coordination before publication; file overlap is a signal, not a complete semantic-conflict detector.

**Base movement.** The factory does not rebase on every change to the target branch. Final integration is enforced at merge time by the repository's merge queue or up-to-date requirement plus required CI. When the base moves under a `ready` PR:

- **Carry-forward.** If a rebase onto the new base is conflict-free, the patch identity is unchanged, and the intervening base commits touch neither the files the candidate touched nor paths in its declared scope, the judge verdict and scenario results carry forward. The control plane records a carry-forward entry naming both commits, and all deterministic checks rerun in full on the new commit through CI. No model budget is consumed.
- **Refresh.** Otherwise the run becomes `stale`. A controlled worker rebases, and the new candidate is fully verified, run against scenarios, and judged again. This consumes the integration reserve (§13).
- The factory rebases only when the PR is conflicted, when policy requires an up-to-date branch, or when a human asks.

Conflicts are repaired autonomously only within approved scope and remaining budget. Ambiguous product behavior or incompatible accepted tasks requires human resolution. The factory never merges.

## 13. Durability, retries, and budgets

Every transition is one appended event. A scheduled reconcile job rebuilds state from the event log and from remote reality (refs, PRs, check runs, job status) and repairs divergence. A replacement worker receives a new lease generation; late results from the previous lease are rejected.

External operations are idempotent. The branch name is deterministic and the PR is found by head branch before any creation is retried. Cancellation revokes leases, terminates descendant processes, prevents later publication, and preserves evidence. Reconcile also detects stuck runs: any run with no event inside its stage timeout is escalated.

A run pins its factory version. Upgrades apply to new runs; the event schema is versioned.

### Default limits, configurable before approval

| Limit | Default |
|---|---|
| Initial build attempts | 3, with the stronger model on attempt 3 |
| Judge-driven or scenario-driven repair rounds | 2 |
| CI repair cycles | 1 |
| Integration refresh reserve | 1 builder and 1 judge invocation |
| Total builder invocations per run | 7 |
| Total judge invocations per run | 5 |
| Review feedback rounds | 3, each granting 1 builder and 1 judge invocation |
| Infrastructure retries | 3 in aggregate; these do not reset model budgets |
| Active execution time | 90 minutes, excluding human and queue wait |

The phase limits sum exactly to the totals: 3 + 2 + 1 + 1 builder invocations, and 1 initial + 2 repair + 1 CI + 1 refresh judge invocations. A review feedback round is granted by the reviewer's own request for changes, which is a human decision, so it adds to the totals. All limits apply simultaneously. Resume never resets consumed budget. A second integration refresh needs an approved continuation.

Track model usage, compute usage, wall time, and estimated cost. Use hard call, time, and resource caps even where billing does not expose an enforceable balance. Resource starvation, flaky infrastructure, and code failures have different retry policies. Repeated identical failures stop early.

## 14. Human decisions, review, and notifications

| Situation | Default behavior |
|---|---|
| New task | Approve intent, scope, scenarios, evidence expectations, exceptions, and budget. |
| Routine implementation and bounded repairs | Continue automatically. |
| Already approved sensitive operation | Continue with its required checks. |
| New sensitive scope, access, or material intent change | Pause with a concrete proposed decision. |
| Unresolved material finding or exhausted budget | Pause with evidence and a recommended next action. |
| Missing infrastructure or credentials | Stop with actionable setup information. |
| Passing PR | Notify that it is ready; a human decides merge. |
| Change to enforcement, evaluators, scenarios policy, or the factory itself | Human approval required. |

### Review feedback on the pull request

- A review requesting changes, or a review comment, from an authorized reviewer moves the run to `changes-requested`.
- The control plane packages the feedback for the builder. Feedback within the approved scope and criteria proceeds to repair, then full verification and judgment of the new candidate.
- Feedback that adds criteria, expands scope, or changes intent is recorded as a proposed task amendment with a new digest. It proceeds only after approval through the channel in §7. The reviewer may be the approver, but the approval step is not skipped.
- Comments from people who are not authorized reviewers are untrusted input. They may be shown to the judge as context and never act as instructions.
- If a human pushes a commit to the factory branch, the factory stops writing to that branch, marks existing evidence as not covering the new commits, and moves to `handed-off`.
- If the PR is closed without merge, the run is cancelled and the outcome recorded.

Each escalation states what happened, what is blocked, the relevant evidence, and the smallest decision needed. Notify on completion, material failure, or required action; avoid repetitive unchanged updates.

## 15. Delivery and post-merge observation

Before publishing, verify that every mandatory check, the scenario results, and the independent verdict apply to the exact candidate. The publisher works from trusted Git configuration with hooks and project execution disabled. It validates the destination repository and branch namespace and cannot write the default branch.

The draft PR contains intent, scope, criterion-by-criterion evidence, checks performed, mutation and scenario summaries without scenario text, approved exceptions, material risks, candidate identity, and relevant artifacts.

Pending, missing, skipped, cancelled, and failed CI checks are distinct. Required checks must pass or have an explicit applicable exemption. CI repairs produce a new candidate and updated evidence.

Repository protections independently prevent unauthorized merging. The merge queue or up-to-date requirement handles target-branch movement at merge time.

After merge, collect read-only signals such as CI results, reverts, owner corrections, and linked incidents where available. Mark unavailable signals as unknown. The factory may propose a follow-up task; it cannot deploy or modify production.

## 16. Evaluation of the factory

Maintain four suites:

1. **Control-plane tests:** real temporary Git repositories and fake external services; transition validity against the table in §9, budgets, approvals, crash recovery, idempotency, stale leases, claim races, cancellation, carry-forward, and concurrency.
2. **Verifier evals:** labeled good and bad changes, including unmet criteria, weakened tests, forged reports, secrets, protected edits, wrong source identity, broken environments, tests that pass without the fix, and diffs containing instructions aimed at the judge. Measure false acceptance and false rejection.
3. **Builder evals:** saved tasks graded by hidden acceptance tests, compared against plain Claude Code on the same tasks. Include multiple repositories and task types. Three to five tasks are a smoke suite, not evidence for broad autonomy.
4. **Boundary tests:** attempts to read credentials or scenarios, alter trusted state, push from a worker, read CI secrets from a factory branch, escape egress restrictions, poison environment snapshots, cross run boundaries, and forge approval from a session.

Keep development cases separate from protected holdouts. Builders must not read holdout answers. An evaluator that changes alongside a candidate cannot be the sole authority grading it.

Track accepted tasks, human minutes per task, review rounds, escaped defects, false decisions, repair frequency, scenario and mutation outcomes, cost, latency, and policy violations. Report trial counts and uncertainty.

## 17. Improvement proposals

The factory may observe outcomes, identify a recurring failure, and propose one change to its prompts, model routing, or context selection. A proposal records its hypothesis, changed component, baseline version, evaluation plan, success criteria, and rollback target, and is evaluated in isolation from the installed factory.

Promotion is always a human decision in this version. It requires passing all regression and boundary suites, no observed regression in critical verifier decisions, and results on protected holdouts. Insufficient evidence means the existing version is retained.

Changes to sandbox permissions, publisher authority, gates, risk rules, evaluators, scenarios policy, or holdouts are ordinary reviewed changes to the control repository and are never proposed by this workflow.

Automatic promotion, shadow runs, and canaries are out of scope. They need outcome volume that a new deployment will not have, and are left to a separate specification once Milestone 3 has produced a baseline.

## 18. Implementation structure

Use a dedicated versioned control repository. Keep the plugin thin and the deterministic core testable outside a model session.

```text
plugin/
  skills/spec/  skills/run/  skills/status/
  skills/resume/  skills/cancel/  skills/eval/
  agents/  hooks/
control/
  ledger/  transitions/  policy/  scheduler/  reconcile/
  evidence/  publisher/  approval/
runners/
  contract/  cloud/
verification/
  adapters/  guards/  mutation/  scenarios/  reports/
workflows/
schemas/
scenarios/
evals/
  control/  verifier/  builder/  boundary/  holdout/
docs/
```

This is a responsibility map, not a requirement for separate services. Reuse mature Git, CI, sandbox, mutation-testing, and scanning tools.

## 19. Build order and release gates

**Milestone 0 — prove the platform.** On one cloud runner, demonstrate: authenticated noninteractive Claude execution with tool restrictions and structured output; that a worker cannot push or create check runs; the run-scoped model credential; per-stage network policy; cancellation; artifact and bundle retrieval; that a run on a factory branch cannot read CI secrets; and that a factory session cannot perform approval. Document actual billing behavior without assuming it.

**Milestone 1 — one complete task.** Approval, event log, claim, baseline, build, frozen candidate, fresh verification with the revert-the-fix check and hidden scenarios, independent judgment, restricted publication, evidence check run, and CI observation. Deliver one toy-repository PR with complete evidence, and reject one deliberately incorrect task.

**Milestone 2 — recovery, parallelism, and review.** Kill workers and control jobs at every transition and reconcile. Run two tasks in one repository, merge one manually, and show both carry-forward and refresh behaving as specified. Exercise a requested-changes round, a scope-expanding comment, a foreign commit, and a closed PR. Prove no duplicate PRs or cross-run access.

**Milestone 3 — supervised real use.** Representative tasks; calibrate mutation thresholds, flake policy, and false decisions; exercise sensitive preapproved tasks; measure human effort. Decide against the §3 criteria whether a dedicated controller is needed.

**Milestone 4 — local runner.** Add a local adapter under the same contract, with a ledger that works offline.

**Milestone 5 — improvement proposals.** Collect outcomes, generate isolated proposals, run baseline and holdout comparisons, and produce recommendations for human promotion.

Initial release (end of Milestone 2) is acceptable only when: a correct task reaches a verified draft PR; an incorrect task is rejected; a candidate that passes its own tests and fails a hidden scenario is rejected; an interrupted run resumes safely; parallel tasks remain isolated; stale evidence is rejected; review feedback produces a re-verified candidate; and no worker can publish or approve.

## 20. References and open implementation questions

Claude Code documentation describes noninteractive execution, model selection, structured output, tool controls, and call limits. `--allowedTools` preapproves tools; it does not restrict the available tool inventory. The installed version and chosen combination still require integration tests. [CLI reference](https://code.claude.com/docs/en/cli-reference).

Claude Code's built-in shell sandbox does not cover every file tool, hook, or integration. The runner must enforce the outer boundary. [Sandbox documentation](https://code.claude.com/docs/en/sandboxing).

Cloud documentation describes parallel sessions and GitHub credentials held outside session VMs. A session attached to a repository with push access can still push, so the repository must be attached read-only or the adapter rejected. [Cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web).

Repeated trials, outcome-based grading, and evaluator calibration inform the evaluation design. [Agent evaluation guidance](https://www.anthropic.com/research/demystifying-evals-for-ai-agents).

Prior art that informed this revision: the GitHub-native state model, branch claim, review-queue cap, and mutation and revert-the-fix gates in [addyosmani/factory](https://github.com/addyosmani/factory); hidden-test evaluation in [owainlewis/software-factory](https://github.com/owainlewis/software-factory); and per-run holdout scenarios as described in write-ups of [StrongDM's software factory](https://simonwillison.net/2026/Feb/7/software-factory). These were read at README or summary level, not audited.

Resolve during Milestone 0:

- Which cloud runner satisfies §4 and §5.
- The model-credential mechanism and its effective capabilities.
- Whether the protected-environment approval mechanism records the reviewing actor reliably, and whether self-review can be fully disabled.
- Same-repository branches with restricted secrets, or a dedicated fork.
- Event-log comment volume against API rate limits for a realistic run.
- Mutation-testing tool and scenario driver for the first repositories.

Do not weaken the contract to accommodate a provider that cannot satisfy it.
