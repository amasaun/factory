---
name: spec
description: Turn what the user wants into a small, checkable task for the factory and file it as an issue. Use when the user wants to write, draft or file a factory task.
argument-hint: "[what you want built]"
disable-model-invocation: true
---

Help the user write one task for the factory and file it as a GitHub issue in the current repository. You are writing the task. You are not building it, and you are not starting a run.

What the user asked for: $ARGUMENTS

The helper for this plugin is `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts`.

## Working from a folder of repositories

The user may run this from a workspace: a folder that holds several repository checkouts. The folder may or may not be a repository itself. Find out first:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts workspace
```

It lists each checkout, its GitHub `owner/name`, and whether it is set up for the factory. A folder shown as `.` is the current folder itself. If only one checkout is listed, use it and carry on as usual.

When more than one is listed, work out which repository the user means from what they said (a folder name, a repository name, a product or client name that matches one). If it is not clear, show the list and ask. Never guess between repositories: a task or a setup pull request in the wrong client's repository is a real mistake. Once you know the repository, do everything for it inside its folder (`git -C <folder> ...`, and `gh` commands with `--repo <owner/name>` or run from that folder).

One task changes one repository. If what the user wants needs changes in more than one, say so, propose one task per repository, say which must go first, and write only the first now.

## 1. Understand the request

- If the request is unclear or missing, ask what outcome the user wants and why.
- Read the relevant code so the task names real files and existing conventions. Do not change any files.
- Ask about anything that would change what "done" means. Do not ask about details the builder can decide.

## 2. Keep it small

A good task is one coherent behaviour with one to five acceptance criteria that a reviewer could check in a few minutes. If the request is bigger than that, propose a split into separate tasks, say which should go first, and write only the first one now. Small tasks are cheaper, succeed more often, and keep the builder well inside its context limit.

## 3. Draft the task

Write a JSON object with these fields. The first group is what the ticket evaluation scores; a ticket missing any of them is refused before it is built.

- `summary`: a short description of the change that someone unfamiliar with the work could understand. A few sentences at most.
- `story`: `{ "role": "...", "want": "...", "benefit": "..." }`. Who this is for, what they want, and why it matters. It is shown as "As <role>, I want <want>, so that <benefit>", so write each part to read naturally there.
- `acceptance`: a list of `{ "id": "AC-1", "behavior": "...", "gherkin": "Given ...\nWhen ...\nThen ...", "evidence": "unit test" }`. `behavior` is a one-line statement. `gherkin` is the same criterion as a Given / When / Then scenario with concrete values: exact inputs, exact expected results, exact errors. Avoid "works correctly" or "handles errors".
- `testCases`: a list of `{ "id": "T-1", "description": "...", "covers": ["AC-1"] }`. Concrete cases the builder should automate, including boundaries and failure paths. Every acceptance criterion must be covered by at least one.
- `repository`: the `owner/name` this task changes.
- `impactedAreas`: a list of `{ "area": "...", "impact": "..." }` naming other parts of the system, teams or users the change could affect and how, so they can be told. Look for callers and dependents in the code before answering. Use an empty list only when the change is plainly self-contained.

And what the factory needs to do the work:

- `goal`: the outcome and the reason, in one or two sentences.
- `scenarios`: `{ "omitted": "Hidden scenarios are not implemented yet." }`.
- `nonGoals`: things the builder should not do, especially tempting nearby changes.
- `scope`: `{ "components": [...], "permitted": [globs the builder may change], "forbidden": [globs it must not] }`. Make `permitted` as narrow as the task allows; the factory refuses any change outside it. Never include workflow files, `.factory/`, `.claude/` or CODEOWNERS; those are always refused.
- `risk`: `{ "level": "low" | "medium" | "high", "concerns": [...] }`. Raise it for anything touching authentication, payments, data migrations or public interfaces.
- Optional: `context` (files to read first), `reuse` (existing code to use), `approach` (short guidance, not a design).

## 4. Check it

Write the JSON to a temporary file outside the repository and run:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts task <file> --repo <owner/name>
```

It prints the ticket body for a complete task, or lists what is wrong or missing. Fix problems and run it again.

## 5. Score it the way the factory will

When the factory label is added, the factory scores the ticket on seven areas, 1 to 5 each, and starts work only if the average is at least 4.5 and no area is below 4. Read the rubric in `${CLAUDE_PLUGIN_ROOT}/prompts/evaluate.md` and score the task against it yourself, strictly, as if you had not written it. If any area is below 4.5, improve the task and check it again; ask the user for whatever information is missing instead of inventing it.

Your score is a preview. The factory's own evaluation decides, and it may differ from yours, especially close to the threshold.

## 6. Show it, then file it

Show the user the task in plain language: the summary, the story, each acceptance criterion with its scenario, the test cases, the scope, the areas affected, the risk level, and your score for each area with one line of reason. Ask them to confirm or change it. Do not file it until they agree.

Create the issue with a short title and exactly the helper's output as the body (`gh issue create --repo <owner/name> --title ... --body-file ...`). The readable part of the ticket is generated from the data block at the bottom, so later changes must be made by re-running this command, not by editing the readable text.

Tell the user the issue number and what happens next: after a person has reviewed the ticket, adding the `factory` label to it starts the work. Do not add the label yourself; it is the approval, and it has to be a person's.
