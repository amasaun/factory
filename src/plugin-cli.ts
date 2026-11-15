/**
 * Commands behind the Claude Code plugin's skills. They run on the person's
 * own machine, read GitHub through `gh`, and never start a run or write to a
 * run's history.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { renderTask } from "./control/issue-task.ts";
import { type Task, taskProblems } from "./control/task.ts";
import { Gh, isRepoName } from "./plugin/gh.ts";
import { INIT_FILES, type InitOptions, configFile, initProblems, workflowFile } from "./plugin/init.ts";
import { renderStatus, repoStatus } from "./plugin/status.ts";

const registryPath = () => process.env.FACTORY_REGISTRY || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "factory", "repos.json");
function readRegistry(): string[] {
  try {
    const v = JSON.parse(readFileSync(registryPath(), "utf8"));
    return Array.isArray(v?.repos) ? v.repos.filter((r: unknown) => typeof r === "string" && isRepoName(r)) : [];
  } catch {
    return [];
  }
}
function writeRegistry(repos: string[]) {
  mkdirSync(dirname(registryPath()), { recursive: true });
  writeFileSync(registryPath(), `${JSON.stringify({ repos: [...new Set(repos)].sort() }, null, 2)}\n`);
}
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const jsonArg = <T>(text: string | undefined, name: string): T => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return fail(`${name} must be JSON`);
  }
};

const commands: Record<string, (argv: string[]) => Promise<void> | void> = {
  /** Check a task and print the issue body for it. */
  task(argv) {
    const file = argv[0] ?? fail("usage: task <task.json>");
    const task = jsonArg<unknown>(readFileSync(file, "utf8"), "the task file");
    const problems = taskProblems(task);
    if (problems.length) fail(`The task is not valid:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.stdout.write(renderTask(task as Task));
  },

  /** Write the two files a repository needs. Refuses to overwrite either. */
  "init-files"(argv) {
    const { values } = parseArgs({
      args: argv,
      options: { dir: { type: "string" }, "base-branch": { type: "string" }, approver: { type: "string", multiple: true }, test: { type: "string" }, setup: { type: "string" }, version: { type: "string" } },
    });
    const o: InitOptions = {
      baseBranch: values["base-branch"] ?? "",
      approvers: values.approver ?? [],
      test: jsonArg<string[][]>(values.test, "--test"),
      setup: values.setup ? jsonArg<string[][]>(values.setup, "--setup") : [],
      version: values.version ?? "",
    };
    const problems = initProblems(o);
    if (problems.length) fail(problems.map((p) => `- ${p}`).join("\n"));
    const dir = values.dir ?? process.cwd();
    for (const path of Object.values(INIT_FILES)) {
      if (existsSync(join(dir, path))) fail(`${path} already exists; this repository looks set up already`);
    }
    for (const [path, text] of [[INIT_FILES.config, configFile(o)], [INIT_FILES.workflow, workflowFile(o)]] as const) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      console.log(`wrote ${path}`);
    }
  },

  /** Manage the list of repositories `status` reads: repos list | add <owner/name> | remove <owner/name>. */
  repos(argv) {
    const [action, repo] = argv;
    const repos = readRegistry();
    if (action === "list" || !action) {
      console.log(repos.length ? repos.join("\n") : "(no repositories registered)");
    } else if ((action === "add" || action === "remove") && repo && isRepoName(repo)) {
      writeRegistry(action === "add" ? [...repos, repo] : repos.filter((r) => r !== repo));
      console.log(`${action === "add" ? "added" : "removed"} ${repo}`);
    } else {
      fail("usage: repos list | repos add <owner/name> | repos remove <owner/name>");
    }
  },

  async status(argv) {
    const { values } = parseArgs({ args: argv, options: { repo: { type: "string", multiple: true }, json: { type: "boolean" } } });
    const repos = values.repo?.length ? values.repo : readRegistry();
    for (const r of repos) if (!isRepoName(r)) fail(`'${r}' is not an owner/name repository`);
    if (repos.length === 0) fail("No repositories to check. Pass --repo owner/name, or register one with: repos add owner/name");
    const gh = new Gh();
    const result = [];
    for (const repo of repos) result.push(await repoStatus(gh, repo));
    console.log(values.json ? JSON.stringify(result, null, 2) : renderStatus(result));
  },
};

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
if (major < 22 || (major === 22 && minor < 18)) fail(`The factory plugin needs Node 22.18 or later; this is ${process.versions.node}.`);
const command = commands[process.argv[2] ?? ""];
if (!command) fail(`usage: plugin-cli.ts <${Object.keys(commands).join("|")}> ...`);
try {
  await command!(process.argv.slice(3));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
