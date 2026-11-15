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
| `/factory:spec [what you want]` | Works out a small task with you, reads the code so the task names real files, checks the task is well formed, and files it as an issue once you agree with it. |
| `/factory:run <issue>` | Summarises the task you are about to approve and shows you how to start it. |
| `/factory:status [owner/name ...]` | Shows every factory task across your repositories: what is waiting on you, what is in progress, what finished. |

## Who starts a run

Starting a run is your approval of the task, so it is always your own action: the "Run workflow" button in GitHub, or `gh workflow run factory.yml -f issue=<number>` typed by you. `/factory:run` prepares that step and does not take it. Claude is told not to start runs, and that command cannot be triggered by Claude without you typing it.

This is an instruction to the model, not a technical barrier: a Claude session with your GitHub login is able to start a workflow. If you need a hard barrier, start runs only from the GitHub website.

## The repository list

`/factory:status` with no arguments reads every repository you have registered. `/factory:init` registers the repository it sets up. The list is a small file at `~/.config/factory/repos.json`, and you can manage it by asking for `repos list`, `repos add owner/name` or `repos remove owner/name`.

Status is read from each repository's task issues, their event comments and their pull requests. Nothing is stored anywhere else, so it shows the same thing from any machine.

## What the plugin does not do

- It does not start, cancel or resume runs.
- It does not add secrets or change repository settings.
- It does not write to a run's history.
