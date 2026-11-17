/** The two files a repository needs to use the factory. */

export interface InitOptions {
  baseBranch: string;
  approvers: string[];
  /** Test commands as argument arrays, run without a shell. */
  test: string[][];
  setup?: string[][];
  /** Release of the factory to pin, such as v0.1.0. */
  version: string;
}

export function initProblems(o: InitOptions): string[] {
  const problems: string[] = [];
  const isArgv = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
  if (!/^v\d+\.\d+\.\d+$/.test(o.version)) problems.push("version must look like v0.1.0");
  if (!/^[A-Za-z0-9._/-]+$/.test(o.baseBranch)) problems.push("base branch name is not valid");
  if (o.approvers.length === 0 || !o.approvers.every((a) => /^[A-Za-z0-9-]+(\[bot\])?$/.test(a))) problems.push("approvers must be GitHub logins");
  if (o.test.length === 0 || !o.test.every(isArgv)) problems.push("at least one test command is needed, each as an argument array");
  if (o.setup && !o.setup.every(isArgv)) problems.push("setup commands must be argument arrays");
  return problems;
}

export function configFile(o: InitOptions): string {
  return `${JSON.stringify(
    {
      version: 1,
      baseBranch: o.baseBranch,
      approvers: o.approvers,
      commands: { setup: o.setup ?? [], test: o.test },
      extraProtected: [],
      budget: { repairRounds: 1, handoffTokens: 150000, builderUsd: 1, judgeUsd: 0.5, runsPerDay: 10 },
      evaluation: { model: "sonnet", minScore: 4.5, minAreaScore: 4 },
    },
    null,
    2,
  )}\n`;
}

export function workflowFile(o: InitOptions): string {
  return `# Starts a factory run for a task issue, either when the "factory" label is
# added to it or when started by hand. Adding the label is the approval: only
# logins listed under "approvers" in .factory/config.json count, and the task
# must pass the ticket evaluation. See
# https://github.com/amasaun/factory/blob/main/docs/running.md
name: factory
on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue:
        description: Number of the task issue to build
        type: string
        default: ""
      jira:
        description: Key of the Jira ticket to build, such as ABC-123
        type: string
        default: ""

concurrency:
  group: factory-\${{ github.event.issue.number || inputs.issue || inputs.jira }}
  cancel-in-progress: false

permissions: {}

jobs:
  run:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'factory'
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read
    uses: amasaun/factory/.github/workflows/run.yml@${o.version}
    with:
      issue: \${{ format('{0}', github.event.issue.number || inputs.issue) }}
      jira: \${{ inputs.jira }}
    secrets:
      # Set one of these as a repository secret.
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
      # Only needed when tickets live in Jira.
      JIRA_EMAIL: \${{ secrets.JIRA_EMAIL }}
      JIRA_API_TOKEN: \${{ secrets.JIRA_API_TOKEN }}
`;
}

export const INIT_FILES = { config: ".factory/config.json", workflow: ".github/workflows/factory.yml" } as const;
