import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  findRepositories,
  isRebuildableIgnored,
  publishedBranchNames,
  rememberSessionSlugs,
  resolveModel,
  surveyFingerprint,
  surveyWorktrees,
  shouldWakeSelf,
  wakeMessage,
  queryProcessCwds,
  worktreeHasActiveAgent,
  type AgentSnapshot,
  type ProcessSnapshot,
} from "../skills/tend/scripts/watch.ts";

const temporary: string[] = [];
const noAgents: AgentSnapshot = { available: true, agents: [], error: null };
const noProcesses: ProcessSnapshot = { available: true, cwds: new Map(), error: null };

/** One process sitting in `path`, as the lsof sweep would report it. */
function processIn(path: string, pid = 4242): ProcessSnapshot {
  return { available: true, cwds: new Map([[path, pid]]), error: null };
}

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

/** What the maintain skill's reconcile-branches.sh --configure-supervision
 * converges into a bound checkout. Tend reads only this. */
function declareFork(repository: string, carryPrefix = "carry/"): void {
  git(repository, "config", "supervisor.trunk", "integration");
  git(repository, "config", "supervisor.mirror", "main");
  git(repository, "config", "supervisor.carryPrefix", carryPrefix);
  git(repository, "config", "supervisor.quarantinePrefix", "DELETEME/");
}

function addWorktree(repository: string, worktreeRoot: string, branch = "topic"): string {
  const path = join(worktreeRoot, "app", `worktree-${branch.replace(/\//g, "-")}`);
  run(repository, "mkdir", ["-p", join(worktreeRoot, "app")]);
  const existing = spawnSync("git", [
    "-C",
    repository,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).status === 0;
  // --force checks out a branch the main worktree already holds, which is the
  // only way to build the case where an agent worktree sits on the trunk.
  if (existing) git(repository, "worktree", "add", "--force", path, branch);
  else git(repository, "worktree", "add", "-b", branch, path, "main");
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

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
      sessionSlugs: { [worktree]: "finish-tend-worktree-cleanup" },
    });

    expect(survey.proposals).toHaveLength(1);
    expect(survey.proposals[0]).toMatchObject({
      action: "remove_worktree",
      session_slug: "finish-tend-worktree-cleanup",
      worktree,
      branch: "topic",
      branch_retained: true,
      clean: true,
    });
    expect(git(repository, "show-ref", "--heads")).toBe(refsBefore);
    expect(git(repository, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
  });

  test("refuses to remove a worktree holding ignored content no branch retains", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    writeFileSync(join(worktree, ".gitignore"), "receipts/\n");
    git(worktree, "add", ".gitignore");
    git(worktree, "commit", "-m", "ignore receipts");
    git(repository, "merge", "--ff-only", "topic");
    mkdirSync(join(worktree, "receipts"), { recursive: true });
    writeFileSync(join(worktree, "receipts", "gate.json"), "{}\n");

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    // Clean and contained — the old criterion would have removed it and taken
    // receipts/gate.json with it, held by nothing.
    expect(survey.proposals[0]?.clean).toBe(true);
    expect(survey.proposals[0]?.action).toBe("inspect");
    expect(survey.proposals[0]?.reason).toContain("ignored content no branch retains");
    expect(survey.proposals[0]?.ignored_unrecognized).toContain("receipts/");
    expect(survey.counts.downgraded_by_ignored_content).toBe(1);
  });

  test("a build tree does not block removal, and is still reported", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    writeFileSync(join(worktree, ".gitignore"), "node_modules/\n");
    git(worktree, "add", ".gitignore");
    git(worktree, "commit", "-m", "ignore deps");
    git(repository, "merge", "--ff-only", "topic");
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "x.js"), "//\n");

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals[0]?.action).toBe("remove_worktree");
    expect(survey.proposals[0]?.ignored_paths).toContain("node_modules/");
    expect(survey.proposals[0]?.ignored_unrecognized).toEqual([]);
    expect(survey.counts.downgraded_by_ignored_content).toBe(0);
  });

  test("rebuildable matching reads the last segment, never any segment", () => {
    expect(isRebuildableIgnored("node_modules/")).toBe(true);
    expect(isRebuildableIgnored("packages/app/node_modules/")).toBe(true);
    expect(isRebuildableIgnored("debug.log")).toBe(true);
    // The distinction that decides whether work is lost: a receipt living
    // under a directory called build is not a build artefact.
    expect(isRebuildableIgnored("evidence/build/receipt.json")).toBe(false);
    // Git does not always collapse an ignored directory: a .pytest_cache that
    // carries its own .gitignore is reported file by file, and those files
    // must not be judged on their own names.
    expect(isRebuildableIgnored(".pytest_cache/README.md")).toBe(true);
    expect(isRebuildableIgnored(".pytest_cache/CACHEDIR.TAG")).toBe(true);
    expect(isRebuildableIgnored("node_modules/pkg/LICENSE")).toBe(true);
    // ...but a generic name never claims its descendants.
    expect(isRebuildableIgnored("dist/")).toBe(true);
    expect(isRebuildableIgnored("dist/receipts/gate.json")).toBe(false);
    expect(isRebuildableIgnored("receipts/")).toBe(false);
    expect(isRebuildableIgnored("gate-cache/ledger.db")).toBe(false);
  });

  test("a state digest changes when the worktree changes and is stable when it does not", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    const options = {
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    };

    const first = surveyWorktrees(options).proposals[0]?.state_digest;
    expect(first).toBeTruthy();
    // Re-surveying an untouched worktree must reproduce it, or an executor
    // could never distinguish "nothing moved" from "something did".
    expect(surveyWorktrees(options).proposals[0]?.state_digest).toBe(first);

    writeFileSync(join(worktree, "scratch.txt"), "written by someone else\n");
    expect(surveyWorktrees(options).proposals[0]?.state_digest).not.toBe(first);
  });

  test("proposes catch-up AND removal when every commit the branch carries is already upstream", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    writeFileSync(join(worktree, "topic.txt"), "topic\n");
    git(worktree, "add", "topic.txt");
    git(worktree, "commit", "-m", "topic");
    const landed = git(worktree, "rev-parse", "HEAD").trim();

    // Move main first so the cherry-pick cannot reproduce the same commit id,
    // then land the branch's work on main: the branch is now genuinely ahead
    // by ancestry while carrying nothing main does not already have.
    writeFileSync(join(repository, "main.txt"), "main\n");
    git(repository, "add", "main.txt");
    git(repository, "commit", "-m", "main moved");
    git(repository, "cherry-pick", landed);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals[0]).toMatchObject({
      action: "catch_up_and_remove",
      worktree,
      ahead: 1,
      clean: true,
      branch_retained: true,
    });
    expect(survey.proposals[0]?.reason).toContain("already upstream");
  });

  test("a collapsing branch that is published keeps its worktree and is offered the catch-up alone", () => {
    const { projects, repository, worktreeRoot } = fixture();
    // A fork model whose trunk is still main: the publication backstop is
    // gated on fork_model, and this keeps the branch shape of the test simple.
    git(repository, "config", "supervisor.trunk", "main");
    const worktree = addWorktree(repository, worktreeRoot);
    writeFileSync(join(worktree, "topic.txt"), "topic\n");
    git(worktree, "add", "topic.txt");
    git(worktree, "commit", "-m", "topic");
    const landed = git(worktree, "rev-parse", "HEAD").trim();
    writeFileSync(join(repository, "main.txt"), "main\n");
    git(repository, "add", "main.txt");
    git(repository, "commit", "-m", "main moved");
    git(repository, "cherry-pick", landed);
    // Somebody's carry, whatever it is named: the removal half must not fire.
    git(repository, "update-ref", "refs/remotes/origin/topic", landed);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals[0]?.action).toBe("catch_up_to_trunk");
    expect(survey.proposals[0]?.reason).toContain("published on a remote");
  });

  test("reduces a lifecycle proposal to inspect when the worktree was written inside the quiet window", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);

    // The fixture was just built, so its Git metadata is seconds old — exactly
    // the shape of an agent working through a shell that holds no descriptor.
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 900,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.counts.downgraded_by_recent_activity).toBe(1);
    expect(survey.proposals[0]?.action).toBe("inspect");
    expect(survey.proposals[0]?.reason).toContain("quiet window");
    expect(survey.proposals[0]?.last_activity_seconds).not.toBeNull();
    // The worktree still appears; it just stops being actionable.
    expect(survey.proposals).toHaveLength(1);
  });

  test("a zero quiet window disables the activity check entirely", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.counts.downgraded_by_recent_activity).toBe(0);
    expect(survey.proposals[0]?.action).toBe("remove_worktree");
    // Evidence is still reported even when it gates nothing.
    expect(survey.proposals[0]?.last_activity_seconds).not.toBeNull();
  });

  test("reduces a removal to inspect when a process works in a worktree no agent row claims", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: processIn(join(worktree, "src"), 9182),
    });

    // The worktree is still reported — suppressing it would make a worktree
    // holding a leaked helper permanently unremovable — but nothing about it
    // is actionable until a human confirms the process is finished.
    expect(survey.proposals).toHaveLength(1);
    expect(survey.proposals[0].action).toBe("inspect");
    expect(survey.proposals[0].reason).toContain("process 9182 is working inside the worktree");
    expect(survey.counts.downgraded_by_process).toBe(1);
    expect(survey.counts.protected_by_agent).toBe(0);
  });

  test("names the lowest pid so the reason is stable across sweeps", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    // Two processes in the worktree, discovered in the order lsof happened to
    // emit them. The reason must not depend on that order.
    const processes: ProcessSnapshot = {
      available: true,
      cwds: new Map([[join(worktree, "b"), 9000], [worktree, 120]]),
      error: null,
    };

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes,
    });

    expect(survey.proposals[0].reason).toContain("process 120 is working inside the worktree");
  });

  test("ignores git processes, which are the survey's own instrument", () => {
    // `git -C <worktree>` chdirs, so a concurrent survey's gits appear to
    // occupy worktrees. A stub lsof stands in for the real sweep.
    const root = mkdtempSync(join(tmpdir(), "tend-lsof-"));
    temporary.push(root);
    const stub = join(root, "lsof");
    writeFileSync(stub, [
      "#!/bin/sh",
      "printf 'p101\\ncgit\\nfcwd\\nn/repo/worktree\\n'",
      "printf 'p202\\ncnode\\nfcwd\\nn/repo/other\\n'",
      "",
    ].join("\n"));
    run(root, "chmod", ["+x", stub]);

    const snapshot = queryProcessCwds(stub);

    expect(snapshot.available).toBe(true);
    expect(snapshot.cwds.get("/repo/worktree")).toBeUndefined();
    expect(snapshot.cwds.get("/repo/other")).toBe(202);
  });

  test("leaves proposals alone when no process is inside the worktree", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: processIn("/somewhere/else"),
    });

    expect(survey.proposals[0].action).toBe("remove_worktree");
    expect(survey.counts.downgraded_by_process).toBe(0);
  });

  test("an agent row still protects outright, without a downgrade", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    const ownership: AgentSnapshot = {
      available: true,
      agents: [{ cwd: worktree }],
      error: null,
    };

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership,
      processes: processIn(worktree),
    });

    expect(survey.proposals).toHaveLength(0);
    expect(survey.counts.protected_by_agent).toBe(1);
    expect(survey.counts.downgraded_by_process).toBe(0);
  });

  test("reports an unavailable process sweep as an issue", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: { available: false, cwds: new Map(), error: "lsof absent" },
    });

    expect(survey.issues.some((issue) => issue.reason.includes("process backstop is unavailable")))
      .toBe(true);
  });

  test("retains Herdr's conversation slug after its agent row disappears", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot);
    const remembered: Record<string, string> = {};

    rememberSessionSlugs(remembered, [{
      cwd: join(worktree, "nested"),
      tokens: { conversation: "repair-agent-worktree-lifecycle" },
    }]);
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
      sessionSlugs: remembered,
    });

    expect(remembered[join(worktree, "nested")]).toBe("repair-agent-worktree-lifecycle");
    expect(survey.proposals[0]?.session_slug).toBe("repair-agent-worktree-lifecycle");
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

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });

    expect(survey.proposals[0]).toMatchObject({
      action: "catch_up_to_trunk",
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
      const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership });
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
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: { available: false, agents: [], error: "socket absent" },
      processes: noProcesses,
    });

    expect(survey.ownership_available).toBe(false);
    expect(survey.proposals).toHaveLength(0);
    expect(survey.issues[0]?.reason).toContain("socket absent");
  });

  test("judges a declared fork against its integration trunk, not main", () => {
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot, "landed");
    // Integration carries the work; the mirror branch stays where upstream is.
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    writeFileSync(join(worktree, "landed.txt"), "landed\n");
    git(worktree, "add", "landed.txt");
    git(worktree, "commit", "-m", "landed");
    git(repository, "branch", "-f", "integration", git(worktree, "rev-parse", "HEAD"));

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });

    expect(survey.issues).toHaveLength(0);
    expect(survey.proposals[0]).toMatchObject({
      action: "remove_worktree",
      worktree,
      trunk: "integration",
      fork_model: true,
      branch_retained: true,
    });
    expect(survey.proposals[0]?.reason).toContain("contained in local integration");
  });

  test("never proposes removal for branches the declared fork model keeps", () => {
    // A published carry head is an ancestor of integration by design, so
    // containment must not read as evidence that its worktree is finished.
    for (const branch of ["carry/effort", "DELETEME/old-feature", "integration", "main"]) {
      const { projects, repository, worktreeRoot } = fixture();
      git(repository, "branch", "integration", "main");
      declareFork(repository);
      const worktree = addWorktree(repository, worktreeRoot, branch);

      const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });

      expect(survey.proposals, branch).toHaveLength(1);
      expect(survey.proposals[0], branch).toMatchObject({ action: "inspect", fork_model: true });
      expect(survey.proposals[0]?.reason, branch).toContain("the worktree holds");
    }
  });

  test("reports a fork whose declared trunk branch is absent", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    declareFork(repository);

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });

    expect(survey.proposals).toHaveLength(0);
    expect(survey.issues[0]?.reason).toContain("declares integration as its trunk");
  });

  test("reports a fork whose declared workshop is missing", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    git(repository, "config", "supervisor.workshop", join(projects, "absent-workshop"));

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });

    expect(survey.issues[0]?.reason).toContain("declared workshop");
    expect(survey.issues[0]?.reason).toContain("is missing");
  });

  test("an unsupervised repository still resolves to the main-based model", () => {
    const { repository } = fixture();
    expect(resolveModel(repository)).toMatchObject({ trunk: "main", fork: false, mirror: null });
  });

  test("an empty declared carry prefix does not hold every branch", () => {
    // A linear-stack fork carries no carry heads; an empty declaration is a
    // real answer, and must not degrade into a prefix that matches anything.
    const { projects, repository, worktreeRoot } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository, "");
    const worktree = addWorktree(repository, worktreeRoot, "topic");

    expect(resolveModel(repository).carry_prefixes).toEqual([]);
    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });
    expect(survey.proposals[0]).toMatchObject({ action: "remove_worktree", worktree });
  });

  test("routes dirty and ahead-only inactive worktrees to inspection", () => {
    const dirty = fixture();
    const dirtyWorktree = addWorktree(dirty.repository, dirty.worktreeRoot, "dirty");
    writeFileSync(join(dirtyWorktree, "dirty.txt"), "not committed\n");
    const dirtySurvey = surveyWorktrees({
      projectRoots: [dirty.projects],
      worktreeRoots: [dirty.worktreeRoot],
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(dirtySurvey.proposals[0]).toMatchObject({ action: "inspect", clean: false });

    const ahead = fixture();
    const aheadWorktree = addWorktree(ahead.repository, ahead.worktreeRoot, "ahead");
    writeFileSync(join(aheadWorktree, "ahead.txt"), "committed\n");
    git(aheadWorktree, "add", "ahead.txt");
    git(aheadWorktree, "commit", "-m", "ahead");
    const aheadSurvey = surveyWorktrees({
      projectRoots: [ahead.projects],
      worktreeRoots: [ahead.worktreeRoot],
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(aheadSurvey.proposals[0]).toMatchObject({ action: "inspect", ahead: 1, behind: 0 });
  });

  test("fingerprints ignore timestamps and wake records carry the complete survey", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    const first = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], activityWindowSeconds: 0, ownership: noAgents, processes: noProcesses });
    const second = { ...first, generated_at: "later" };

    expect(surveyFingerprint(first)).toBe(surveyFingerprint(second));
    expect(shouldWakeSelf(false, first)).toBe(false);
    expect(shouldWakeSelf(true, first)).toBe(true);
    expect(wakeMessage(first)).toContain(JSON.stringify(first));
    expect(wakeMessage(first)).toContain("session_slug");
    expect(wakeMessage(first)).toContain("Do not perform any proposed action");
  });

  test("considers a linked worktree that lives outside the Herdr root", () => {
    const { root, projects, repository, worktreeRoot } = fixture();
    // A worktree created somewhere else entirely — a replay directory, a
    // Scratch volume, a fan-out under ~/worktrees. Agentsource reports these;
    // before worktreeRoots became a restriction rather than the scope, Tend
    // could not see them at all.
    const outside = join(root, "elsewhere", "app-landed");
    run(root, "mkdir", ["-p", join(root, "elsewhere")]);
    git(repository, "worktree", "add", "-b", "landed-elsewhere", outside, "main");
    git(outside, "config", "user.name", "Tend Test");
    git(outside, "config", "user.email", "tend@example.test");
    writeFileSync(join(outside, "landed.txt"), "landed\n");
    git(outside, "add", "landed.txt");
    git(outside, "commit", "-m", "landed elsewhere");
    // main is checked out in the main worktree, so land it by fast-forward.
    git(repository, "merge", "--ff-only", "landed-elsewhere");

    const unrestricted = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [],
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(unrestricted.proposals.map((proposal) => proposal.worktree)).toContain(
      realpathSync.native(outside),
    );
    expect(unrestricted.counts.linked_worktrees).toBe(1);
    expect(unrestricted.counts.herdr_worktrees).toBe(0);

    // The old behaviour remains reachable as an explicit restriction.
    const restricted = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(restricted.proposals).toHaveLength(0);
  });

  test("never proposes lifecycle work on a repository's main checkout", () => {
    const { projects, repository } = fixture();
    // The main checkout is trivially clean and contained in its own trunk, so
    // only an explicit guard keeps it out of the candidate set once the
    // location filter no longer excludes it by accident.
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [],
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.counts.linked_worktrees).toBe(0);
    expect(survey.proposals.map((proposal) => proposal.worktree)).not.toContain(
      realpathSync.native(repository),
    );
    expect(survey.proposals).toHaveLength(0);
  });

  test("holds carries under every declared prefix and every declared exact ref", () => {
    // A fork may publish carried features under more than one namespace, and a
    // carry whose published name cannot be renamed yet lives under none of
    // them. Both are declarations, and both must hold their worktree.
    const { projects, repository, worktreeRoot } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    git(repository, "config", "--add", "supervisor.carryPrefix", "fix/");
    git(repository, "config", "--add", "supervisor.carryRef", "driver-sync-wip");
    addWorktree(repository, worktreeRoot, "carry/declared");
    addWorktree(repository, worktreeRoot, "fix/second-prefix");
    addWorktree(repository, worktreeRoot, "driver-sync-wip");

    const model = resolveModel(repository);
    expect(model.carry_prefixes).toEqual(["carry/", "fix/"]);
    expect(model.carry_refs).toEqual(["driver-sync-wip"]);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals).toHaveLength(3);
    const reasonFor = (branch: string) =>
      survey.proposals.find((proposal) => proposal.branch === branch);
    expect(reasonFor("carry/declared")).toMatchObject({ action: "inspect" });
    expect(reasonFor("carry/declared")?.reason).toContain("declared prefix carry/");
    expect(reasonFor("fix/second-prefix")).toMatchObject({ action: "inspect" });
    expect(reasonFor("fix/second-prefix")?.reason).toContain("declared prefix fix/");
    expect(reasonFor("driver-sync-wip")).toMatchObject({ action: "inspect" });
    expect(reasonFor("driver-sync-wip")?.reason).toContain(
      "the declared carry head driver-sync-wip",
    );
  });

  test("a published branch in a fork is never proposed for removal", () => {
    // The backstop for what nobody declared: a published carry head is an
    // ancestor of integration by design, so containment cannot be evidence
    // that its worktree is finished, whatever the branch is named.
    const { projects, repository, worktreeRoot, root } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    const worktree = addWorktree(repository, worktreeRoot, "fix/unrenamed-carry");

    // Publication is a local remote-tracking ref; the survey never fetches.
    const remote = join(root, "remote.git");
    run(root, "git", ["init", "--bare", remote]);
    git(repository, "remote", "add", "fork", remote);
    git(repository, "push", "--quiet", "fork", "fix/unrenamed-carry");
    git(repository, "fetch", "--quiet", "fork");
    expect(publishedBranchNames(repository).names.has("fix/unrenamed-carry")).toBe(true);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals).toHaveLength(1);
    expect(survey.proposals[0]).toMatchObject({ action: "inspect", worktree });
    expect(survey.proposals[0]?.reason).toContain("published on a remote");
  });

  test("the publication backstop does not apply outside a fork model", () => {
    // An ordinary main-based repository has no carry semantics to protect, so
    // a published, landed topic branch stays an ordinary removal candidate.
    const { projects, repository, worktreeRoot, root } = fixture();
    const worktree = addWorktree(repository, worktreeRoot, "topic");
    const remote = join(root, "remote.git");
    run(root, "git", ["init", "--bare", remote]);
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "--quiet", "origin", "topic");
    git(repository, "fetch", "--quiet", "origin");

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals[0]).toMatchObject({ action: "remove_worktree", worktree });
  });

  test("discovery follows a workshop's declared checkouts into nested forks", () => {
    // A fork kept inside its workshop at <workshop>/fork/<name> is deeper than
    // the depth-one walk reaches. The workshop declares the path instead, and
    // one workshop may bind several forks.
    const { projects, repository: workshop } = fixture();
    const forks = [1, 2].map((index) => {
      const fork = join(workshop, "fork", `bound-${index}`);
      run(workshop, "mkdir", ["-p", fork]);
      git(fork, "init", "-b", "main");
      git(fork, "config", "user.name", "Tend Test");
      git(fork, "config", "user.email", "tend@example.test");
      writeFileSync(join(fork, "file.txt"), "initial\n");
      git(fork, "add", "file.txt");
      git(fork, "commit", "-m", "initial");
      git(workshop, "config", "--add", "supervisor.checkout", fork);
      return realpathSync.native(fork);
    });

    const discovered = findRepositories([projects]);

    expect(discovered.issues).toEqual([]);
    for (const fork of forks) expect(discovered.repositories).toContain(fork);
  });

  test("reports a declared checkout that cannot be followed", () => {
    const { projects, repository: workshop } = fixture();
    git(workshop, "config", "--add", "supervisor.checkout", join(projects, "absent-fork"));
    git(workshop, "config", "--add", "supervisor.checkout", "fork/relative");
    const notARepository = join(projects, "plain-directory");
    run(projects, "mkdir", ["-p", notARepository]);
    git(workshop, "config", "--add", "supervisor.checkout", notARepository);

    const issues = findRepositories([projects]).issues;
    // Every issue names the repository whose declaration produced it, not the
    // path being complained about.
    for (const issue of issues) {
      expect(issue.repository).toBe(realpathSync.native(workshop));
    }
    const reasons = issues.map((issue) => issue.reason).join("\n");

    expect(reasons).toContain("is not on disk");
    expect(reasons).toContain("is not an absolute path");
    expect(reasons).toContain("is not a Git checkout root");
  });

  test("a declared checkout inside a repository is reported, never followed", () => {
    // `git rev-parse --git-common-dir` walks up, so a path that merely sits
    // inside a repository answers for the enclosing one. Validating with it
    // alone made a fork that failed to clone indistinguishable from a healthy
    // one, and let a stale declaration drag an undeclared repository into the
    // survey — where Tend would go on to propose removing its worktrees.
    const { projects, repository: workshop } = fixture();
    const uncloned = join(workshop, "fork", "never-cloned");
    run(workshop, "mkdir", ["-p", uncloned]);
    git(workshop, "config", "--add", "supervisor.checkout", uncloned);

    const outsider = join(projects, "outsider");
    run(projects, "mkdir", ["-p", join(outsider, "vendor", "inside")]);
    git(outsider, "init", "-b", "main");
    git(outsider, "config", "user.name", "Tend Test");
    git(outsider, "config", "user.email", "tend@example.test");
    writeFileSync(join(outsider, "file.txt"), "initial\n");
    git(outsider, "add", "file.txt");
    git(outsider, "commit", "-m", "initial");
    const stale = fixture();
    git(stale.repository, "config", "--add", "supervisor.checkout", join(outsider, "vendor", "inside"));

    const declared = findRepositories([projects]);
    expect(declared.repositories).not.toContain(realpathSync.native(uncloned));
    expect(declared.issues.map((issue) => issue.reason).join("\n")).toContain(
      "is not a Git checkout root",
    );

    // The enclosing repository must not be admitted by way of the declaration.
    const scoped = findRepositories([stale.projects]);
    expect(scoped.repositories).not.toContain(realpathSync.native(outsider));
    expect(scoped.issues).toHaveLength(1);
  });

  test("the long-running watcher survives its first publish", async () => {
    // findRepositories() changed shape and this call site was missed, so the
    // watcher emitted one survey and died on `{} is not iterable`. Only --once
    // was exercised by tests, so the entire long-running mode — the point of
    // the skill — was broken while the suite stayed green.
    const { projects } = fixture();
    const stub = join(projects, "herdr-stub");
    writeFileSync(stub, '#!/bin/sh\nprintf \'{"result":{"agents":[]}}\'\n');
    run(projects, "chmod", ["+x", stub]);
    const watcher = join(import.meta.dir, "..", "skills", "tend", "scripts", "watch.ts");
    const child = spawn(
      "bun",
      [watcher, "--project-root", projects, "--socket", join(projects, "absent.sock")],
      {
        env: { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: stub },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const firstRecord = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error("no survey was emitted")), 20_000);
        child.stdout.on("data", (chunk: unknown) => {
          buffer += String(chunk);
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          resolve(buffer.slice(0, newline));
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`the watcher exited with ${code} before emitting a survey`));
        });
      });
      expect(JSON.parse(firstRecord)).toMatchObject({
        type: "tend_survey",
        occasion: "start",
      });
      // The regression is death immediately after that first record, so the
      // assertion that matters is that it is still running a moment later.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, 40_000);

  test("publication is read per remote, not per path component", () => {
    // A remote name may contain a slash. Stripping the first component then
    // yields the wrong branch name, the backstop never fires, and a genuinely
    // published carry is proposed for removal — the severe direction.
    const { projects, repository, worktreeRoot, root } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    const worktree = addWorktree(repository, worktreeRoot, "unrenamed-carry");
    const remote = join(root, "slashed.git");
    run(root, "git", ["init", "--bare", remote]);
    git(repository, "remote", "add", "up/stream", remote);
    git(repository, "push", "--quiet", "up/stream", "unrenamed-carry");
    git(repository, "fetch", "--quiet", "up/stream");

    expect(publishedBranchNames(repository).names.has("unrenamed-carry")).toBe(true);
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(survey.proposals[0]).toMatchObject({ action: "inspect", worktree });
  });

  test("a branch published under a different name upstream is still published", () => {
    // The carry the backstop exists for: its published name cannot be matched
    // locally. The evidence is branch.<name>.merge, already in the repository.
    const { projects, repository, worktreeRoot, root } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    const worktree = addWorktree(repository, worktreeRoot, "driver-sync");
    const remote = join(root, "renaming.git");
    run(root, "git", ["init", "--bare", remote]);
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "--quiet", "-u", "origin", "driver-sync:refs/heads/vendor/driver-sync");

    expect(publishedBranchNames(repository).names.has("driver-sync")).toBe(true);
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(survey.proposals[0]).toMatchObject({ action: "inspect", worktree });
  });

  test("a declaration containing a newline stays one declaration", () => {
    // Splitting --get-all output on newlines read `carry/\nf` as two prefixes,
    // and the phantom `f` silently held every branch beginning with f.
    const { projects, repository, worktreeRoot } = fixture();
    git(repository, "branch", "integration", "main");
    git(repository, "config", "supervisor.trunk", "integration");
    git(repository, "config", "supervisor.carryPrefix", "carry/\nf");
    const worktree = addWorktree(repository, worktreeRoot, "feature-unrelated");

    expect(resolveModel(repository).carry_prefixes).toEqual(["carry/\nf"]);
    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });
    expect(survey.proposals[0]).toMatchObject({ action: "remove_worktree", worktree });
  });

  test("a global declaration does not make every repository a fork", () => {
    // git config reads global and system scope by default, so one stray key in
    // ~/.gitconfig would mark every repository on the machine a fork and repeat
    // its issues once per repository.
    const { projects, repository } = fixture();
    const globalConfig = join(projects, "gitconfig-global");
    writeFileSync(
      globalConfig,
      "[supervisor]\n\ttrunk = integration\n\tcarryPrefix = carry/\n\tcheckout = /nowhere/at/all\n",
    );
    const scoped = spawnSync("git", ["-C", repository, "config", "--get", "supervisor.trunk"], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    // Git itself does see it; the point is that Tend must not.
    expect(scoped.stdout.trim()).toBe("integration");

    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(resolveModel(repository)).toMatchObject({ trunk: "main", fork: false });
      expect(findRepositories([projects]).issues).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  test("a declared carry ref holds that branch exactly, never as a prefix", () => {
    // carryRef is an exact name. Turning the lookup into a startsWith loop for
    // symmetry with the prefixes would silently widen every declaration.
    const { projects, repository, worktreeRoot } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    git(repository, "config", "--add", "supervisor.carryRef", "driver-sync");
    addWorktree(repository, worktreeRoot, "driver-sync");
    const extended = addWorktree(repository, worktreeRoot, "driver-sync-wip");

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    const held = survey.proposals.find((proposal) => proposal.branch === "driver-sync");
    expect(held).toMatchObject({ action: "inspect" });
    expect(held?.reason).toContain("the declared carry head driver-sync");
    // The longer name merely starts with the declared one, so it is not held.
    expect(survey.proposals.find((proposal) => proposal.branch === "driver-sync-wip"))
      .toMatchObject({ action: "remove_worktree", worktree: extended });
  });

  test("declarations are followed to a fixed point and a cycle terminates", () => {
    // The chain is a workshop declaring a fork that declares another checkout;
    // the cycle is two repositories declaring each other. Both are promised by
    // discovery and neither was covered.
    const { projects, repository: first } = fixture();
    const build = (name: string) => {
      const path = join(projects, name);
      run(projects, "mkdir", ["-p", path]);
      git(path, "init", "-b", "main");
      git(path, "config", "user.name", "Tend Test");
      git(path, "config", "user.email", "tend@example.test");
      writeFileSync(join(path, "file.txt"), "initial\n");
      git(path, "add", "file.txt");
      git(path, "commit", "-m", "initial");
      return realpathSync.native(path);
    };
    // Nested so that only the declaration chain can reach them.
    const middle = build(join("holder", "middle"));
    const last = build(join("holder", "middle", "inner", "last"));
    git(first, "config", "--add", "supervisor.checkout", middle);
    git(middle, "config", "--add", "supervisor.checkout", last);
    // And back to the start, which must not loop.
    git(last, "config", "--add", "supervisor.checkout", realpathSync.native(first));

    const declared = findRepositories([projects]);

    expect(declared.issues).toEqual([]);
    expect(declared.repositories).toContain(middle);
    expect(declared.repositories).toContain(last);
    // Each repository appears once despite being declared from two directions.
    expect(new Set(declared.repositories).size).toBe(declared.repositories.length);
  });

  test("a declared checkout keeps a path Git may legally hand back untrimmed", () => {
    // A checkout value is a filesystem path, where trailing whitespace is
    // significant and which git config preserves by quoting. Trimming any
    // path Git returns — the declaration, or `rev-parse --show-toplevel`
    // used to validate it — drops the fork from the survey and reports a
    // reason that is false: the path is on disk, the read mangled it.
    const { projects, repository: workshop } = fixture();
    const bound = join(workshop, "fork", "bound ");
    run(workshop, "mkdir", ["-p", bound]);
    git(bound, "init", "-b", "main");
    git(bound, "config", "user.name", "Tend Test");
    git(bound, "config", "user.email", "tend@example.test");
    writeFileSync(join(bound, "file.txt"), "initial\n");
    git(bound, "add", "file.txt");
    git(bound, "commit", "-m", "initial");
    git(workshop, "config", "--add", "supervisor.checkout", bound);

    const declared = findRepositories([projects]);

    expect(declared.issues).toEqual([]);
    expect(declared.repositories).toContain(realpathSync.native(bound));
  });

  test("a declared checkout may name a linked worktree root", () => {
    // Root-ness is the test, not main-checkout-ness: a linked worktree is a
    // real checkout, and resolves to the repository it belongs to.
    const { projects, repository, worktreeRoot } = fixture();
    const worktree = addWorktree(repository, worktreeRoot, "declared-wt");
    const other = fixture();
    git(other.repository, "config", "--add", "supervisor.checkout", worktree);

    const declared = findRepositories([other.projects]);

    expect(declared.issues).toEqual([]);
    expect(declared.repositories).toContain(realpathSync.native(repository));
  });

  test("every new declaration is optional", () => {
    // Until a workshop converges the new keys, Tend must behave exactly as it
    // did before they existed: no extra prefixes, no exact refs, no declared
    // checkouts, and no issues invented from their absence.
    const { projects, repository, worktreeRoot } = fixture();
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    const worktree = addWorktree(repository, worktreeRoot, "landed");

    const model = resolveModel(repository);
    expect(model.carry_prefixes).toEqual(["carry/"]);
    expect(model.carry_refs).toEqual([]);
    expect(findRepositories([projects]).issues).toEqual([]);

    const survey = surveyWorktrees({
      projectRoots: [projects],
      worktreeRoots: [worktreeRoot],
      activityWindowSeconds: 0,
      ownership: noAgents,
      processes: noProcesses,
    });

    expect(survey.proposals[0]).toMatchObject({ action: "remove_worktree", worktree });
  });
});
