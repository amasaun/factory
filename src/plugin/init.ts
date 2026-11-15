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
      budget: { repairRounds: 1, handoffTokens: 150000, builderUsd: 1, judgeUsd: 0.5 },
    },
    null,
    2,
  )}\n`;
}

export function workflowFile(o: InitOptions): string {
  return `# Start a factory run for an approved task issue. Starting this workflow is
# the approval: only logins listed under "approvers" in .factory/config.json
# may do it. See https://github.com/amasaun/factory/blob/main/docs/running.md
name: factory
on:
  workflow_dispatch:
    inputs:
      issue:
        description: Number of the task issue to build
        required: true
        type: number

concurrency:
  group: factory-\${{ inputs.issue }}
  cancel-in-progress: false

permissions: {}

jobs:
  run:
    permissions:
      contents: write
      pull-requests: write
      issues: write
    uses: amasaun/factory/.github/workflows/run.yml@${o.version}
    with:
      issue: \${{ fromJSON(inputs.issue) }}
    secrets:
      # Set one of these as a repository secret.
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;
}

export const INIT_FILES = { config: ".factory/config.json", workflow: ".github/workflows/factory.yml" } as const;
