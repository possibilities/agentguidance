import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  rememberSessionSlugs,
  resolveModel,
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
      ownership: noAgents,
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
      ownership: noAgents,
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

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });

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
      const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership });
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
      ownership: { available: false, agents: [], error: "socket absent" },
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

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });

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

      const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });

      expect(survey.proposals, branch).toHaveLength(1);
      expect(survey.proposals[0], branch).toMatchObject({ action: "inspect", fork_model: true });
      expect(survey.proposals[0]?.reason, branch).toContain("the worktree holds");
    }
  });

  test("reports a fork whose declared trunk branch is absent", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    declareFork(repository);

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });

    expect(survey.proposals).toHaveLength(0);
    expect(survey.issues[0]?.reason).toContain("declares integration as its trunk");
  });

  test("reports a fork whose declared workshop is missing", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    git(repository, "branch", "integration", "main");
    declareFork(repository);
    git(repository, "config", "supervisor.workshop", join(projects, "absent-workshop"));

    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });

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

    expect(resolveModel(repository).carry_prefix).toBeNull();
    const survey = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });
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
    });
    expect(aheadSurvey.proposals[0]).toMatchObject({ action: "inspect", ahead: 1, behind: 0 });
  });

  test("fingerprints ignore timestamps and wake records carry the complete survey", () => {
    const { projects, repository, worktreeRoot } = fixture();
    addWorktree(repository, worktreeRoot);
    const first = surveyWorktrees({ projectRoots: [projects], worktreeRoots: [worktreeRoot], ownership: noAgents });
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
      ownership: noAgents,
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
    });

    expect(survey.counts.linked_worktrees).toBe(0);
    expect(survey.proposals.map((proposal) => proposal.worktree)).not.toContain(
      realpathSync.native(repository),
    );
    expect(survey.proposals).toHaveLength(0);
  });
});
