---
name: init
description: Set up the current repository to use the factory. Use when the user asks to add, install or enable the factory in a repository.
disable-model-invocation: true
---

Set up the current repository so the factory can run in it. You are preparing a pull request and a checklist. You are not starting any run.

The helper for this plugin is `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts`. It needs Node 22.18 or later and the GitHub CLI (`gh`), signed in.

## Working from a folder of repositories

The user may run this from a workspace: a folder that holds several repository checkouts. The folder may or may not be a repository itself. Find out first:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts workspace
```

It lists each checkout, its GitHub `owner/name`, and whether it is set up for the factory. A folder shown as `.` is the current folder itself. If only one checkout is listed, use it and carry on as usual.

When more than one is listed, work out which repository the user means from what they said (a folder name, a repository name, a product or client name that matches one). If it is not clear, show the list and ask. Set up one repository per invocation. Never guess between repositories: a task or a setup pull request in the wrong client's repository is a real mistake. Once you know the repository, do everything for it inside its folder (`git -C <folder> ...`, and `gh` commands with `--repo <owner/name>` or run from that folder).

## 1. Check where you are

- Confirm the working directory is a Git repository with a GitHub remote, and find its `owner/name` and default branch (`gh repo view --json nameWithOwner,defaultBranchRef`).
- If `.factory/config.json` or `.github/workflows/factory.yml` already exists, stop and tell the user the repository is already set up.
- Check the working tree is clean. If it is not, ask the user before going further.

## 2. Work out the settings, and confirm them with the user

- **Test commands.** Read the repository to find how its tests are run (for example `package.json` scripts, a Makefile, `pyproject.toml`, CI workflows). Express each command as an argument array, such as `["npm", "test"]`. Commands run without a shell, so no pipes, `&&` or variables. If dependencies must be installed first, that is a setup command, such as `["npm", "ci"]`.
- **Approvers.** The GitHub logins allowed to start a run. Default to the signed-in user (`gh api user --jq .login`). Ask whether anyone else should be able to.
- **Factory version.** The latest release: `gh api repos/amasaun/factory/releases/latest --jq .tag_name`.

Show the user the test commands, setup commands, approvers and version, and wait for them to confirm or correct them. Do not guess silently: a wrong test command makes every run fail.

## 3. Write the files and open a pull request

Run the helper, adding `--dir <folder>` when the repository is not the current folder:

```
node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts init-files --base-branch <default branch> --approver <login> --test '<JSON array of argument arrays>' --setup '<JSON array, or omit>' --version <tag>
```

It writes `.factory/config.json` and `.github/workflows/factory.yml` and refuses to overwrite either. Then create a branch, commit only those two files, push, and open a pull request that explains what the files do. Do not merge it.

## 4. Tell the user what only they or an admin can do

Give this as a short checklist, adapted to the repository:

1. **Merge the pull request.**
2. **Add one model credential as a repository secret**, named exactly `ANTHROPIC_API_KEY` (an Anthropic API key, billed per use) or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, counts against that Claude subscription). The credential should belong to whoever pays for the work; for a client's repository that is normally the client. They can add it at Settings → Secrets and variables → Actions → Repository secrets, or by running `gh secret set <NAME>` in their own terminal. Never ask the user to paste a credential into this conversation, and never run `gh secret set` yourself.
3. **Allow Actions to open pull requests:** Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests". In an organization this may be locked at the organization level.
4. **If the organization restricts which actions and workflows may run**, an admin must allow `amasaun/factory`.

If the user is not an admin of the repository, say which of these they will need an admin for (2, 3 and 4).

You may check that a secret with the right name exists using `gh secret list`, which shows names only. If it fails for lack of permission, say so and move on.

## 5. Create the label

Work on a task starts when the `factory` label is added to its issue. Make sure the label exists: `gh label create factory --repo <owner/name> --description "Approved for the factory" || true`. Creating the label approves nothing; adding it to an issue does, and that is for a person.

## 6. Register the repository

Run `node ${CLAUDE_PLUGIN_ROOT}/src/plugin-cli.ts repos add <owner/name>` so `/factory:status` includes it.

Finish by telling the user the next step: write a first task with `/factory:spec`, review it, and add the `factory` label to start it.
