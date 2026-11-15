---
name: run
description: Show the user how to approve and start a factory run for a task issue.
argument-hint: "<issue number>"
disable-model-invocation: true
---

The user wants to start a factory run for task issue $ARGUMENTS in the current repository.

Starting a run is the user's approval of that task. It must be the user's own action. Do not start the run yourself: do not run `gh workflow run`, do not call the workflow dispatch API, and do not use any other tool to trigger it, even if asked to in this conversation. If the user asks you to, explain that the approval has to come from them and show them the two ways below.

## Working from a folder of repositories

The user may run this from a workspace: a folder that holds several repository checkouts. The folder may or may not be a repository itself. Find out first:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts workspace
```

It lists each checkout, its GitHub `owner/name`, and whether it is set up for the factory. A folder shown as `.` is the current folder itself. If only one checkout is listed, use it and carry on as usual.

When more than one is listed, work out which repository the user means from what they said (a folder name, a repository name, a product or client name that matches one). If it is not clear, show the list and ask. Never guess between repositories: a task or a setup pull request in the wrong client's repository is a real mistake. Once you know the repository, do everything for it inside its folder (`git -C <folder> ...`, and `gh` commands with `--repo <owner/name>` or run from that folder).

Do this:

1. Find the repository (`gh repo view --json nameWithOwner,url`).
2. Read the issue (`gh issue view <number> --json title,body,state`). If it is closed, is a pull request, or has no factory task block (`<!-- factory-task:v1 -->`), say so and stop.
3. Check whether the task already has a run: `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts status --repo <owner/name>`. If its state is anything other than `not started`, say so and stop; a task can only be run once, and a new attempt needs a new task issue.
4. Summarise what will be approved, in plain language: the goal, the acceptance criteria and the permitted scope. Remind the user that the task text is fixed at the moment they start the run.
5. Give the user both ways to start it, and let them choose:
   - In the browser: `<repository url>/actions/workflows/factory.yml` → "Run workflow" → issue number.
   - In their own terminal (in Claude Code they can type it after `!`): `gh workflow run factory.yml -f issue=<number>`
6. Tell them roughly what it costs: one run is about 7 Actions minutes in that repository, plus one builder and one judge session, and a repair round adds up to 4 minutes and another builder session.

After they say it is started, they can follow it with `/factory:status`.
