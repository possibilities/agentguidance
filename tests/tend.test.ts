import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  surveyFingerprint,
  surveyWorktrees,
  shouldWakeSelf,
  wakeMessage,
  worktreeHasActiveAgent,
  type AgentSnapshot,
} from "../skills/tend/scripts/watch.ts";

const temporary: string[] = [];
const noAgents: AgentSnapshot = { available: true, agents: [], error: null };

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return run(cwd, "git", args);
}

function fixture(): { root: string; projects: string; repository: string; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "tend-test-"));
  temporary.push(root);
  const projects = join(root, "projects");
  const repository = join(projects, "app");
  const worktreeRoot = join(root, ".herdr", "worktrees");
  run(root, "mkdir", ["-p", repository, worktreeRoot]);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Tend Test");
  git(repository, "config", "user.email", "tend@example.test");
  writeFileSync(join(repository, "file.txt"), "initial\n");
  git(repository, "add", "file.txt");
  git(repository, "commit", "-m", "initial");
  return { root, projects, repository, worktreeRoot };
}

function addWorktree(repository: string, worktreeRoot: string, branch = "topic"): string {
  const path = join(worktreeRoot, "app", `worktree-${branch}`);
  run(repository, "mkdir", ["-p", join(worktreeRoot, "app")]);
  git(repository, "worktree", "add", "-b", branch, path, "main");
  git(path, "config", "user.name", "Tend Test");
  git(path, "config", "user.email", "tend@example.test");
  return realpathSync.native(path);
}

describe("Tend survey", () => {
  test("proposes removal for a clean inactive Herdr worktree and retains its branch", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    const refsBefore = git(repository, "show-ref", "--heads");
    const worktreesBefore = git(repository, "worktree", "list", "--porcelain");

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoot, ownership: noAgents });

    expect(survey.proposals).toHaveLength(1);
    expect(survey.proposals[0]).toMatchObject({
      action: "remove_worktree",
      worktree,
      branch: "topic",
      branch_retained: true,
      clean: true,
    });
    expect(git(repository, "show-ref", "--heads")).toBe(refsBefore);
    expect(git(repository, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
  });

  test("proposes catch-up when an inactive branch and local main diverged", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    writeFileSync(join(worktree, "topic.txt"), "topic\n");
    git(worktree, "add", "topic.txt");
    git(worktree, "commit", "-m", "topic");
    writeFileSync(join(repository, "main.txt"), "main\n");
    git(repository, "add", "main.txt");
    git(repository, "commit", "-m", "main moved");

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoot, ownership: noAgents });

    expect(survey.proposals[0]).toMatchObject({
      action: "catch_up_to_main",
      worktree,
      ahead: 1,
      behind: 1,
      clean: true,
    });
  });

  test("every live Herdr agent status protects its worktree", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    for (const status of ["idle", "done", "blocked", "working", "unknown"]) {
      const ownership: AgentSnapshot = {
        available: true,
        agents: [{ pane_id: "w1:p1", agent_status: status, cwd: worktree }],
        error: null,
      };
      const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoot, ownership });
      expect(survey.proposals, status).toHaveLength(0);
      expect(survey.counts.protected_by_agent, status).toBe(1);
    }
    const nested = join(worktree, "nested");
    mkdirSync(nested);
    expect(worktreeHasActiveAgent(worktree, [{ foreground_cwd: nested }])).toBe(true);
  });

  test("fails closed when Herdr ownership is unavailable", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoot,
      ownership: { available: false, agents: [], error: "socket absent" },
    });

    expect(survey.ownership_available).toBe(false);
    expect(survey.proposals).toHaveLength(0);
    expect(survey.issues[0]?.reason).toContain("socket absent");
  });

  test("does not apply main-based proposals to a configured non-main trunk", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    git(repository, "branch", "integration", "main");
    git(repository, "config", "supervisor.trunk", "integration");

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoot, ownership: noAgents });

    expect(survey.proposals).toHaveLength(0);
    expect(survey.issues[0]?.reason).toContain("integrates into integration, not main");
  });

  test("routes dirty and ahead-only inactive worktrees to inspection", () => {
    const dirty = fixture();
    const dirtyWorktree = addWorktree(dirty.repository, dirty.worktreeRoot, "dirty");
    writeFileSync(join(dirtyWorktree, "dirty.txt"), "not committed\n");
    const dirtySurvey = surveyWorktrees({
      projectRoots: [dirty.projects],
      worktreeRoot: dirty.worktreeRoot,
      ownership: noAgents,
    });
    expect(dirtySurvey.proposals[0]).toMatchObject({ action: "inspect", clean: false });

    const ahead = fixture();
    const aheadWorktree = addWorktree(ahead.repository, ahead.worktreeRoot, "ahead");
    writeFileSync(join(aheadWorktree, "ahead.txt"), "committed\n");
    git(aheadWorktree, "add", "ahead.txt");
    git(aheadWorktree, "commit", "-m", "ahead");
    const aheadSurvey = surveyWorktrees({
      projectRoots: [ahead.projects],
      worktreeRoot: ahead.worktreeRoot,
      ownership: noAgents,
    });
    expect(aheadSurvey.proposals[0]).toMatchObject({ action: "inspect", ahead: 1, behind: 0 });
  });

  test("fingerprints ignore timestamps and wake records carry the complete survey", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    const first = surveyWorktrees({ projectRoots: [projects], worktreeRoot, ownership: noAgents });
    const second = { ...first, generated_at: "later" };

    expect(surveyFingerprint(first)).toBe(surveyFingerprint(second));
    expect(shouldWakeSelf(false, first)).toBe(false);
    expect(shouldWakeSelf(true, first)).toBe(true);
    expect(wakeMessage(first)).toContain(JSON.stringify(first));
    expect(wakeMessage(first)).toContain("Do not perform any proposed action");
  });
});
