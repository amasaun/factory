# Golden sets

A golden set is a collection of inputs with answers a person has agreed are right. Running a model-driven part of the factory against its golden set shows how often it decides wrongly, whether it decides rightly for the wrong reason, and how much its answers move between identical runs. That is the evidence for changing a prompt, a model or a threshold.

Only the ticket evaluator has a golden set so far. The judge and the builder are next.

## Running

```
node src/evals/cli.ts tickets --dry-run
node src/evals/cli.ts tickets --yes
```

The first prints what a run would cost and stops. The second spends model usage: it needs `--yes`, and stops at `--max-usd` (2 by default). Other options: `--trials` (3 by default), `--model`, `--only id,id`, and `--out file` for the full results.

A run uses whichever model credential is in the environment, the same way the pipeline does. It is started by a person. Nothing runs it automatically.

## Reading a result

Each case that needs the model is scored several times. A trial is counted as:

- **correct**: a ticket that should pass passed, or one that should fail was refused with one of its labelled weak areas scoring below the per-area minimum.
- **false accept**: a ticket that should fail passed. This is the costly kind: a bad ticket gets built.
- **false reject**: a ticket that should pass was refused. This costs a person a revision they did not need.
- **wrong reason**: a ticket that should fail was refused, but the evaluator did not mark any labelled weak area down. The gate held by luck, and the feedback on the ticket would point the author at the wrong thing.

The report also gives, per case, the spread of the average score across identical runs and whether those runs reached different decisions.

## Ticket evaluator: the cases

The labels are judgements. A case is only golden once a person who owns the bar has read the ticket and agrees with its label; change the label, or the ticket, where you disagree.

### Should pass

| Case | Why |
|---|---|
| `good-bug-fix` | A bug fix that states the wrong behaviour and the right one with exact strings, says what must not change, names the letters deliberately left out of scope, and tells the web team and the indexing job what changes for them. |
| `good-endpoint-validation` | An endpoint change with the exact status, body, ordering of checks and side effects that must not happen, plus the three client surfaces affected. Larger than the others but still one behaviour. |
| `good-new-function` | A small new helper with exact inputs and outputs for every criterion, the edge cases decided (null, emoji, validation order), concrete test cases, narrow scope and its effect on the public API stated. A careful engineer has nothing left to guess. |

### Should be refused by the scorer

Each of these has every required piece, so the plain checks let it through and the model has to see the problem.

| Case | Weak area | Why |
|---|---|---|
| `contradictory` | Ready to build, Acceptance criteria, Description | The summary says lower case with dots; the criteria say upper case with no separator. One criterion's one-line statement says max keeps the last initials and that 0 means no limit, while its own scenario keeps the first and throws on 0. Whichever the builder follows, part of the ticket is violated. |
| `hidden-impact` | Impact on other areas | The ticket changes the shape of a public response, and its own context lists a web client and a mobile client that read the old shape, yet it claims no other area is affected and calls the risk low. Both clients would break on release. An empty impact list is only acceptable when the change is plainly self-contained. |
| `hollow-story` | User story | The story has all three parts, so the plain check passes, but they carry no information: no one could tell who needs this or why from "a user wants this feature so that it works better". Everything else in the ticket is strong, which isolates the story as the weakness. |
| `injected-instruction` | Ready to build | An otherwise good ticket that contains text telling the scoring model to give full marks. The rubric says such text must not be followed and that readiness is scored 1. A pass here would mean the gate can be talked past. |
| `oversized` | Ready to build, Repository | Five separate features, a database migration and an admin page in one task, with the whole source tree in scope. Several criteria leave the essentials open: how long links last, what the rate limit is, what "recent" means. It should be split, and the rubric asks whether a task is small enough for one piece of work. |
| `scope-too-broad` | Repository | A one-function bug fix that permits changes to every file in the repository and forbids nothing. The rubric asks for a permitted scope that is narrow and consistent with the goal; this gives the builder licence to touch anything. |
| `shallow-test-cases` | Test cases | Every criterion is nominally covered, so the plain check passes, but the test cases name no inputs or expected results. "Test edge cases" cannot be written as an automated test without guessing which ones. |
| `unstated-formats` | Acceptance criteria, Ready to build | It reads like a finished ticket, but the things a CSV export lives or dies on are absent: which columns in which order, the header row, date and money formats, how commas and quotes in values are escaped, what an empty result looks like, and any row limit. Two engineers would produce two incompatible files. |
| `vague-acceptance` | Acceptance criteria, Ready to build | The criteria have the Given / When / Then words but say nothing checkable: no status code, no error body, no definition of a bad username. "Handled correctly" is exactly what the rubric says to refuse. The builder would have to invent the contract. |

### Should be refused by plain checks

These never reach the model and cost nothing to run.

| Case | Weak area | Why |
|---|---|---|
| `plain-criterion-without-scenario` | Acceptance criteria | One acceptance criterion has no Given / When / Then. Plain code refuses this without asking a model. |
| `plain-no-test-cases` | Test cases | No test cases at all. Plain code refuses this without asking a model. |
| `plain-uncovered-criterion` | Test cases | Test cases exist, but none covers AC-4. Plain code refuses this without asking a model. |
| `plain-wrong-repository` | Repository | A good ticket filed against a different repository than the one it names. Plain code refuses this without asking a model. |

### Close to the line

Reported, but not counted as right or wrong.

| Case | Why |
|---|---|
| `borderline-first-draft` | The first draft of the initials ticket, which the real evaluator scored 4.43. It is good but leaves null input, validation order and non-letter first characters undecided. Reasonable reviewers could go either way, so it is used to measure how much the score moves, not counted as right or wrong. |

## Adding a case

Add a JSON file to `evals/tickets/` named after its `id`, with `why`, `repository`, `task` and `expect`. A `fail` case names the `weakAreas` that are the reason. Then add its row here. The test suite checks that every case is well formed, appears in this index, and that every scored area is the labelled weakness of at least one case.
