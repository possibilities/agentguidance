#!/usr/bin/env bun

import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export interface AgentSnapshot {
  available: boolean;
  agents: JsonObject[];
  error: string | null;
}

/** What the machine says is running, as opposed to what Herdr's roster says.
 * The roster has been observed to omit an agent that is demonstrably alive —
 * reporting availability the whole time — and a worktree read as unowned on
 * that evidence alone is one a removal proposal would take out from under a
 * working process. This is the backstop: a cwd is a fact the kernel holds. */
export interface ProcessSnapshot {
  available: boolean;
  /** Absolute cwd -> the lowest pid holding it. Lowest rather than first
   * seen: lsof's order is not stable, and a pid that churns between sweeps
   * would rewrite a proposal's reason and wake the watcher over nothing. */
  cwds: Map<string, number>;
  error: string | null;
}

export type ProposalAction =
  | "remove_worktree"
  | "catch_up_and_remove"
  | "catch_up_to_trunk"
  | "inspect";

/** How a repository says it is shaped. An ordinary repository answers
 * nothing and is judged against local main; a fork checkout carries its
 * workshop's declared model in its own `supervisor.*` config, converged
 * there by the maintain skill's reconcile-branches.sh. Tend reads that
 * config and never the workshop's prose. */
export interface RepositoryModel {
  trunk: string;
  mirror: string | null;
  /** Declared carry namespaces. Multi-valued: a fork may publish its carried
   * features under more than one prefix. */
  carry_prefixes: string[];
  /** Exact carry branch names living under no declared prefix at all — a real
   * carry whose published name a coordination hold prevents renaming. */
  carry_refs: string[];
  quarantine_prefix: string | null;
  workshop: string | null;
  fork: boolean;
}

/** The judgement a proposal rests on, as a closed category rather than the
 * prose that reports it. The prose interpolates a pid, a quiet-window count and
 * a branch name; those move on their own and must never by themselves wake a
 * session, so change detection reads this code and the prose stays for the
 * human. Every branch of `buildProposal` sets exactly one. */
export type ReasonCode =
  | "prunable"
  | "detached"
  | "dirty"
  | "held_integration"
  | "held_mirror"
  | "held_carry_prefix"
  | "held_carry_ref"
  | "held_quarantine"
  | "contained_publication_unknown"
  | "contained_published_carry"
  | "contained_removable"
  | "both_sides"
  | "both_sides_collapse_unknown"
  | "both_sides_collapses_publication_unknown"
  | "both_sides_collapses_published"
  | "both_sides_collapses_removable"
  | "ahead_only"
  | "indeterminate";

/** Which backstop reduced a lifecycle proposal to `inspect`, or null when none
 * did. Kept separate from `reason_code` so a downgrade never erases the
 * judgement underneath it, and so the volatile evidence a downgrade cites — a
 * pid, a count of seconds — stays in the prose where it cannot drive a wake. */
export type DowngradeCause = "process" | "activity" | "ignored";

export interface TendProposal {
  action: ProposalAction;
  /** Seconds since the worktree's Git metadata was last written, or null when
   * it could not be read. Evidence, always reported: a small number is the
   * cheapest sign that something is working here. */
  last_activity_seconds: number | null;
  /** Ignored entries living in the worktree. Reported always, because `clean`
   * never covered them: Git excludes ignored files from status by design and
   * `git worktree remove` deletes them without a word. */
  ignored_paths: string[];
  /** The subset of `ignored_paths` that is not obviously reproducible. A
   * removal proposal holding any of these is reduced to `inspect`. */
  ignored_unrecognized: string[];
  /** Digest of HEAD plus the full porcelain status, ignored entries included.
   * An executor recomputes it immediately before acting; a mismatch means the
   * worktree moved since the survey and the proposal must be re-derived. */
  state_digest: string | null;
  session_slug: string | null;
  repository: string;
  worktree: string;
  branch: string | null;
  head: string;
  trunk: string;
  trunk_head: string;
  fork_model: boolean;
  ahead: number;
  behind: number;
  clean: boolean;
  branch_retained: boolean;
  /** The category behind `reason`. Change detection reads this; humans read
   * the prose. */
  reason_code: ReasonCode;
  /** The backstop that reduced this proposal to `inspect`, if any. */
  downgrade: DowngradeCause | null;
  reason: string;
}

export interface TendIssue {
  repository: string | null;
  worktree: string | null;
  reason: string;
}

export interface TendSurvey {
  schema_version: 2;
  type: "tend_survey";
  occasion: "snapshot" | "start" | "change";
  generated_at: string;
  ownership_available: boolean;
  counts: {
    repositories: number;
    linked_worktrees: number;
    herdr_worktrees: number;
    protected_by_agent: number;
    /** Lifecycle proposals reduced to `inspect` because a process is working
     * inside the worktree though no agent row claimed it. Not a protection
     * count: the worktree still appears, it just stops being actionable. */
    downgraded_by_process: number;
    /** Lifecycle proposals reduced to `inspect` because the worktree was
     * mutated too recently to be called inactive. An agent can work through a
     * shell or an editor that holds no descriptor and registers no agent row,
     * and the only trace it leaves between sweeps is a fresh mtime. */
    downgraded_by_recent_activity: number;
    /** Removal proposals reduced to `inspect` because the worktree holds
     * ignored content that no branch would retain. */
    downgraded_by_ignored_content: number;
    proposals: number;
  };
  proposals: TendProposal[];
  issues: TendIssue[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WorktreeRecord {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}

export interface SurveyOptions {
  projectRoots: string[];
  /** Location restriction. Empty means every linked worktree a discovered
   * repository registers, wherever it lives; a non-empty list keeps only
   * worktrees below one of these roots. The main checkout is never a candidate
   * either way, and an explicitly targeted `worktrees` path ignores this
   * restriction. The CLI defaults it to the home directory — see parseOptions;
   * the library itself imposes no default, so a caller can survey anywhere. */
  worktreeRoots: readonly string[];
  ownership?: AgentSnapshot;
  processes?: ProcessSnapshot;
  sessionSlugs?: Readonly<Record<string, string>>;
  herdrBin?: string;
  /** Seconds of quiet a worktree must show before a lifecycle proposal on it
   * is actionable. 0 disables the check. */
  activityWindowSeconds?: number;
  /** Evaluate only these worktrees, resolving each one's repository directly
   * instead of walking the project roots. The judgement is identical; this
   * only narrows what is judged, for a caller gating one known path. */
  worktrees?: readonly string[];
}

interface WatchOptions extends SurveyOptions {
  socketPath: string;
  sweepIntervalSeconds: number;
  once: boolean;
  wakeSelf: boolean;
}

/** How long a worktree must sit untouched before a lifecycle proposal on it is
 * actionable. Long enough to cover an agent thinking between commands, short
 * enough that genuinely abandoned worktrees still clear it. */
const DEFAULT_ACTIVITY_WINDOW_SECONDS = 900;

const EVENT_SUBSCRIPTIONS = [
  { type: "pane.created" },
  { type: "pane.updated" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
  { type: "workspace.closed" },
];

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function normalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function pathIsWithin(path: string, root: string): boolean {
  const rel = relative(normalize(root), normalize(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function run(command: string, args: string[], cwd?: string): CommandResult {
  const child = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: child.status ?? (child.error ? 1 : 0),
    stdout: child.stdout ?? "",
    stderr: child.error?.message ?? child.stderr ?? "",
  };
}

function git(cwd: string, args: string[]): CommandResult {
  return run("git", ["-C", cwd, ...args]);
}

/** Strip the newline Git terminates its output with, and nothing else.
 * Trimming whitespace corrupts the two things Git hands back that may legally
 * carry it: a filesystem path ending in a space, and a ref name containing
 * non-ASCII whitespace. Only counts and object ids are safe to trim. */
function chomp(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function resolveCommonDir(checkout: string): string | null {
  const result = git(checkout, ["rev-parse", "--git-common-dir"]);
  if (result.code !== 0) return null;
  const value = chomp(result.stdout);
  return normalize(isAbsolute(value) ? value : join(checkout, value));
}

/** Whether a path names a checkout in its own right rather than merely a
 * directory inside one. `--git-common-dir` walks up the tree, so it answers
 * happily for `<repo>/vendor/nothing`; a declaration validated with it alone
 * either vanishes into the enclosing repository or drags that repository into
 * the survey. `--show-toplevel` names the work tree root, which equals the
 * path only for a real checkout or a linked worktree. */
function isCheckoutRoot(path: string): boolean {
  const top = git(path, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0) return normalize(chomp(top.stdout)) === normalize(path);
  // A bare repository has no work tree and so no toplevel, but it is still a
  // checkout root when the repository it names is the path itself.
  const bare = git(path, ["rev-parse", "--is-bare-repository"]);
  if (bare.code !== 0 || bare.stdout.trim() !== "true") return false;
  const gitDir = git(path, ["rev-parse", "--absolute-git-dir"]);
  return gitDir.code === 0 && normalize(chomp(gitDir.stdout)) === normalize(path);
}

function candidateDirectories(root: string): string[] {
  const normalized = normalize(root);
  if (!existsSync(normalized)) return [];
  const candidates = [normalized];
  try {
    const entries = readdirSync(normalized, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of entries) candidates.push(join(normalized, name));
  } catch {
    return candidates;
  }
  return candidates;
}

/** Name a repository by its main worktree. A fork checkout is commonly first
 * reached through one of its own linked worktrees, and reporting that sibling
 * directory would name the wrong place to a human deciding lifecycle work. */
function mainWorktreeFor(commonDir: string, fallback: string): string {
  const suffix = "/.git";
  if (!commonDir.endsWith(suffix)) return fallback;
  const parent = commonDir.slice(0, -suffix.length);
  return existsSync(parent) ? normalize(parent) : fallback;
}

export interface RepositoryDiscovery {
  repositories: string[];
  issues: TendIssue[];
}

/** A depth-one walk of each project root, then every checkout the repositories
 * found there declare. A workshop that keeps a bound fork inside itself — the
 * fork sits at <workshop>/fork/<name>, gitignored by the workshop — is deeper
 * than the walk reaches, and deepening the walk would drag in every vendored
 * and node_modules repository on the machine. So the workshop declares the
 * path instead, in `supervisor.checkout`. Declarations are followed to a fixed
 * point and deduped by Git common directory, so a fork reached both ways is
 * one repository, and a workshop binding several forks is ordinary. */
export function findRepositories(projectRoots: readonly string[]): RepositoryDiscovery {
  const byCommonDir = new Map<string, string>();
  const issues: TendIssue[] = [];
  const pending: string[] = [];

  const admit = (candidate: string): "admitted" | "known" | "unresolvable" => {
    const commonDir = resolveCommonDir(candidate);
    if (!commonDir) return "unresolvable";
    if (byCommonDir.has(commonDir)) return "known";
    const repository = mainWorktreeFor(commonDir, normalize(candidate));
    byCommonDir.set(commonDir, repository);
    pending.push(repository);
    return "admitted";
  };

  for (const root of projectRoots) {
    for (const candidate of candidateDirectories(root)) admit(candidate);
  }

  while (pending.length > 0) {
    const repository = pending.shift() as string;
    for (const declared of configuredValues(repository, "supervisor.checkout")) {
      const reason = (detail: string): TendIssue => ({
        repository,
        worktree: null,
        reason: `declares checkout ${declared}, which ${detail}`,
      });
      if (!isAbsolute(declared)) {
        issues.push(reason("is not an absolute path"));
        continue;
      }
      const path = normalize(declared);
      if (!existsSync(path)) {
        issues.push(reason("is not on disk"));
        continue;
      }
      if (!isCheckoutRoot(path)) {
        // Either not a repository at all, or a path inside one. Both are a
        // declaration naming something that is not a checkout.
        issues.push(reason("is not a Git checkout root"));
        continue;
      }
      // A declaration already reached by the walk is ordinary, not an issue;
      // anything else dropped here would be silent, so it is reported.
      if (admit(path) === "unresolvable") {
        issues.push(reason("could not be resolved to a Git repository"));
      }
    }
  }

  return { repositories: [...byCommonDir.values()].sort(), issues };
}

function parseWorktrees(text: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  const finish = () => {
    if (current) records.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      finish();
      current = {
        path: normalize(line.slice("worktree ".length)),
        head: "",
        branch: null,
        detached: false,
        prunable: false,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line.startsWith("prunable")) {
      current.prunable = true;
    } else if (line === "") {
      finish();
    }
  }
  finish();
  return records;
}

function listWorktrees(repository: string): WorktreeRecord[] {
  const result = git(repository, ["worktree", "list", "--porcelain"]);
  return result.code === 0 ? parseWorktrees(result.stdout) : [];
}

function agentPaths(agent: JsonObject): string[] {
  return [agent["cwd"], agent["foreground_cwd"]].filter(
    (value): value is string => typeof value === "string",
  );
}

export function worktreeHasActiveAgent(
  worktree: string,
  agents: readonly JsonObject[],
): boolean {
  return agents.some((agent) => agentPaths(agent).some((path) => pathIsWithin(path, worktree)));
}

/** Every process cwd on the machine, in one sweep. */
export function queryProcessCwds(lsofBin = process.env.LSOF_BIN_PATH ?? "lsof"): ProcessSnapshot {
  const result = run(lsofBin, ["-w", "-d", "cwd", "-F", "pcn"]);
  // lsof exits non-zero when any process could not be examined, which is
  // routine and not a failure: the records it did produce are still facts.
  // Only a run that produced nothing at all is unavailable.
  if (result.stdout.trim() === "") {
    return {
      available: false,
      cwds: new Map(),
      error: result.stderr.trim() || `${lsofBin} produced no cwd records`,
    };
  }
  const cwds = new Map<string, number>();
  let pid = 0;
  let command = "";
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number.parseInt(line.slice(1), 10) || 0;
      command = "";
    } else if (line.startsWith("c")) {
      command = line.slice(1);
    } else if (line.startsWith("n") && pid !== 0) {
      const path = line.slice(1);
      if (!path.startsWith("/")) continue;
      // `git -C <worktree>` chdirs, so every git this survey runs holds a
      // worktree cwd for as long as it lives — and a concurrent survey's sweep
      // sees them. Tend would report its own instrument as an occupant, in a
      // different worktree each time. Git is never the agent we are looking
      // for, so it is never evidence.
      if (command === "git") continue;
      const seen = cwds.get(path);
      if (seen === undefined || pid < seen) cwds.set(path, pid);
    }
  }
  return { available: true, cwds, error: null };
}

/** The lowest pid of any process working in this worktree, or null. Lowest so
 * that the answer is stable across sweeps while the same processes are there. */
export function processInWorktree(
  worktree: string,
  processes: ProcessSnapshot,
): number | null {
  let holder: number | null = null;
  for (const [path, pid] of processes.cwds) {
    if (pathIsWithin(path, worktree) && (holder === null || pid < holder)) holder = pid;
  }
  return holder;
}

function conversationSlug(agent: JsonObject): string | null {
  const tokens = asObject(agent["tokens"]);
  const value = tokens?.["conversation"];
  return typeof value === "string" && value !== "" && value !== "untitled agent"
    ? value
    : null;
}

/** Keep the human-facing conversation identity after its live agent row
 * disappears. The long-running watcher owns this in memory; no repository or
 * worktree metadata is written.
 *
 * Keyed by the agent's own directory rather than by a worktree derived from a
 * path layout: a worktree is only known to be one once Git names it, and
 * worktrees live wherever they were created, not only two segments below a
 * Herdr root. `slugForWorktree` resolves the key against a real worktree. */
export function rememberSessionSlugs(
  remembered: Record<string, string>,
  agents: readonly JsonObject[],
): void {
  for (const agent of agents) {
    const slug = conversationSlug(agent);
    if (!slug) continue;
    for (const path of agentPaths(agent)) {
      remembered[normalize(path)] = slug;
    }
  }
}

/** The slug remembered for the deepest agent directory inside this worktree.
 * Deepest wins so a nested worktree keeps its own identity rather than
 * inheriting the enclosing one's. */
export function slugForWorktree(
  remembered: Readonly<Record<string, string>>,
  worktree: string,
): string | null {
  let bestPath: string | null = null;
  let bestSlug: string | null = null;
  for (const [path, slug] of Object.entries(remembered)) {
    if (!pathIsWithin(path, worktree)) continue;
    if (bestPath === null || path.length > bestPath.length) {
      bestPath = path;
      bestSlug = slug;
    }
  }
  return bestSlug;
}

export function queryAgents(herdrBin = process.env.HERDR_BIN_PATH ?? "herdr"): AgentSnapshot {
  const result = run(herdrBin, ["agent", "list"]);
  if (result.code !== 0) {
    return {
      available: false,
      agents: [],
      error: result.stderr.trim() || `herdr agent list exited ${result.code}`,
    };
  }
  try {
    const envelope = asObject(JSON.parse(result.stdout));
    const resultObject = envelope ? asObject(envelope["result"]) : null;
    const rows = resultObject && Array.isArray(resultObject["agents"])
      ? resultObject["agents"]
      : [];
    return {
      available: true,
      agents: rows.map(asObject).filter((row): row is JsonObject => row !== null),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      agents: [],
      error: `could not parse herdr agent list: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function aheadBehind(worktree: string, trunk: string): { ahead: number; behind: number } | null {
  const result = git(worktree, [
    "rev-list",
    "--left-right",
    "--count",
    `refs/heads/${trunk}...HEAD`,
  ]);
  if (result.code !== 0) return null;
  const [behindText, aheadText] = result.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindText ?? "", 10);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

export interface PublicationScan {
  /** Branch names to treat as published. */
  names: Set<string>;
  /** False when Git could not be asked. Absence of a name is then not
   * evidence that a branch is unpublished, and the caller must not read it
   * as permission to remove anything. */
  available: boolean;
}

/** Which of this repository's branches have been published, read from local
 * refs and config only — never a fetch, never a network call. Publication is
 * evidence about a branch, not a source for the branch model, which still
 * comes from the declared config and nothing else. */
export function publishedBranchNames(repository: string): PublicationScan {
  const names = new Set<string>();
  // A branch with a configured upstream is published under whatever name the
  // remote gave it, which need not match the local one — exactly the carry
  // whose published name cannot be matched locally.
  const tracked = git(repository, [
    "for-each-ref",
    "--format=%(refname:short)%09%(upstream)",
    "refs/heads",
  ]);
  if (tracked.code !== 0) return { names, available: false };
  for (const line of tracked.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    if (line.slice(tab + 1) !== "") names.add(line.slice(0, tab));
  }
  // A branch pushed without --set-upstream has a remote-tracking ref and no
  // upstream config, so same-named remote refs count too. A remote name may
  // itself contain a slash, so strip by configured remote, longest first,
  // rather than assuming the name is one path component.
  const remotes = git(repository, ["remote"]);
  if (remotes.code !== 0) return { names, available: false };
  const prefixes = remotes.stdout
    .split("\n")
    .filter((remote) => remote !== "")
    .map((remote) => `refs/remotes/${remote}/`)
    .sort((left, right) => right.length - left.length);
  const refs = git(repository, ["for-each-ref", "--format=%(refname)", "refs/remotes"]);
  if (refs.code !== 0) return { names, available: false };
  for (const ref of refs.stdout.split("\n")) {
    if (ref === "") continue;
    const prefix = prefixes.find((candidate) => ref.startsWith(candidate));
    // A ref under no configured remote is an orphan. Strip the first component
    // as a guess: naming a branch that is not there over-protects, which is the
    // safe direction, while skipping it could propose removing a real carry.
    const branch = prefix === undefined
      ? ref.slice("refs/remotes/".length).split("/").slice(1).join("/")
      : ref.slice(prefix.length);
    if (branch === "" || branch === "HEAD") continue;
    names.add(branch);
  }
  return { names, available: true };
}

/** Ignored content a removal may destroy without asking, in two tiers,
 * because the two behave differently as ancestors.
 *
 * A tool-owned directory is unambiguous wherever it appears: nothing but pip,
 * pytest or npm writes `.venv`, `.pytest_cache` or `node_modules`, so anything
 * beneath one is theirs too. That matters because Git does not always collapse
 * an ignored directory — a `.pytest_cache` containing its own `.gitignore` is
 * reported file by file, and judging those files on their own names
 * ("README.md", "CACHEDIR.TAG") would flag a cache as irreplaceable.
 *
 * A generic name is only safe as the entry itself. `build`, `dist` and
 * `target` are ordinary English, and `evidence/build/receipt.json` is a
 * receipt that happens to sit under one. Treating those as rebuildable
 * ancestors is precisely how a receipt gets deleted with nothing holding it. */
const TOOL_OWNED_IGNORED = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".zig-cache", "zig-cache", ".next", ".turbo", ".parcel-cache",
  ".nyc_output", ".gradle", ".terraform", "Pods", "DerivedData", ".cache",
]);

const GENERIC_BUILD_NAMES = new Set([
  "dist", "build", "out", "target", "zig-out", "coverage", ".DS_Store",
]);

const REBUILDABLE_SUFFIXES = [".pyc", ".pyo", ".o", ".a", ".class", ".log", ".tmp"];

/** Whether an ignored entry is obviously reproducible. Unknown means not
 * reproducible: this gates a deletion, so the default has to be "ask". */
export function isRebuildableIgnored(entry: string): boolean {
  const trimmed = entry.replace(/\/+$/, "");
  if (trimmed === "") return false;
  const segments = trimmed.split("/");
  const last = segments[segments.length - 1] ?? "";
  // A tool-owned directory anywhere on the path claims everything under it.
  if (segments.some((segment) => TOOL_OWNED_IGNORED.has(segment))) return true;
  if (GENERIC_BUILD_NAMES.has(last)) return true;
  return REBUILDABLE_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

function inspectWorktree(
  repository: string,
  record: WorktreeRecord,
  trunkHead: string,
  model: RepositoryModel,
  sessionSlug: string | null,
  published: PublicationScan,
): TendProposal {
  // One status call answers three questions: whether the worktree is clean,
  // what ignored content a removal would silently destroy, and — hashed with
  // HEAD — a digest an executor can recompute to prove nothing moved between
  // this survey and the moment it acts.
  const status = git(record.path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignored=matching",
  ]);
  const lines = status.code === 0
    ? status.stdout.split("\n").filter((line) => line !== "")
    : [];
  const ignoredPaths = lines
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3));
  // Clean still means "nothing Git tracks or reports as untracked". Ignored
  // entries were never part of that judgement and do not become part of it
  // here; they are reported separately because they gate a different question.
  const clean = status.code === 0 && lines.every((line) => line.startsWith("!! "));
  const ignoredUnrecognized = ignoredPaths.filter((entry) => !isRebuildableIgnored(entry));
  const stateDigest = status.code === 0
    ? createHash("sha256").update(`${record.head}\n${lines.join("\n")}`).digest("hex").slice(0, 16)
    : null;
  const counts = aheadBehind(record.path, model.trunk) ?? { ahead: 0, behind: 0 };
  const base = {
    last_activity_seconds: worktreeLastActivitySeconds(record.path),
    ignored_paths: ignoredPaths,
    ignored_unrecognized: ignoredUnrecognized,
    state_digest: stateDigest,
    session_slug: sessionSlug,
    repository,
    worktree: record.path,
    branch: record.branch,
    head: record.head,
    trunk: model.trunk,
    trunk_head: trunkHead,
    fork_model: model.fork,
    ahead: counts.ahead,
    behind: counts.behind,
    clean,
    branch_retained: true,
    downgrade: null,
  };

  if (record.prunable) {
    return {
      ...base,
      action: "inspect",
      reason_code: "prunable",
      reason: "Git marks the worktree registration prunable",
    };
  }
  if (record.detached || record.branch === null) {
    return { ...base, action: "inspect", reason_code: "detached", reason: "the worktree is detached" };
  }
  if (!clean) {
    return {
      ...base,
      action: "inspect",
      reason_code: "dirty",
      reason: "the worktree has uncommitted changes",
    };
  }
  const held = heldByModel(record.branch, model);
  if (held) {
    return {
      ...base,
      action: "inspect",
      reason_code: held.code,
      reason: `the worktree holds ${held.prose}`,
    };
  }

  const contained = git(record.path, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    `refs/heads/${model.trunk}`,
  ]).code === 0;
  if (contained) {
    // In a fork repository containment is never sufficient on its own: a
    // published carry head is an ancestor of integration by design. A branch
    // with a remote-tracking counterpart is somebody's carry whatever it is
    // named, so it is protected even when no declaration covers its name.
    if (!published.available) {
      return {
        ...base,
        action: "inspect",
        reason_code: "contained_publication_unknown",
        reason:
          `Git could not establish which branches are published, so containment in ${model.trunk} is not sufficient evidence`,
      };
    }
    if (published.names.has(record.branch)) {
      return {
        ...base,
        action: "inspect",
        reason_code: "contained_published_carry",
        reason:
          `the branch is published on a remote, so containment in ${model.trunk} is not evidence the carry is finished`,
      };
    }
    return {
      ...base,
      action: "remove_worktree",
      reason_code: "contained_removable",
      reason: `the clean worktree HEAD is contained in local ${model.trunk}`,
    };
  }
  if (counts.ahead > 0 && counts.behind > 0) {
    const collapses = catchUpCollapsesToTrunk(record.path, model.trunk);
    const bothSides = `the clean branch has commits on both sides of local ${model.trunk}`;
    if (collapses === true) {
      // The catch-up would leave this worktree in exactly the state that earns
      // `remove_worktree` above: clean, inactive, contained. So the removal
      // half has to clear the same publication backstop that path clears —
      // a published branch keeps its worktree whatever the rebase would do.
      if (!published.available) {
        return {
          ...base,
          action: "catch_up_to_trunk",
          reason_code: "both_sides_collapses_publication_unknown",
          reason:
            `${bothSides}, and the catch-up would collapse it onto ${model.trunk}, but Git could not ` +
            "establish which branches are published, so the worktree is not also proposed for removal",
        };
      }
      if (published.names.has(record.branch)) {
        return {
          ...base,
          action: "catch_up_to_trunk",
          reason_code: "both_sides_collapses_published",
          reason:
            `${bothSides}, and the catch-up would collapse it onto ${model.trunk}, but the branch is ` +
            "published on a remote, so the worktree is not also proposed for removal",
        };
      }
      return {
        ...base,
        action: "catch_up_and_remove",
        reason_code: "both_sides_collapses_removable",
        reason:
          `${bothSides}, but every commit it carries is already upstream, so the catch-up replays ` +
          `nothing: it leaves the branch at ${model.trunk} and the worktree clean and contained`,
      };
    }
    return {
      ...base,
      action: "catch_up_to_trunk",
      reason_code: collapses === null ? "both_sides_collapse_unknown" : "both_sides",
      reason: collapses === null
        ? `${bothSides}; Git could not establish whether the catch-up would collapse it onto ${model.trunk}`
        : bothSides,
    };
  }
  return {
    ...base,
    action: "inspect",
    reason_code: counts.ahead > 0 ? "ahead_only" : "indeterminate",
    reason: counts.ahead > 0
      ? `the inactive branch has commits not in local ${model.trunk}`
      : "Git could not establish a conservative lifecycle action",
  };
}

/** Whether the catch-up rebase would replay nothing and leave the branch
 * sitting on trunk. Git's own already-upstream filter answers it without
 * touching the worktree: `--cherry-pick --right-only` drops every commit whose
 * patch already has an equivalent on the trunk side, and a non-interactive
 * rebase flattens merges away, so an empty list is exactly the case where the
 * rebase ends at trunk. A branch whose commits landed upstream by some other
 * route — squashed, or reworked so the patch no longer matches — reads as not
 * collapsing and keeps the plain catch-up proposal. That is the safe
 * direction: this must never claim a rebase is a formality when it would
 * really stop on a conflict. Null when Git could not answer at all. */
function catchUpCollapsesToTrunk(worktree: string, trunk: string): boolean | null {
  const result = git(worktree, [
    "rev-list",
    "--count",
    "--no-merges",
    "--cherry-pick",
    "--right-only",
    `refs/heads/${trunk}...HEAD`,
  ]);
  if (result.code !== 0) return null;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? null : count === 0;
}

/** Seconds since anything last wrote the worktree's Git metadata, or null when
 * it cannot be read. The index, HEAD and the reflog are what move when a
 * checkout, commit, stage, stash or rebase happens in the worktree, so the
 * newest of the three is a cheap floor on "when was something last done here".
 *
 * This is the third liveness witness, after the agent roster and the cwd
 * sweep, and it exists because the first two share a blind spot: an agent
 * driving a worktree through a shell, an editor or a subprocess registers no
 * agent row and may hold no descriptor there between commands, yet is very
 * much working. Its edits still land on the filesystem. A worktree touched
 * seconds ago is not inactive whatever the roster says.
 *
 * It cannot tell whose write it was — tend's own catch-up rebase moves these
 * same timestamps — so it never claims to identify an owner. It only refuses
 * to call a worktree quiet when the filesystem says it is not. */
function worktreeLastActivitySeconds(worktree: string): number | null {
  const dir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return null;
  const gitDir = chomp(dir.stdout);
  let newest = 0;
  for (const name of ["index", "HEAD", join("logs", "HEAD")]) {
    try {
      newest = Math.max(newest, statSync(join(gitDir, name)).mtimeMs);
    } catch {
      // A worktree that never committed has no reflog; absence is not activity.
    }
  }
  if (newest === 0) return null;
  return Math.max(0, Math.round((Date.now() - newest) / 1000));
}

/** Seconds for --activity-window. 0 disables the quiet-window check, which is
 * a deliberate act: it says the caller has established by other means that
 * nothing is working in these worktrees. */
function parseActivityWindow(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ACTIVITY_WINDOW_SECONDS;
  const seconds = Number.parseInt(value, 10);
  if (Number.isNaN(seconds) || seconds < 0) {
    throw new Error(`--activity-window expects a non-negative number of seconds, got ${value}`);
  }
  return seconds;
}

function trunkHead(repository: string, trunk: string): string | null {
  const result = git(repository, ["rev-parse", "--verify", `refs/heads/${trunk}`]);
  return result.code === 0 ? result.stdout.trim() : null;
}

function configuredValue(repository: string, key: string): string | null {
  const result = git(repository, ["config", "--local", "--get", key]);
  return result.code === 0 ? chomp(result.stdout) : null;
}

/** Every value of a multi-valued declaration; empty when the key is absent.
 * A key a workshop has not converged yet reads as no values, which must behave
 * exactly as the single-valued world behaved before the key existed.
 *
 * NUL-delimited, because a config value may itself contain a newline: splitting
 * such a value on newlines would read one declaration as two, and a fragment
 * like `f` used as a prefix holds every branch beginning with it. Values are
 * taken verbatim — a ref name may contain non-ASCII whitespace that trimming
 * would silently rewrite into a different branch. */
function configuredValues(repository: string, key: string): string[] {
  const result = git(repository, ["config", "--local", "-z", "--get-all", key]);
  if (result.code !== 0) return [];
  return result.stdout.split("\0").filter((value) => value !== "");
}

/** A declared prefix may legitimately be empty — a linear-stack fork carries
 * no carry heads — so an empty declaration is not a missing one. */
function declaredPrefix(repository: string, key: string): string | null {
  const value = configuredValue(repository, key);
  return value === null || value === "" ? null : value;
}

export function resolveModel(repository: string): RepositoryModel {
  const trunk = configuredValue(repository, "supervisor.trunk") ?? "";
  if (!trunk) {
    return {
      trunk: "main",
      mirror: null,
      carry_prefixes: [],
      carry_refs: [],
      quarantine_prefix: null,
      workshop: null,
      fork: false,
    };
  }
  return {
    trunk,
    mirror: configuredValue(repository, "supervisor.mirror") || null,
    carry_prefixes: configuredValues(repository, "supervisor.carryPrefix"),
    carry_refs: configuredValues(repository, "supervisor.carryRef"),
    quarantine_prefix: declaredPrefix(repository, "supervisor.quarantinePrefix"),
    workshop: configuredValue(repository, "supervisor.workshop") || null,
    fork: true,
  };
}

/** Branches the declared model keeps. Their worktrees are the fork's standing
 * working set, so containment in the trunk is not evidence they are finished:
 * a published carry head is an ancestor of integration by design. */
function heldByModel(
  branch: string,
  model: RepositoryModel,
): { code: ReasonCode; prose: string } | null {
  if (branch === model.trunk) {
    return { code: "held_integration", prose: `the declared integration branch ${model.trunk}` };
  }
  if (model.mirror && branch === model.mirror) {
    return { code: "held_mirror", prose: `the declared mirror branch ${model.mirror}` };
  }
  for (const prefix of model.carry_prefixes) {
    if (branch.startsWith(prefix)) {
      return {
        code: "held_carry_prefix",
        prose: `a carried feature under the declared prefix ${prefix}`,
      };
    }
  }
  if (model.carry_refs.includes(branch)) {
    return { code: "held_carry_ref", prose: `the declared carry head ${branch}` };
  }
  if (model.quarantine_prefix && branch.startsWith(model.quarantine_prefix)) {
    return {
      code: "held_quarantine",
      prose: `an explicit deletion marker under ${model.quarantine_prefix}`,
    };
  }
  return null;
}

/** The repositories owning a set of worktree paths, deduped by common dir. A
 * path that is not a checkout is reported rather than dropped: a caller gating
 * a removal on the result must not read "no proposal" as "nothing to worry
 * about", so the survey has to say why it produced none. */
export function repositoriesForWorktrees(paths: readonly string[]): RepositoryDiscovery {
  const repositories: string[] = [];
  const issues: TendIssue[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) {
      issues.push({ repository: null, worktree: path, reason: "no such path" });
      continue;
    }
    const common = resolveCommonDir(path);
    if (common === null) {
      issues.push({ repository: null, worktree: path, reason: "not inside a Git repository" });
      continue;
    }
    if (!isCheckoutRoot(path)) {
      issues.push({
        repository: null,
        worktree: path,
        reason: "not a worktree root: it lies inside a checkout rather than being one",
      });
      continue;
    }
    // The common dir is <main>/.git for a normal checkout and the same for
    // every linked worktree of it, which is exactly the dedupe key wanted.
    const main = common.endsWith("/.git") ? common.slice(0, -"/.git".length) : common;
    if (seen.has(main)) continue;
    seen.add(main);
    repositories.push(main);
  }
  return { repositories, issues };
}

export function surveyWorktrees(
  options: SurveyOptions,
  occasion: TendSurvey["occasion"] = "snapshot",
): TendSurvey {
  // Gating one known path should not cost a survey of the machine. The
  // dominant per-worktree cost is the already-upstream check, which must
  // patch-id the whole upstream side, so the only real saving is to judge
  // fewer worktrees — not to judge them more cheaply.
  const targeted = (options.worktrees ?? []).map(normalize);
  const discovered = targeted.length > 0
    ? repositoriesForWorktrees(targeted)
    : findRepositories(options.projectRoots);
  const repositories = discovered.repositories;
  const ownership = options.ownership ?? queryAgents(options.herdrBin);
  const processes = options.processes ?? queryProcessCwds();
  const proposals: TendProposal[] = [];
  const issues: TendIssue[] = [...discovered.issues];
  let linkedWorktrees = 0;
  let herdrWorktrees = 0;
  let protectedByAgent = 0;
  let downgradedByProcess = 0;
  let downgradedByRecentActivity = 0;
  let downgradedByIgnoredContent = 0;
  const activityWindow = options.activityWindowSeconds ?? DEFAULT_ACTIVITY_WINDOW_SECONDS;

  if (!ownership.available) {
    issues.push({
      repository: null,
      worktree: null,
      reason: `Herdr ownership unavailable: ${ownership.error ?? "unknown error"}`,
    });
  }
  if (!processes.available) {
    issues.push({
      repository: null,
      worktree: null,
      reason:
        `the process backstop is unavailable (${processes.error ?? "unknown error"}), ` +
        "so a worktree held by an agent the roster omits cannot be detected",
    });
  }

  const herdrRoot = normalize(join(homedir(), ".herdr", "worktrees"));
  for (const repository of repositories) {
    const worktrees = listWorktrees(repository).filter((record) => {
      // The main checkout is never a lifecycle candidate. It was previously
      // excluded only as a side effect of the Herdr-root filter, so it has to
      // be excluded on its own now that worktrees anywhere are considered.
      if (normalize(record.path) === normalize(repository)) return false;
      // An explicitly targeted path is authoritative and skips the location
      // restriction entirely. A caller gating one known worktree asked about
      // that path; dropping it for living outside the surveyed roots would
      // answer "no proposal" where the contract promises an issue, and that is
      // exactly the reading a removal must never be given.
      if (targeted.length > 0) return targeted.includes(normalize(record.path));
      return options.worktreeRoots.length === 0 ||
        options.worktreeRoots.some((root) => pathIsWithin(record.path, root));
    });
    linkedWorktrees += worktrees.length;
    herdrWorktrees += worktrees.filter((record) => pathIsWithin(record.path, herdrRoot)).length;
    if (worktrees.length === 0) continue;
    const model = resolveModel(repository);
    if (model.fork && model.workshop && !existsSync(model.workshop)) {
      issues.push({
        repository,
        worktree: null,
        reason:
          `the declared workshop ${model.workshop} is missing, so the fork model cannot be reconciled with its specification`,
      });
    }
    const target = trunkHead(repository, model.trunk);
    if (!target) {
      issues.push({
        repository,
        worktree: null,
        reason: model.fork
          ? `repository declares ${model.trunk} as its trunk but has no such local branch`
          : "repository has no local main branch",
      });
      continue;
    }
    // The only gate on the backstop: outside a fork model there is nothing to
    // protect, and an empty scan lets containment mean landed as it always did.
    const published: PublicationScan = model.fork
      ? publishedBranchNames(repository)
      : { names: new Set<string>(), available: true };
    if (!published.available) {
      issues.push({
        repository,
        worktree: null,
        reason: "Git could not list published branches, so no worktree here is proposed for removal",
      });
    }
    for (const record of worktrees) {
      if (!ownership.available) continue;
      if (worktreeHasActiveAgent(record.path, ownership.agents)) {
        protectedByAgent += 1;
        continue;
      }
      const proposal = inspectWorktree(
        repository,
        record,
        target,
        model,
        slugForWorktree(options.sessionSlugs ?? {}, record.path),
        published,
      );
      // No agent row claims it, so the ordinary judgement above ran. Ask the
      // machine before letting that judgement be actionable: a cwd inside the
      // worktree may be a live agent the roster omitted, or a helper some
      // harness leaked and never reaped. Those are indistinguishable from
      // here — pid, parent and age all fail to separate them — so this never
      // decides which. It only refuses to propose an operation that would run
      // underneath one, and says what it saw.
      const holder = processInWorktree(record.path, processes);
      if (holder !== null && proposal.action !== "inspect") {
        downgradedByProcess += 1;
        proposals.push({
          ...proposal,
          action: "inspect",
          downgrade: "process",
          reason:
            `${proposal.reason}, but process ${holder} is working inside the worktree ` +
            "while no Herdr agent row claims it: confirm that process is finished " +
            "before any lifecycle work here",
        });
        continue;
      }
      // Third witness. The roster can omit an agent and the cwd sweep can miss
      // one that works through a shell or an editor, but an agent that changed
      // anything left an mtime behind. A worktree written to this recently is
      // not inactive, so its lifecycle proposal is evidence rather than an
      // instruction — the same reduction the process check makes, for the same
      // reason. Note this cannot attribute the write: tend's own catch-up
      // moves these timestamps too, so a removal pass straight after one waits
      // out the window or sets it to 0 deliberately.
      const quiet = proposal.last_activity_seconds;
      if (
        activityWindow > 0 && proposal.action !== "inspect" &&
        quiet !== null && quiet < activityWindow
      ) {
        downgradedByRecentActivity += 1;
        proposals.push({
          ...proposal,
          action: "inspect",
          downgrade: "activity",
          reason:
            `${proposal.reason}, but the worktree was written ${quiet}s ago, inside the ` +
            `${activityWindow}s quiet window: something may be working here that neither the ` +
            "Herdr roster nor an open descriptor reveals",
        });
        continue;
      }
      // Fourth check, and the only one about what removal destroys rather than
      // who is present. `clean` and containment together say every *tracked*
      // byte is held by a branch; neither says anything about ignored content,
      // which `git worktree remove` deletes silently and no branch retains. A
      // build tree is fine to lose, so it never blocks; anything else is the
      // human's call. Only removal-bearing actions are gated — a catch-up
      // rebase deletes no files, so ignored content is irrelevant to it.
      const destroys = proposal.ignored_unrecognized;
      if (
        (proposal.action === "remove_worktree" || proposal.action === "catch_up_and_remove") &&
        destroys.length > 0
      ) {
        downgradedByIgnoredContent += 1;
        const named = destroys.slice(0, 3).join(", ");
        const more = destroys.length > 3 ? ` and ${destroys.length - 3} more` : "";
        proposals.push({
          ...proposal,
          action: "inspect",
          downgrade: "ignored",
          reason:
            `${proposal.reason}, but removing it would destroy ignored content no branch ` +
            `retains: ${named}${more}`,
        });
        continue;
      }
      proposals.push(proposal);
    }
  }

  proposals.sort((left, right) =>
    `${left.session_slug ?? ""}:${left.worktree}`.localeCompare(
      `${right.session_slug ?? ""}:${right.worktree}`,
    )
  );
  issues.sort((left, right) =>
    `${left.repository ?? ""}:${left.worktree ?? ""}:${left.reason}`.localeCompare(
      `${right.repository ?? ""}:${right.worktree ?? ""}:${right.reason}`,
    )
  );
  return {
    schema_version: 2,
    type: "tend_survey",
    occasion,
    generated_at: new Date().toISOString(),
    ownership_available: ownership.available,
    counts: {
      repositories: repositories.length,
      linked_worktrees: linkedWorktrees,
      herdr_worktrees: herdrWorktrees,
      protected_by_agent: protectedByAgent,
      downgraded_by_process: downgradedByProcess,
      downgraded_by_recent_activity: downgradedByRecentActivity,
      downgraded_by_ignored_content: downgradedByIgnoredContent,
      proposals: proposals.length,
    },
    proposals,
    issues,
  };
}

/** The facts that change what a human would decide about a worktree.
 *
 * Everything a proposal reports that is NOT here moves on its own:
 * `last_activity_seconds` is a clock and advances every sweep by construction,
 * `reason` interpolates the pid of a short-lived helper and the quiet-window
 * count, and `session_slug` follows roster rows that come and go. Fingerprinting
 * the whole proposal made the change check in `publish` unreachable — every
 * sweep looked new — so the watcher woke its session unconditionally. */
function proposalSignature(proposal: TendProposal) {
  return {
    action: proposal.action,
    reason_code: proposal.reason_code,
    downgrade: proposal.downgrade,
    repository: proposal.repository,
    worktree: proposal.worktree,
    branch: proposal.branch,
    head: proposal.head,
    trunk: proposal.trunk,
    trunk_head: proposal.trunk_head,
    fork_model: proposal.fork_model,
    ahead: proposal.ahead,
    behind: proposal.behind,
    clean: proposal.clean,
    branch_retained: proposal.branch_retained,
    // HEAD plus the full porcelain status, ignored entries included: any
    // content change a human would care about moves this.
    state_digest: proposal.state_digest,
    // The subset that gates a removal. The full ignored list is evidence.
    ignored_unrecognized: proposal.ignored_unrecognized,
  };
}

export function surveyFingerprint(survey: TendSurvey): string {
  return JSON.stringify({
    ownership_available: survey.ownership_available,
    proposals: survey.proposals.map(proposalSignature),
    issues: survey.issues,
  });
}

export function shouldWakeSelf(enabled: boolean, survey: TendSurvey): boolean {
  return enabled && (survey.proposals.length > 0 || !survey.ownership_available);
}

function sessionId(agent: JsonObject): string | null {
  const session = asObject(agent["agent_session"]);
  return session && typeof session["value"] === "string" ? session["value"] : null;
}

function ownSession(agents: readonly JsonObject[]): string | null {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return null;
  const row = agents.find((agent) => agent["pane_id"] === paneId);
  return row ? sessionId(row) : null;
}

export function wakeMessage(survey: TendSurvey): string {
  return [
    `<tend_event>${JSON.stringify(survey)}</tend_event>`,
    "Automated Tend wake — re-run the read-only snapshot, notify if it still has proposals, and return the /tend minisketch. Lead with each event proposal's session_slug when the matching refreshed worktree and HEAD are unchanged; the live agent row may already be gone. Do not perform any proposed action.",
  ].join("\n");
}

function wakeSelf(survey: TendSurvey, ownership: AgentSnapshot): void {
  const target = ownSession(ownership.agents);
  if (!target) {
    process.stderr.write("tend watch: cannot self-wake; this Herdr pane has no agent session\n");
    return;
  }
  const result = run("agentsurface", ["message", target, wakeMessage(survey)]);
  if (result.code !== 0) {
    process.stderr.write(
      `tend watch: self-wake failed: ${result.stderr.trim() || `exit ${result.code}`}\n`,
    );
  }
}

class GitWatchSet {
  private readonly watchers: FSWatcher[] = [];

  refresh(repositories: readonly string[], onChange: () => void): void {
    this.close();
    const seen = new Set<string>();
    for (const repository of repositories) {
      const commonDir = resolveCommonDir(repository);
      if (!commonDir) continue;
      for (const path of [
        commonDir,
        join(commonDir, "refs", "heads"),
        join(commonDir, "worktrees"),
      ]) {
        if (seen.has(path) || !existsSync(path)) continue;
        seen.add(path);
        try {
          if (!statSync(path).isDirectory()) continue;
          const watcher = watch(path, { recursive: path !== commonDir, persistent: false }, onChange);
          watcher.on("error", () => watcher.close());
          this.watchers.push(watcher);
        } catch {
          // The recovery sweep covers filesystems that cannot be watched.
        }
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }
}

class HerdrEvents {
  private socket: { write(data: string): number; end(): void } | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;
  private buffer = "";

  constructor(
    private readonly socketPath: string,
    private readonly onEvent: () => void,
  ) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    this.socket?.end();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    try {
      const socket = await Bun.connect({
        unix: this.socketPath,
        socket: {
          open: (opened) => {
            this.socket = opened as unknown as { write(data: string): number; end(): void };
            this.socket.write(`${JSON.stringify({
              id: "tend:subscribe",
              method: "events.subscribe",
              params: { subscriptions: EVENT_SUBSCRIPTIONS },
            })}\n`);
            this.failures = 0;
          },
          data: (_opened, chunk) => this.read(chunk),
          close: () => {
            this.socket = null;
            this.scheduleReconnect();
          },
          error: (_opened, error) => {
            process.stderr.write(`tend watch: Herdr event stream error: ${error.message}\n`);
          },
        },
      });
      this.socket = socket as unknown as { write(data: string): number; end(): void };
    } catch (error) {
      process.stderr.write(
        `tend watch: Herdr event subscription failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      this.scheduleReconnect();
    }
  }

  private read(chunk: Uint8Array): void {
    this.buffer += new TextDecoder().decode(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const envelope = asObject(JSON.parse(line));
        if (envelope && typeof envelope["event"] === "string") this.onEvent();
      } catch {
        process.stderr.write("tend watch: discarded an invalid Herdr event\n");
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    const delay = Math.min(500 * 2 ** Math.min(this.failures++, 6), 30_000);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.connect();
    }, delay);
    this.reconnect.unref?.();
  }
}

function parseSeconds(value: string | undefined): number {
  if (value === undefined) return 300;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--sweep-interval expects a positive number of seconds, got ${value}`);
  }
  return parsed;
}

function defaultSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

function parseOptions(argv: string[]): WatchOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      "project-root": { type: "string", multiple: true },
      "worktree-root": { type: "string", multiple: true },
      socket: { type: "string" },
      "sweep-interval": { type: "string" },
      "activity-window": { type: "string" },
      worktree: { type: "string", multiple: true },
      once: { type: "boolean", default: false },
      "wake-self": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (parsed.values.help) {
    process.stdout.write(`Usage: watch.ts [--once] [--wake-self] [--project-root PATH]...\n+                [--worktree-root PATH]... (default: $HOME) [--socket PATH] [--sweep-interval SECONDS]\n+                [--activity-window SECONDS]\n+                [--worktree PATH]...\n+\n+Emits read-only tend_survey JSON records. The long-running mode watches Git and\n+Herdr, while --once prints one snapshot and exits.\n`);
    process.exit(0);
  }
  return {
    projectRoots: (parsed.values["project-root"] ?? [join(homedir(), "code"), join(homedir(), "src")]).map(normalize),
    // Default to the home directory. Worktrees on a removable volume or under
    // the system temp dir are transient by construction — an installer's
    // scratch checkout is not a forgotten directory, and a volume that
    // unmounts would make every worktree on it vanish and reappear as
    // "changes" to watch. Passing --worktree-root replaces this outright, so
    // surveying elsewhere stays one flag away.
    worktreeRoots: (parsed.values["worktree-root"] ?? [homedir()]).map(normalize),
    socketPath: normalize(parsed.values.socket ?? defaultSocketPath()),
    sweepIntervalSeconds: parseSeconds(parsed.values["sweep-interval"]),
    activityWindowSeconds: parseActivityWindow(parsed.values["activity-window"]),
    worktrees: (parsed.values.worktree ?? []).map(normalize),
    once: parsed.values.once ?? false,
    wakeSelf: parsed.values["wake-self"] ?? false,
  };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  if (process.env.HERDR_ENV !== "1") {
    process.stderr.write("tend watch: this process is not running inside Herdr (HERDR_ENV=1)\n");
    process.exit(1);
  }

  if (options.once) {
    process.stdout.write(`${JSON.stringify(surveyWorktrees(options, "snapshot"))}\n`);
    process.exit(0);
  }

  let lastFingerprint = "";
  const rememberedSessionSlugs: Record<string, string> = {};
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const gitWatches = new GitWatchSet();
  let publish: (occasion: TendSurvey["occasion"], wake: boolean) => void;
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      publish("change", true);
    }, 250);
    debounce.unref?.();
  };
  publish = (occasion: TendSurvey["occasion"], shouldWake: boolean) => {
    const ownership = queryAgents(options.herdrBin);
    rememberSessionSlugs(rememberedSessionSlugs, ownership.agents);
    const survey = surveyWorktrees({
      ...options,
      ownership,
      sessionSlugs: rememberedSessionSlugs,
    }, occasion);
    const fingerprint = surveyFingerprint(survey);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    process.stdout.write(`${JSON.stringify(survey)}\n`);
    gitWatches.refresh(findRepositories(options.projectRoots).repositories, schedule);
    if (shouldWake && shouldWakeSelf(options.wakeSelf, survey)) {
      wakeSelf(survey, ownership);
    }
  };

  publish("start", false);
  const herdrEvents = new HerdrEvents(options.socketPath, schedule);
  herdrEvents.start();
  const sweep = setInterval(schedule, options.sweepIntervalSeconds * 1_000);
  const stop = () => {
    if (debounce) clearTimeout(debounce);
    clearInterval(sweep);
    gitWatches.close();
    herdrEvents.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}
