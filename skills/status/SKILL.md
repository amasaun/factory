---
name: status
description: Show the state of factory tasks across the user's repositories. Use when the user asks what the factory is doing, what is waiting on them, or how a run went.
argument-hint: "[owner/name ...]"
---

Show the user where their factory tasks stand.

Arguments, if any: $ARGUMENTS

The helper for this plugin is `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts`. It reads GitHub through `gh` and changes nothing.

- With repositories given as arguments, run `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts status --repo <owner/name>` once per repository (the flag can be repeated).
- With no arguments, run `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts status`, which reads every registered repository. If none is registered, offer to register the current one with `repos add <owner/name>`, or to check just the current one with `--repo`.
- To manage the list: `repos list`, `repos add <owner/name>`, `repos remove <owner/name>`.

Present the result to the user. Lead with what needs them, grouped by repository:

- `ci-pending` or `ready`: a pull request is open and waiting for their review. Give its number. Note that CI on a factory pull request does not start by itself; closing and reopening the pull request starts it.
- `needs-human`: the run stopped for a decision. Say why, from the last event.
- `failed`: the run ended without a pull request. Say why.
- `not started` on an open issue: a task is written but not approved.

Then list what is in progress, and summarise finished tasks in one line. Do not start, cancel or change anything; if the user wants to act, tell them how.
