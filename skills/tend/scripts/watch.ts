#!/usr/bin/env bun

import {
	existsSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** One parked agent and its worktree, as the parked document records it.
 *
 * A park is not a note about a deferred decision — it is everything needed to
 * delete the worktree now and reconstitute the work later: the path to rebuild
 * at, the branch and commit to rebuild from, the snapshot holding whatever was
 * never committed, and the native session id that resumes the agent that was
 * doing it. A record missing any of those is a worktree that can be removed but
 * not brought back, which is the one outcome parking exists to prevent. */
export interface ParkRecord {
  /** The entry's heading: the session slug where one is known, else the
   * worktree's own directory name. Human identity, never a key. */
  name: string;
  /** One sentence on what this agent and worktree are, written by whoever
   * parked it. The only field tend cannot derive, and the only one that says
   * why the record is worth keeping. */
  summary: string;
  reason: string;
  parked_at: string;
  /** The key. Absolute, and the path a recreated worktree must reoccupy:
   * `agentlaunch x-resume` returns the session to its recorded cwd, so a
   * worktree rebuilt anywhere else resumes the agent into a directory its
   * conversation does not describe. */
  worktree: string;
  repository: string;
  branch: string | null;
  head: string;
  harness: string | null;
  session: string | null;
  /** The agent's own cwd, recorded only when it is not the worktree root. */
  cwd: string | null;
  /** Ref holding the snapshot commit, or null when the worktree was clean and
   * the branch already held every byte. */
  snapshot_ref: string | null;
  snapshot_paths: number;
  /** The recorded recipe, rendered at park time and kept verbatim on reload so
   * a human may correct it in the document. */
  unpark: string;
}

/** Why a parked record matched no proposal in this survey. Each is a different
 * question to the human, and none of them is "nothing happened". */
export type ParkStatus = "absent" | "occupied" | "settled";

export interface ParkUnmatched {
  record: ParkRecord;
  status: ParkStatus;
  detail: string;
}

export interface TendProposal {
  action: ProposalAction;
  /** The parked records covering this worktree, newest last, empty when none
   * do. A parked proposal is still a proposal — the judgement does not change
   * because a human wrote it down — but it has already been decided, so the
   * wizard reports it rather than asking again.
   *
   * A list rather than one record because a park is one agent *and* its
   * worktree: several sessions may have worked in the same checkout, and each
   * is separately worth resuming. */
  parked: ParkRecord[];
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
  schema_version: 3;
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
    /** Proposals the human has already parked. Counted, not subtracted: they
     * are still part of the picture, they just stop being questions. */
    parked: number;
    proposals: number;
  };
  proposals: TendProposal[];
  /** Parked records this survey could not match to a proposal. The important
   * one is `absent`: the worktree is gone, so this record is the only thing
   * that knows the work existed. */
  parked_unmatched: ParkUnmatched[];
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
  sessions?: Readonly<Record<string, SessionIdentity>>;
  /** The parked document's records. Supplied rather than read here so a survey
   * stays a pure judgement over its inputs; the CLI loads the file. */
  parked?: readonly ParkRecord[];
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
  /** Refuse to exit 0 unless every proposal in this survey carries this action.
   * A gate for a caller about to act on one worktree. */
  assertAction?: string;
  parkedFile: string;
  park?: string;
  unpark?: string;
  summary?: string;
  reason?: string;
  parkRepository?: string;
  parkBranch?: string;
  parkSession?: string;
  parkHarness?: string;
  parkName?: string;
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

function run(
  command: string,
  args: string[],
  cwd?: string,
  env?: Readonly<Record<string, string | undefined>>,
): CommandResult {
  const child = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: child.status ?? (child.error ? 1 : 0),
    stdout: child.stdout ?? "",
    stderr: child.error?.message ?? child.stderr ?? "",
  };
}

function git(
  cwd: string,
  args: string[],
  env?: Readonly<Record<string, string | undefined>>,
): CommandResult {
  return run("git", ["-C", cwd, ...args], undefined, env);
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

/** What an agent was, reduced to the three facts that outlive it: the name a
 * human knows it by, the harness that ran it, and the native session id that
 * resumes it. The last of those is why this store holds more than a slug —
 * parking exists to bring an agent back, and nothing else on the machine
 * remembers which session was working in a worktree once its row is gone. */
export interface SessionIdentity {
  slug: string | null;
  harness: string | null;
  session: string | null;
}

function conversationSlug(agent: JsonObject): string | null {
  const tokens = asObject(agent["tokens"]);
  const value = tokens?.["conversation"];
  return typeof value === "string" && value !== "" && value !== "untitled agent"
    ? value
    : null;
}

export function identityOf(agent: JsonObject): SessionIdentity {
  const harness = agent["agent"];
  return {
    slug: conversationSlug(agent),
    harness: typeof harness === "string" && harness !== "" ? harness : null,
    session: sessionId(agent),
  };
}

/** Keep an agent's identity after its live row disappears. No repository or
 * worktree metadata is written; the store is a file in the temp directory.
 *
 * Keyed by the agent's own directory rather than by a worktree derived from a
 * path layout: a worktree is only known to be one once Git names it, and
 * worktrees live wherever they were created, not only two segments below a
 * Herdr root. `identityForWorktree` resolves the key against a real worktree. */
export function rememberSessions(
  remembered: Record<string, SessionIdentity>,
  agents: readonly JsonObject[],
): void {
  for (const agent of agents) {
    const identity = identityOf(agent);
    // A row carrying neither name nor session teaches nothing, and writing it
    // would overwrite something a better-formed row already established.
    if (!identity.slug && !identity.session) continue;
    for (const path of agentPaths(agent)) {
      remembered[normalize(path)] = identity;
    }
  }
}

/** The identity remembered for the deepest agent directory inside this
 * worktree. Deepest wins so a nested worktree keeps its own identity rather
 * than inheriting the enclosing one's. */
export function identityForWorktree(
  remembered: Readonly<Record<string, SessionIdentity>>,
  worktree: string,
): SessionIdentity | null {
  let bestPath: string | null = null;
  let best: SessionIdentity | null = null;
  for (const [path, identity] of Object.entries(remembered)) {
    if (!pathIsWithin(path, worktree)) continue;
    if (bestPath === null || path.length > bestPath.length) {
      bestPath = path;
      best = identity;
    }
  }
  return best;
}

export function slugForWorktree(
  remembered: Readonly<Record<string, SessionIdentity>>,
  worktree: string,
): string | null {
  return identityForWorktree(remembered, worktree)?.slug ?? null;
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
    // Filled in once, after every downgrade has been applied: a park is
    // bookkeeping over the finished judgement, never an input to it.
    parked: [] as ParkRecord[],
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

function localBranchExists(repository: string, branch: string): boolean {
  return git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

/** The trunk of a repository that declares no fork model. This used to be the
 * literal `main`, which made every `master`-based repository unassessable: tend
 * reported "no local main branch" as an issue and surveyed none of its
 * worktrees, so a forgotten worktree in one was never proposed at all. Four
 * repositories on this machine are that shape.
 *
 * `main` still wins wherever it exists, so nothing about a `main`-based
 * repository changes; the fallback only speaks when there is no `main` to find.
 * It then believes the repository's own declaration of its default — the
 * `origin/HEAD` symbolic ref — and only guesses `master` when even that is
 * absent. The guess is deliberately last: a name Git itself reports beats a
 * convention, and both beat assuming the repository is broken. */
export function defaultTrunk(repository: string): string {
  if (localBranchExists(repository, "main")) return "main";
  const head = git(repository, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const named = head.stdout.trim().replace(/^origin\//, "");
    if (named && localBranchExists(repository, named)) return named;
  }
  if (localBranchExists(repository, "master")) return "master";
  // Nothing to judge against. Kept as `main` so the caller still reports the
  // repository as unassessable rather than inventing a trunk.
  return "main";
}

export function resolveModel(repository: string): RepositoryModel {
  const trunk = configuredValue(repository, "supervisor.trunk") ?? "";
  if (!trunk) {
    return {
      trunk: defaultTrunk(repository),
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
          : "repository has no local main or master branch, and no origin/HEAD naming one",
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
        slugForWorktree(options.sessions ?? {}, record.path),
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

  // The parked document, matched in after every judgement is final. A park
  // never changes what tend thinks should happen to a worktree — it records
  // that a human already answered that question, so the wizard stops asking.
  const parked = options.parked ?? [];
  const byWorktree = new Map<string, ParkRecord[]>();
  for (const record of parked) {
    const key = normalize(record.worktree);
    byWorktree.set(key, [...(byWorktree.get(key) ?? []), record]);
  }
  let parkedProposals = 0;
  for (const proposal of proposals) {
    const records = byWorktree.get(proposal.worktree);
    if (!records) continue;
    proposal.parked = records;
    parkedProposals += 1;
  }
  // A parked record with no proposal is the interesting case, and there are
  // three of them. The worktree may be gone — which is parking working as
  // intended, and leaves this record as the only thing that knows the work
  // existed. An agent may be back in it, which means somebody unparked it by
  // hand and the record is now stale. Or it may simply be sitting there with
  // nothing to propose. Each is reported; none is silently dropped, because a
  // record that stops being mentioned is a worktree nobody will ever rebuild.
  const proposed = new Set(proposals.map((proposal) => proposal.worktree));
  const parkedUnmatched: ParkUnmatched[] = [];
  for (const record of parked) {
    const worktree = normalize(record.worktree);
    if (proposed.has(worktree)) continue;
    // A targeted survey judged the paths it was asked about and nothing else,
    // so every other record is unexamined rather than unmatched.
    if (targeted.length > 0 && !targeted.includes(worktree)) continue;
    if (!existsSync(worktree)) {
      parkedUnmatched.push({
        record,
        status: "absent",
        detail: "the worktree is gone; this record is all that remains of it",
      });
    } else if (
      ownership.available && worktreeHasActiveAgent(worktree, ownership.agents)
    ) {
      parkedUnmatched.push({
        record,
        status: "occupied",
        detail: "an agent is working there again, so the record is stale",
      });
    } else {
      parkedUnmatched.push({
        record,
        status: "settled",
        detail: "the worktree is present and this survey proposes nothing for it",
      });
    }
  }
  parkedUnmatched.sort((left, right) =>
    left.record.worktree.localeCompare(right.record.worktree)
  );

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
    schema_version: 3,
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
      parked: parkedProposals,
      proposals: proposals.length,
    },
    proposals,
    parked_unmatched: parkedUnmatched,
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

/** A parked proposal is not a reason to wake anyone. The human looked at it,
 * decided, and wrote the decision down; waking them to report their own
 * decision back is the machine nagging. A machine whose every remaining
 * proposal is parked therefore goes quiet — which is the property that makes
 * parking worth doing rather than just skipping an item each run. */
export function shouldWakeSelf(enabled: boolean, survey: TendSurvey): boolean {
  const unparked = survey.proposals.some((proposal) => proposal.parked.length === 0);
  return enabled && (unparked || !survey.ownership_available);
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

/** Session identities outlive the process that learned them.
 *
 * The store used to be per-watcher and in memory only, which had two
 * consequences that showed up together. A watcher restart forgot every identity
 * it had accumulated; and `--once` — the mode the skill tells you to re-run
 * before writing a minisketch — had no store at all. Since a worktree with a
 * live agent is protected and never becomes a proposal, a proposal's slug can
 * only ever come from a remembered one, so `session_slug` was structurally
 * always null in snapshot mode and every bullet read "an older unattributed
 * session".
 *
 * The file sits beside the wake surveys rather than in any repository. The
 * constraint this code has always honoured is that tend writes no repository or
 * worktree metadata, and a temp file is neither.
 *
 * The filename still says slugs because that is what it held first, and
 * renaming it would silently forget every identity already stored on this
 * machine for no gain. A value that is a bare string is one of those older
 * entries and loads as a slug with no session. */
function sessionStorePath(): string {
  return join(tmpdir(), "tend-session-slugs.json");
}

function asIdentity(value: unknown): SessionIdentity | null {
  if (typeof value === "string") {
    return value === "" ? null : { slug: value, harness: null, session: null };
  }
  const row = asObject(value);
  if (!row) return null;
  const text = (key: string): string | null => {
    const found = row[key];
    return typeof found === "string" && found !== "" ? found : null;
  };
  const identity = { slug: text("slug"), harness: text("harness"), session: text("session") };
  return identity.slug || identity.session ? identity : null;
}

export function loadSessionIdentities(
  path: string = sessionStorePath(),
): Record<string, SessionIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Absent, unreadable or truncated all mean the same thing to a caller:
    // nothing is remembered. Never let a bad store break a survey.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const remembered: Record<string, SessionIdentity> = {};
  for (const [directory, value] of Object.entries(parsed as Record<string, unknown>)) {
    // A remembered directory that no longer exists belonged to a worktree that
    // has since been removed. Dropping it on load is what bounds the store.
    const identity = asIdentity(value);
    if (identity && existsSync(directory)) remembered[directory] = identity;
  }
  return remembered;
}

export function saveSessionIdentities(
  remembered: Readonly<Record<string, SessionIdentity>>,
  path: string = sessionStorePath(),
): void {
  // Written through a temp file and renamed: several watchers may run at once,
  // and a half-written store must never be readable as an empty one.
  const staging = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(remembered, null, 2)}\n`, "utf8");
    renameSync(staging, path);
  } catch {
    try {
      unlinkSync(staging);
    } catch {
      // Nothing to clean up.
    }
  }
}

/* ------------------------------------------------------------------ *
 * The parked document
 *
 * Everything above answers "what is here and what should happen to it".
 * This answers a different question: what has to be written down before a
 * worktree can be deleted without losing the work, and read back before the
 * same decision is put to a human twice.
 *
 * The document is Markdown in the operator's Obsidian vault because its first
 * reader is a human away from this terminal, possibly on a phone, possibly
 * months later, wondering what a directory that no longer exists was for. Tend
 * is its only writer, so the parser only has to understand what the renderer
 * emits — but a human may still correct a line, so parsing is tolerant: a
 * chunk it cannot read is skipped, never repaired and never fatal.
 * ------------------------------------------------------------------ */

const PARKED_HEADER = [
  "# Parked",
  "",
  "Agents and worktrees put away for later, written by `/tend`. Each entry holds",
  "what it takes to rebuild the worktree and resume the agent that was in it.",
].join("\n");

/** Entries are separated by a Markdown rule on its own line, which Obsidian
 * renders as a divider and this parser splits on. */
const PARK_SEPARATOR = "\n\n---\n\n";

export function parkedFilePath(): string {
  return process.env.TEND_PARKED_FILE ?? join(homedir(), "obsidian", "work", "Parked.md");
}

function quoted(value: string): string {
  return `\`${value}\``;
}

function unquoted(value: string | undefined): string {
  return (value ?? "").replace(/`/g, "").trim();
}

function backticked(value: string | undefined): string[] {
  return [...(value ?? "").matchAll(/`([^`]*)`/g)].map((match) => match[1]);
}

/** The recipe, as prose a human can follow and a shell can take verbatim.
 *
 * Recreating comes first because resuming lands the agent in its recorded cwd,
 * which is this worktree: resume before the directory exists and the agent
 * comes back somewhere its own conversation does not describe. The snapshot is
 * laid down with read-tree rather than checkout so that files the agent had
 * deleted stay deleted, and the reset that follows returns them to being
 * uncommitted changes rather than a staged commit waiting to happen. */
export function unparkCommand(record: ParkRecord): string {
  const steps: string[] = [];
  // A session that ran in the repository's own checkout has no worktree to
  // rebuild — the directory is the repository and it never went anywhere.
  // Emitting `worktree add` for it would be a command that fails at best and
  // creates a second checkout of the branch at worst.
  if (record.worktree !== record.repository) {
    const create = record.branch
      ? `git -C ${record.repository} worktree add ${record.worktree} ${record.branch}`
      : `git -C ${record.repository} worktree add --detach ${record.worktree} ${record.head}`;
    const restore = record.snapshot_ref
      ? ` && git -C ${record.worktree} read-tree -u --reset ${record.snapshot_ref}` +
        ` && git -C ${record.worktree} reset -q`
      : "";
    steps.push(`recreate ${quoted(`${create}${restore}`)}`);
  }
  if (record.session) {
    steps.push(`resume ${quoted(`agentlaunch x-resume ${record.session}`)}`);
  }
  if (steps.length === 0) steps.push(`open ${quoted(record.worktree)}`);
  return steps.join(", then ");
}

function renderEntry(record: ParkRecord): string {
  const lines = [`## ${record.name}`, "", record.summary, ""];
  lines.push(`- **Parked:** ${record.parked_at} — ${record.reason}`);
  lines.push(`- **Worktree:** ${quoted(record.worktree)}`);
  lines.push(`- **Repository:** ${quoted(record.repository)}`);
  lines.push(
    record.branch
      ? `- **Branch:** ${quoted(record.branch)} at ${quoted(record.head)}`
      : `- **Branch:** detached at ${quoted(record.head)}`,
  );
  if (record.session) {
    lines.push(`- **Session:** ${record.harness ?? "unknown"} ${quoted(record.session)}`);
  }
  // Only when it differs from the worktree root. An agent started in the
  // worktree it works in is the ordinary case, and repeating the path there
  // costs a line that says nothing.
  if (record.cwd) lines.push(`- **Cwd:** ${quoted(record.cwd)}`);
  if (record.snapshot_ref) {
    const paths = `${record.snapshot_paths} uncommitted ${record.snapshot_paths === 1 ? "path" : "paths"}`;
    lines.push(`- **Snapshot:** ${quoted(record.snapshot_ref)} — ${paths}`);
  }
  lines.push(`- **Unpark:** ${record.unpark}`);
  return lines.join("\n");
}

export function renderParked(records: readonly ParkRecord[]): string {
  return `${[PARKED_HEADER, ...records.map(renderEntry)].join(PARK_SEPARATOR)}\n`;
}

function parseEntry(chunk: string): ParkRecord | null {
  const fields = new Map<string, string>();
  let name = "";
  let summary = "";
  for (const line of chunk.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && name === "") {
      name = heading[1];
      continue;
    }
    const bullet = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (bullet) {
      fields.set(bullet[1].toLowerCase(), bullet[2].trim());
      continue;
    }
    // The first prose line under the heading is the summary; anything after
    // the bullets begin is a human's own note and is left alone.
    if (name !== "" && summary === "" && fields.size === 0 && line.trim() !== "") {
      summary = line.trim();
    }
  }
  const worktree = unquoted(fields.get("worktree"));
  const repository = unquoted(fields.get("repository"));
  const branchField = fields.get("branch") ?? "";
  const detached = /^detached\b/i.test(branchField);
  const branchParts = backticked(branchField);
  const head = detached ? (branchParts[0] ?? "") : (branchParts[1] ?? "");
  // The header chunk, a human's own note, and a mangled entry all land here.
  // None of them is an error: the document is a document first.
  if (worktree === "" || repository === "" || head === "") return null;
  const parkedField = fields.get("parked") ?? "";
  const [parkedAt, ...restOfParked] = parkedField.split(" — ");
  const sessionField = fields.get("session") ?? "";
  const session = backticked(sessionField)[0] ?? null;
  const harness = sessionField.split(/\s+/)[0] ?? "";
  const snapshotField = fields.get("snapshot") ?? "";
  const snapshotRef = backticked(snapshotField)[0] ?? null;
  const record: ParkRecord = {
    name: name === "" ? worktree.split("/").pop() ?? worktree : name,
    summary,
    reason: restOfParked.join(" — ").trim(),
    parked_at: parkedAt.trim(),
    worktree: normalize(worktree),
    repository: normalize(repository),
    branch: detached ? null : (branchParts[0] ?? null),
    head,
    harness: session && harness !== "" && harness !== "unknown" ? harness : null,
    session,
    cwd: unquoted(fields.get("cwd")) || null,
    snapshot_ref: snapshotRef,
    snapshot_paths: Number.parseInt(snapshotField.replace(/^[^—]*—\s*/, ""), 10) || 0,
    unpark: fields.get("unpark") ?? "",
  };
  // A record whose recipe was lost still knows everything the recipe is made
  // of, so rebuild it rather than handing back an entry that cannot be acted
  // on. An edited recipe is kept: a human who corrected it meant it.
  if (record.unpark === "") record.unpark = unparkCommand(record);
  return record;
}

export function parseParked(text: string): ParkRecord[] {
  const records: ParkRecord[] = [];
  for (const chunk of text.split(/\n---\n/)) {
    const record = parseEntry(chunk);
    if (record) records.push(record);
  }
  return records;
}

export function loadParked(path: string = parkedFilePath()): ParkRecord[] {
  try {
    return parseParked(readFileSync(path, "utf8"));
  } catch {
    // No document yet is the ordinary state of a machine nobody has parked
    // anything on.
    return [];
  }
}

export function saveParked(
  records: readonly ParkRecord[],
  path: string = parkedFilePath(),
): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, renderParked(records), "utf8");
  renameSync(staging, path);
}

/** Everything the worktree holds that no commit does, captured as a commit
 * without touching the worktree.
 *
 * This is what makes parking safe to follow with a removal. `git worktree
 * remove` refuses on a dirty worktree and deletes silently once it is clean,
 * so without this, "park it and delete it" would either be impossible for the
 * worktree of an agent that was mid-edit — which is most of them — or would
 * quietly destroy the edits. A separate index file is the whole trick: read
 * HEAD into it, add everything Git is willing to track, and write a tree. The
 * real index and every file in the worktree are untouched, so a snapshot is
 * safe to take even while something is working there.
 *
 * Ignored content is deliberately not captured: `add -A` honours .gitignore,
 * and a dependency tree does not belong in the object database. That is the
 * same content the ignored-content gate already refuses to let a removal
 * destroy unrecognized, so the two rules agree. */
function captureSnapshot(
  worktree: string,
  head: string,
  name: string,
): { ref: string; paths: number } | null {
  const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.code !== 0) return null;
  const paths = status.stdout.split("\n").filter((line) => line !== "").length;
  if (paths === 0) return null;
  const index = join(tmpdir(), `tend-park-index-${process.pid}-${Date.now()}`);
  const env = {
    GIT_INDEX_FILE: index,
    // The snapshot commit is tend's, not the operator's, and it must not
    // depend on a repository having configured an identity at all.
    GIT_AUTHOR_NAME: "tend",
    GIT_AUTHOR_EMAIL: "tend@localhost",
    GIT_COMMITTER_NAME: "tend",
    GIT_COMMITTER_EMAIL: "tend@localhost",
  };
  try {
    if (git(worktree, ["read-tree", "HEAD"], env).code !== 0) return null;
    if (git(worktree, ["add", "-A"], env).code !== 0) return null;
    const tree = git(worktree, ["write-tree"], env);
    if (tree.code !== 0) return null;
    const commit = git(
      worktree,
      ["commit-tree", chomp(tree.stdout), "-p", head, "-m", `tend park snapshot: ${name}`],
      env,
    );
    if (commit.code !== 0) return null;
    const ref = `refs/tend-park/${name}`;
    if (git(worktree, ["update-ref", ref, chomp(commit.stdout)], env).code !== 0) return null;
    return { ref, paths };
  } finally {
    try {
      unlinkSync(index);
    } catch {
      // Never written, or already gone.
    }
  }
}

export interface ParkRequest {
  worktree: string;
  summary: string;
  reason: string;
  file?: string;
  /** The live roster, preferred over the store: an agent still in the worktree
   * is a better witness to its own identity than anything remembered. */
  agents?: readonly JsonObject[];
  sessions?: Readonly<Record<string, SessionIdentity>>;
  now?: Date;
  /** The repository still holding the branch of a worktree that is already
   * gone. Required to park one, because nothing else can say where it came
   * from once the directory Git would have been asked is missing. */
  repository?: string;
  /** The branch to rebuild an absent worktree from. Required with it, and
   * never guessed from the directory's name: a wrong branch produces a record
   * that rebuilds the wrong work and looks correct doing it. */
  branch?: string;
  /** Identity for a session neither the live roster nor the store remembers —
   * reconstructed from the transcript archive by a human or an agent that went
   * looking. Overrides both, because a caller who has the session id has
   * better evidence than an empty store. */
  identity?: Partial<SessionIdentity>;
}

/** Write one park record, replacing any earlier record for the same worktree.
 *
 * Parking does not remove anything and does not need the worktree to be
 * inactive: a human may park an agent that is still working, and the ordinary
 * survey still decides whether the worktree may then be removed. What parking
 * establishes is that removal would no longer lose anything. */
export function parkWorktree(request: ParkRequest): ParkRecord {
  const worktree = normalize(request.worktree);
  const present = existsSync(worktree);
  let repository: string;
  let branch: string | null;
  let head: string;
  if (present) {
    const top = git(worktree, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) throw new Error(`${worktree} is not inside a Git repository`);
    if (normalize(chomp(top.stdout)) !== worktree) {
      throw new Error(`${worktree} is inside a worktree rather than being one`);
    }
    const commonDir = resolveCommonDir(worktree);
    if (!commonDir) throw new Error(`could not resolve the Git common directory for ${worktree}`);
    repository = mainWorktreeFor(commonDir, worktree);
    const resolved = git(worktree, ["rev-parse", "HEAD"]);
    if (resolved.code !== 0) throw new Error(`${worktree} has no HEAD commit to park`);
    head = chomp(resolved.stdout);
    const branchRef = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    branch = branchRef.code === 0 ? chomp(branchRef.stdout) : null;
  } else {
    // A worktree that is already gone can still be parked, and often should
    // be: the branch outlived it, so everything needed to rebuild it exists —
    // just not in the directory Git would normally be asked. Both facts must
    // be supplied rather than inferred from the path, because a name-derived
    // branch that happens to resolve rebuilds the wrong work convincingly.
    if (!request.repository) {
      throw new Error(
        `${worktree} does not exist; pass the repository that still holds its branch`,
      );
    }
    repository = normalize(request.repository);
    if (!isCheckoutRoot(repository)) {
      throw new Error(`${repository} is not a Git checkout root`);
    }
    if (!request.branch) {
      throw new Error(`${worktree} is gone; pass the branch it should be rebuilt from`);
    }
    branch = request.branch;
    const resolved = git(repository, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    if (resolved.code !== 0) {
      throw new Error(`${repository} has no branch ${branch} to rebuild ${worktree} from`);
    }
    head = chomp(resolved.stdout);
  }
  const live = (request.agents ?? []).find((agent) =>
    agentPaths(agent).some((path) => pathIsWithin(path, worktree))
  );
  const remembered = live
    ? identityOf(live)
    : identityForWorktree(request.sessions ?? {}, worktree);
  const identity: SessionIdentity = {
    slug: request.identity?.slug ?? remembered?.slug ?? null,
    harness: request.identity?.harness ?? remembered?.harness ?? null,
    session: request.identity?.session ?? remembered?.session ?? null,
  };
  const name = identity.slug ?? worktree.split("/").pop() ?? worktree;
  const agentCwd = live && typeof live["cwd"] === "string" ? normalize(live["cwd"]) : null;
  // Two cases must not be snapshotted, for the same reason: the uncommitted
  // work found there would not be the parked session's. An absent worktree has
  // none left to find, and a repository's main checkout is shared — whatever is
  // dirty in it today belongs to whoever is working in it now, and recording
  // that as this session's leavings would be a false record in the one document
  // that is supposed to be trustworthy.
  const snapshot = present && worktree !== repository
    ? captureSnapshot(worktree, head, name)
    : null;
  const record: ParkRecord = {
    name,
    summary: request.summary,
    reason: request.reason,
    parked_at: (request.now ?? new Date()).toISOString().slice(0, 10),
    worktree,
    repository,
    branch,
    head,
    harness: identity.harness,
    session: identity.session,
    cwd: agentCwd && agentCwd !== worktree ? agentCwd : null,
    snapshot_ref: snapshot?.ref ?? null,
    snapshot_paths: snapshot?.paths ?? 0,
    unpark: "",
  };
  record.unpark = unparkCommand(record);
  const file = request.file ?? parkedFilePath();
  // Replace the record for this worktree *and this session*, so re-parking
  // updates in place while a second session that worked in the same checkout
  // gets its own entry rather than quietly evicting the first.
  const kept = loadParked(file).filter((existing) =>
    existing.worktree !== worktree || existing.session !== record.session
  );
  saveParked([...kept, record], file);
  return record;
}

export interface UnparkResult {
  record: ParkRecord;
  /** True when the snapshot ref was left in place because the worktree it
   * restores into does not exist. Dropping the record is bookkeeping; dropping
   * the only copy of uncommitted work is not. */
  snapshot_kept: boolean;
}

/** Drop the records for one worktree, or one session's record within it.
 *
 * Without `session` this unparks everything recorded for that path, because
 * the ordinary case is one park per worktree and asking for a session id there
 * would be ceremony. Pass one where several sessions share a checkout. */
export function unparkWorktree(
  worktree: string,
  file: string = parkedFilePath(),
  session?: string,
): UnparkResult[] {
  const target = normalize(worktree);
  const records = loadParked(file);
  const dropped = records.filter((existing) =>
    existing.worktree === target && (session === undefined || existing.session === session)
  );
  if (dropped.length === 0) return [];
  saveParked(records.filter((existing) => !dropped.includes(existing)), file);
  return dropped.map((record) => {
    let kept = false;
    if (record.snapshot_ref) {
      // The ref goes only once the worktree is back, because a worktree that is
      // still absent means the snapshot was never laid down and this ref is the
      // only place that work exists.
      if (existsSync(target)) git(record.repository, ["update-ref", "-d", record.snapshot_ref]);
      else kept = true;
    }
    return { record, snapshot_kept: kept };
  });
}

/** How many of this watcher's survey files to leave in place. A wake the agent
 * has not read yet is still worth having, so this keeps more than one; an
 * unbounded pile in the temp directory is not. */
const WAKE_SURVEY_KEEP = 5;

/** The survey travels as a file rather than inline. A wake used to carry the
 * whole tend_survey JSON in the message body, which is tens of kilobytes on a
 * machine with dozens of worktrees — enough to bury the human's own
 * conversation in payload every time the picture changed. The path costs one
 * line and the reader fetches the rest only when it matters. */
export function writeWakeSurvey(survey: TendSurvey, now: number = Date.now()): string {
  const directory = tmpdir();
  const path = join(directory, `tend-survey-${process.pid}-${now}.json`);
  writeFileSync(path, `${JSON.stringify(survey, null, 2)}\n`, "utf8");
  pruneWakeSurveys(directory);
  return path;
}

function pruneWakeSurveys(directory: string): void {
  const prefix = `tend-survey-${process.pid}-`;
  let names: string[];
  try {
    names = readdirSync(directory).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".json"),
    );
  } catch {
    return;
  }
  // Fixed-width millisecond stamps, so lexical order is chronological order.
  names.sort();
  for (const name of names.slice(0, Math.max(0, names.length - WAKE_SURVEY_KEEP))) {
    try {
      unlinkSync(join(directory, name));
    } catch {
      // A reader may still hold it, or another sweep may have won the race.
    }
  }
}

/** The exit status of a gated snapshot.
 *
 * This exists because a hand-rolled gate is where tend runs go wrong. A script
 * that recomputes "is it clean, is it contained" itself will, sooner or later,
 * print a condition it does not enforce and act anyway — that has happened,
 * destroying ignored content the survey had already flagged. The survey has
 * already made the judgement, including every downgrade; the caller's job is to
 * obey it, not to re-derive it.
 *
 * A survey with no proposal fails too. A caller gating a removal must never read
 * "nothing proposed" as "nothing to worry about": a targeted path that is
 * missing, outside a repository, or no longer a candidate produces no proposal,
 * and acting on that silence is exactly the mistake. */
export function assertActionExit(expected: string | undefined, survey: TendSurvey): number {
  if (!expected) return 0;
  if (survey.issues.length > 0) {
    for (const issue of survey.issues) {
      process.stderr.write(`tend: cannot gate, ${issue.repository} could not be assessed: ${issue.reason}\n`);
    }
    return 2;
  }
  if (survey.proposals.length === 0) {
    process.stderr.write(
      "tend: cannot gate, the survey proposed nothing for the targeted worktrees; " +
        "an absent proposal is not permission to act\n",
    );
    return 3;
  }
  let refused = 0;
  for (const proposal of survey.proposals) {
    if (proposal.action === expected) continue;
    refused += 1;
    const downgrade = proposal.downgrade ? ` (downgraded by ${proposal.downgrade})` : "";
    process.stderr.write(
      `tend: refusing ${expected} on ${proposal.worktree}: the survey proposes ` +
        `${proposal.action}${downgrade} — ${proposal.reason}\n`,
    );
  }
  return refused > 0 ? 1 : 0;
}

export function wakeMessage(survey: TendSurvey, surveyPath: string): string {
  return [
    `<tend_event survey_file="${surveyPath}" proposals="${survey.proposals.length}" ownership_available="${survey.ownership_available}" />`,
    `Automated Tend wake — the complete tend_survey JSON is in the file named above; read it from there rather than expecting it inline. Re-run the read-only snapshot, notify if it still has proposals, and return the /tend minisketch. Lead with each event proposal's session_slug when the matching refreshed worktree and HEAD are unchanged; the live agent row may already be gone. Do not perform any proposed action.`,
  ].join("\n");
}

function wakeSelf(survey: TendSurvey, ownership: AgentSnapshot): void {
  const target = ownSession(ownership.agents);
  if (!target) {
    process.stderr.write("tend watch: cannot self-wake; this Herdr pane has no agent session\n");
    return;
  }
  const result = run("agentsurface", [
    "message",
    target,
    wakeMessage(survey, writeWakeSurvey(survey)),
  ]);
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
      "assert-action": { type: "string" },
      "parked-file": { type: "string" },
      park: { type: "string" },
      unpark: { type: "string" },
      summary: { type: "string" },
      reason: { type: "string" },
      repository: { type: "string" },
      branch: { type: "string" },
      session: { type: "string" },
      harness: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (parsed.values.help) {
    process.stdout.write(
      [
        "Usage: watch.ts [--once] [--wake-self] [--project-root PATH]...",
        "                [--worktree-root PATH]... (default: $HOME) [--socket PATH]",
        "                [--sweep-interval SECONDS] [--activity-window SECONDS]",
        "                [--worktree PATH]... [--assert-action ACTION]",
        "       watch.ts --park PATH --summary TEXT --reason TEXT",
        "                [--repository PATH --branch NAME]  (a worktree already gone)",
        "                [--name SLUG --harness NAME --session ID]  (a session neither",
        "                the roster nor the store remembers)",
        "       watch.ts --unpark PATH",
        "                [--parked-file PATH] (default: ~/obsidian/work/Parked.md)",
        "",
        "Emits read-only tend_survey JSON records. The long-running mode watches Git and",
        "Herdr, while --once prints one snapshot and exits. With --assert-action, --once",
        "exits non-zero unless every proposal carries that action, so a caller can gate an",
        "operation on the survey rather than on its own re-derived checks.",
        "",
        "--park records one agent and its worktree in the parked document: the path,",
        "branch and commit to rebuild from, the session id that resumes the agent, and a",
        "snapshot of whatever was never committed — so the worktree can be removed",
        "without losing it. --unpark drops that record once the work is back.",
        "",
      ].join("\n"),
    );
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
    assertAction: parsed.values["assert-action"],
    parkedFile: normalize(parsed.values["parked-file"] ?? parkedFilePath()),
    park: parsed.values.park ? normalize(parsed.values.park) : undefined,
    unpark: parsed.values.unpark ? normalize(parsed.values.unpark) : undefined,
    summary: parsed.values.summary,
    reason: parsed.values.reason,
    parkRepository: parsed.values.repository,
    parkBranch: parsed.values.branch,
    parkSession: parsed.values.session,
    parkHarness: parsed.values.harness,
    parkName: parsed.values.name,
  };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  if (process.env.HERDR_ENV !== "1") {
    process.stderr.write("tend watch: this process is not running inside Herdr (HERDR_ENV=1)\n");
    process.exit(1);
  }

  if (options.park) {
    if (!options.summary || !options.reason) {
      process.stderr.write(
        "tend: --park needs both --summary (one sentence on what this agent and " +
          "worktree are) and --reason (why it is being put away)\n",
      );
      process.exit(2);
    }
    const ownership = queryAgents(options.herdrBin);
    try {
      const record = parkWorktree({
        worktree: options.park,
        summary: options.summary,
        reason: options.reason,
        file: options.parkedFile,
        agents: ownership.agents,
        sessions: loadSessionIdentities(),
        repository: options.parkRepository,
        branch: options.parkBranch,
        identity: {
          slug: options.parkName,
          harness: options.parkHarness,
          session: options.parkSession,
        },
      });
      process.stdout.write(`${JSON.stringify({ type: "tend_park", record })}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `tend: cannot park ${options.park}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  }

  if (options.unpark) {
    const results = unparkWorktree(options.unpark, options.parkedFile, options.parkSession);
    if (results.length === 0) {
      process.stderr.write(`tend: nothing parked at ${options.unpark}\n`);
      process.exit(1);
    }
    for (const result of results) {
      if (!result.snapshot_kept) continue;
      process.stderr.write(
        `tend: kept ${result.record.snapshot_ref} — ${result.record.worktree} does not exist, ` +
          "so that ref is still the only copy of the uncommitted work\n",
      );
    }
    process.stdout.write(`${JSON.stringify({ type: "tend_unpark", unparked: results })}\n`);
    process.exit(0);
  }

  if (options.once) {
    // A snapshot contributes to the store as well as reading it. Every tend
    // run is a chance to learn an identity that will not be available later:
    // by the time a worktree becomes a proposal its agent has left, and by the
    // time it is parked, its session id exists nowhere else on the machine.
    const ownership = queryAgents(options.herdrBin);
    const remembered = loadSessionIdentities();
    rememberSessions(remembered, ownership.agents);
    saveSessionIdentities(remembered);
    const survey = surveyWorktrees(
      {
        ...options,
        ownership,
        sessions: remembered,
        parked: loadParked(options.parkedFile),
      },
      "snapshot",
    );
    process.stdout.write(`${JSON.stringify(survey)}\n`);
    process.exit(assertActionExit(options.assertAction, survey));
  }

  let lastFingerprint = "";
  const rememberedSessions: Record<string, SessionIdentity> = loadSessionIdentities();
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
    rememberSessions(rememberedSessions, ownership.agents);
    saveSessionIdentities(rememberedSessions);
    const survey = surveyWorktrees({
      ...options,
      ownership,
      sessions: rememberedSessions,
      // Re-read every publish: the document is edited by tend runs in other
      // panes and by the human in Obsidian, and a watcher holding a stale copy
      // would keep waking about work somebody already put away.
      parked: loadParked(options.parkedFile),
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
