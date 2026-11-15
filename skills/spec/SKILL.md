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

Write a JSON object with these fields:

- `goal`: the outcome and the reason, in one or two sentences.
- `acceptance`: a list of `{ "id": "AC-1", "behavior": "...", "evidence": "unit test" }`. Each behaviour must be specific enough that a test can check it: name inputs and expected results. Avoid "works correctly" or "handles errors".
- `scenarios`: `{ "omitted": "Hidden scenarios are not implemented yet." }`.
- `nonGoals`: things the builder should not do, especially tempting nearby changes.
- `scope`: `{ "components": [...], "permitted": [globs the builder may change], "forbidden": [globs it must not] }`. Make `permitted` as narrow as the task allows; the factory refuses any change outside it. Never include workflow files, `.factory/`, `.claude/` or CODEOWNERS; those are always refused.
- `risk`: `{ "level": "low" | "medium" | "high", "concerns": [...] }`. Raise it for anything touching authentication, payments, data migrations or public interfaces.
- Optional: `context` (files to read first), `reuse` (existing code to use), `approach` (short guidance, not a design).

## 4. Check it and show it

Write the JSON to a temporary file outside the repository and run:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts task <file>
```

It prints the issue body for a valid task, or lists what is wrong. Fix problems and run it again.

Then show the user the task in plain language: the goal, each acceptance criterion, what is in and out of scope, and the risk level. Ask them to confirm or change it. The task text is what they will be approving, so do not file it until they agree.

## 5. File it

Create the issue with a short title and the helper's output as the body, with one or two sentences of plain description above it (`gh issue create --title ... --body-file ...`). Do not edit the block the helper printed.

Tell the user the issue number and how to start it: `/factory:run <number>`. Do not start it yourself.
