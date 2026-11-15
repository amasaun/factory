# The Claude Code plugin

The plugin adds four commands to Claude Code. It is installed once, for you, and works in any repository you open. It runs on your machine, reads GitHub through the GitHub CLI you are already signed in with, and never handles a credential.

## Install

Requirements: Claude Code, Node 22.18 or later, and the GitHub CLI (`gh auth login`).

```
/plugin marketplace add amasaun/factory
/plugin install factory@amasaun-factory
```

## Commands

| Command | What it does |
|---|---|
| `/factory:init` | Sets up the current repository: finds the test commands and confirms them with you, opens a pull request adding the policy file and the workflow pinned to the latest release, and lists what only you or an admin can do (the model credential and two settings). |
| `/factory:spec [what you want]` | Works out a small task with you and writes the ticket: description, user story, acceptance criteria as Given / When / Then, test cases, repository, and other areas affected. It checks nothing is missing, previews the score the factory will give it, and files the issue once you agree. |
| `/factory:run <issue>` | Summarises the task you are about to approve and shows you how to add the label that starts it. |
| `/factory:status [owner/name ...]` | Shows every factory task across your repositories: what is waiting on you, what is in progress, what finished. |

## Who starts the work

Work starts when the `factory` label is added to a task issue. That is your approval of the task, so it is always your own action: add the label in GitHub, or run `gh issue edit <number> --add-label factory` yourself. `/factory:spec` and `/factory:run` prepare that step and do not take it. Claude is told not to add the label.

This is an instruction to the model, not a technical barrier: a Claude session with your GitHub login is able to add a label. What stands behind it is the factory's own gate: whoever adds the label must be a listed approver, and the ticket must pass the evaluation.

## The repository list

`/factory:status` with no arguments reads every repository you have registered. `/factory:init` registers the repository it sets up. The list is a small file at `~/.config/factory/repos.json`, and you can manage it by asking for `repos list`, `repos add owner/name` or `repos remove owner/name`.

Status is read from each repository's task issues, their event comments and their pull requests. Nothing is stored anywhere else, so it shows the same thing from any machine.

## What the plugin does not do

- It does not start, cancel or resume runs.
- It does not add secrets or change repository settings.
- It does not write to a run's history.

## Working from a folder of repositories

The commands can be run from a workspace: a folder that holds several repository checkouts side by side. The folder does not have to be a repository itself.

- `/factory:status` with no arguments shows every repository in the folder that is set up for the factory, and mentions the ones that are not.
- `/factory:init`, `/factory:spec` and `/factory:run` work out which repository you mean from what you say, and ask when it is not clear. They never guess between repositories.
- One task changes one repository. If what you want needs changes in several, `/factory:spec` proposes one task per repository and the order to do them in.

Only immediate subfolders are looked at. Hidden folders and dependency folders such as `node_modules` are skipped.
