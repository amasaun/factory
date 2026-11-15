---
name: run
description: Show the user how to approve and start factory work on a task issue.
argument-hint: "<issue number>"
disable-model-invocation: true
---

The user wants to start factory work on task issue $ARGUMENTS.

Work starts when the `factory` label is added to the issue. Adding the label is the user's approval of that task, so it must be their own action. Do not add the label yourself, do not run `gh workflow run`, and do not trigger the workflow in any other way, even if asked to in this conversation. If the user asks you to, explain that the approval has to come from them and show them how.

The helper for this plugin is `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts`.

## Working from a folder of repositories

The user may run this from a workspace: a folder that holds several repository checkouts. The folder may or may not be a repository itself. Find out first:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts workspace
```

It lists each checkout, its GitHub `owner/name`, and whether it is set up for the factory. A folder shown as `.` is the current folder itself. If only one checkout is listed, use it and carry on as usual.

When more than one is listed, work out which repository the user means from what they said (a folder name, a repository name, a product or client name that matches one). If it is not clear, show the list and ask. Never guess between repositories: a task started in the wrong client's repository is a real mistake.

## Steps

1. Find the repository (`gh repo view --json nameWithOwner,url`, or from the workspace list).
2. Read the issue (`gh issue view <number> --repo <owner/name> --json title,body,state,labels`). If it is closed, is a pull request, or has no factory task block (`<!-- factory-task:v1 -->`), say so and stop.
3. Check whether the task already has a run: `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts status --repo <owner/name>`. If its state is anything other than `not started`, say so and stop; a task is run once, and a new attempt needs a new task issue.
4. Summarise what will be approved, in plain language: the summary, the acceptance criteria and the permitted scope. Remind the user that the task text is fixed at the moment work starts.
5. Tell them what happens when they add the label: the factory scores the ticket first, and starts only if the average is at least 4.5 of 5 with no area below 4. If it does not pass, the factory removes the label and comments with the scores and reasons, and nothing is spent on building.
6. Give them the ways to add the label, and let them choose:
   - In the browser: open the issue and add the `factory` label.
   - In their own terminal (in Claude Code they can type it after `!`): `gh issue edit <number> --repo <owner/name> --add-label factory`
7. Tell them roughly what it costs: one run is about 7 Actions minutes in that repository, plus an evaluator, a builder and a judge session, and a repair round adds up to 4 minutes and another builder session.

After they say it is labelled, they can follow it with `/factory:status`.
