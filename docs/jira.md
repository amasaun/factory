# Starting work from a Jira ticket

With this set up, adding the `factory` label to a Jira ticket starts the factory on it. The ticket can be in any status. The factory checks who added the label, scores the ticket, and if it passes, moves the ticket to In Progress and starts building. When it finishes it comments on the ticket with the pull request, or with the reason it stopped.

**Status of this feature:** the connector is tested against stand-ins for Jira and GitHub. It has not yet been run against a real Jira site, and the automation rule in step 4 is written from Jira's documented behaviour, not from a tested setup. Expect to adjust details the first time.

## How it fits together

1. A person writes the ticket so that it contains the task (see "The ticket" below), and someone reviews it.
2. An approver adds the `factory` label.
3. A Jira automation rule sees the label and calls GitHub to start the repository's `factory` workflow, passing the ticket key.
4. The factory reads the ticket from Jira. It takes the name of the person who added the label from Jira's own history, not from the call.
5. It runs the [ticket evaluation](running.md#the-ticket-evaluation). Below the bar, it removes the label and comments on the ticket with each area's score and reason. Nothing else happens, and the ticket can be improved and labelled again.
6. At or above the bar, it moves the ticket to the In Progress status, comments that work has started, and creates a GitHub issue that mirrors the ticket. The run's history is recorded on that issue.
7. When the run ends, it comments on the Jira ticket: a link to the draft pull request, or why it stopped. If a review status is configured, it moves the ticket there when the pull request opens.

The pull request's title starts with the ticket key, so a Jira site connected to GitHub shows the pull request on the ticket by itself.

## Setting it up

There are four pieces. The first two are done in the repository by whoever maintains it. The last two need a Jira administrator.

### 1. Repository policy

Add a `jira` section to `.factory/config.json`:

```json
"jira": {
  "baseUrl": "https://your-site.atlassian.net",
  "label": "factory",
  "statuses": { "inProgress": "In Progress", "review": "Testing" },
  "approvers": ["712020:1a2b3c4d-...", "ada@example.com"]
}
```

- `statuses.inProgress` is the name of the status a ticket should be in while the factory works on it. `statuses.review` is optional: the status to move to when the pull request opens. Leave it out to keep the ticket where it is.
- These are **status** names, not transition names. Jira names a transition separately from the status it leads to, and which transitions exist depends on where the ticket is. The factory asks Jira which moves are available and takes the one that ends in the named status. If the workflow has no such move from the ticket's current status, the factory says so in its comment and carries on with the work.
- `approvers` lists the people whose label counts, by Jira account id or email address. Account ids are more reliable, because a Jira site can hide email addresses.

### 2. The workflow

The repository's `factory` workflow needs the `jira` input and the two Jira secrets passed through. A workflow written by `/factory:init` from release v0.3.0 onwards has them. See the example in [running.md](running.md).

### 3. A Jira account for the factory, and its credentials in GitHub

Create a Jira account for the factory to act as, so its comments and status changes show under its own name. It needs permission in the project to browse tickets, transition them, edit labels and add comments.

Create an API token for that account, then add two repository secrets in GitHub (Settings → Secrets and variables → Actions):

- `JIRA_EMAIL`: the account's email address.
- `JIRA_API_TOKEN`: the API token.

### 4. The automation rule

In Jira: Project settings → Automation → Create rule.

- **Trigger:** "Field value changed", for the field **Labels**.
- **Condition:** the ticket's labels contain `factory`.
- **Action:** "Send web request".
  - URL: `https://api.github.com/repos/OWNER/REPO/actions/workflows/factory.yml/dispatches`
  - Method: `POST`
  - Headers:
    - `Authorization`: `Bearer <GitHub token>` (mark it hidden)
    - `Accept`: `application/vnd.github+json`
  - Body (custom data):

    ```json
    { "ref": "main", "inputs": { "jira": "{{issue.key}}" } }
    ```

The GitHub token should be a fine-grained personal access token limited to that one repository, with a single permission: **Actions: read and write**. That lets it start workflows and nothing else: it cannot read or change code. The account that owns the token must be listed under `approvers` in `.factory/config.json`, because GitHub records that account as the one that started the run.

One rule points at one repository. A ticket that names a different repository than the one the rule calls is refused by the ticket evaluation, with a comment saying so. For a project whose tickets go to several repositories, create one rule per repository and add a condition that tells them apart, such as a Jira component.

Removing the label and adding it again fires the rule again, which is how a refused ticket is retried after it has been improved.

## The ticket

The description must contain the task: a line reading `factory-task:v1`, followed directly by a code block holding the task as JSON. Everything else in the description is for people.

`/factory:spec` in the Claude Code plugin produces a description in this shape, with the task written out in readable form above the data block. The plugin's helper prints it:

```
node src/plugin-cli.ts task <task.json> --repo OWNER/REPO --format jira
```

Because the readable part is generated from the data block, a change to the task has to be made in the block, or by producing the description again.

## What the factory checks before starting

- The ticket has the label.
- Jira's history shows who added it, and that person is listed under `jira.approvers`.
- The GitHub account that started the run is listed under `approvers`.
- The description contains a valid task, and the task names this repository.
- The ticket has not already had a run. A ticket is run once; a new attempt needs a new ticket.
- The repository is under its daily run limit.
- The ticket passes the evaluation.

## Limits

- Not yet run against a real Jira site.
- Jira Cloud only. The trigger relies on Jira Cloud automation, and the client uses the Jira Cloud REST API.
- One rule per repository.
- The mirror issue on GitHub is not kept in step with later edits to the Jira ticket. The task is fixed when work starts.
- Comments on the Jira ticket are not read by the factory.
