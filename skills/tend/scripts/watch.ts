#!/usr/bin/env bun

import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export type JsonObject = Record<string, unknown>;

export interface AgentSnapshot {
  available: boolean;
  agents: JsonObject[];
  error: string | null;
}

export type ProposalAction =
  | "remove_worktree"
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

export interface TendProposal {
  action: ProposalAction;
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
  /** Optional location restriction. Empty means every linked worktree a
   * discovered repository registers, wherever it lives; a non-empty list keeps
   * only worktrees below one of these roots. The main checkout is never a
   * candidate either way. */
  worktreeRoots: readonly string[];
  ownership?: AgentSnapshot;
  sessionSlugs?: Readonly<Record<string, string>>;
  herdrBin?: string;
}

interface WatchOptions extends SurveyOptions {
  socketPath: string;
  sweepIntervalSeconds: number;
  once: boolean;
  wakeSelf: boolean;
}

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

function resolveCommonDir(checkout: string): string | null {
  const result = git(checkout, ["rev-parse", "--git-common-dir"]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return normalize(isAbsolute(value) ? value : join(checkout, value));
}

function candidateDirectories(root: string): string[] {
  const normalized = normalize(root);
  if (!existsSync(normalized)) return [];
  const candidates = [normalized];
  try {
    for (const entry of readdirSync(normalized, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(normalized, entry.name));
    }
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

  const admit = (candidate: string): void => {
    const commonDir = resolveCommonDir(candidate);
    if (!commonDir || byCommonDir.has(commonDir)) return;
    const repository = mainWorktreeFor(commonDir, normalize(candidate));
    byCommonDir.set(commonDir, repository);
    pending.push(repository);
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
      if (!resolveCommonDir(path)) {
        issues.push(reason("is not a Git repository"));
        continue;
      }
      admit(path);
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

/** Short branch names this repository holds a remote-tracking ref for, read
 * from local refs only — never a fetch, never a network call. Publication is
 * evidence about a branch, not a source for the branch model, which still
 * comes from the declared config and nothing else. */
export function publishedBranchNames(repository: string): Set<string> {
  const names = new Set<string>();
  const result = git(repository, ["for-each-ref", "--format=%(refname)", "refs/remotes"]);
  if (result.code !== 0) return names;
  const prefix = "refs/remotes/";
  for (const line of result.stdout.split("\n")) {
    const ref = line.trim();
    if (!ref.startsWith(prefix)) continue;
    const withoutRemote = ref.slice(prefix.length);
    const separator = withoutRemote.indexOf("/");
    if (separator === -1) continue;
    const branch = withoutRemote.slice(separator + 1);
    if (branch === "" || branch === "HEAD") continue;
    names.add(branch);
  }
  return names;
}

function inspectWorktree(
  repository: string,
  record: WorktreeRecord,
  trunkHead: string,
  model: RepositoryModel,
  sessionSlug: string | null,
  published: ReadonlySet<string>,
): TendProposal {
  const status = git(record.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const clean = status.code === 0 && status.stdout.trim() === "";
  const counts = aheadBehind(record.path, model.trunk) ?? { ahead: 0, behind: 0 };
  const base = {
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
  };

  if (record.prunable) {
    return { ...base, action: "inspect", reason: "Git marks the worktree registration prunable" };
  }
  if (record.detached || record.branch === null) {
    return { ...base, action: "inspect", reason: "the worktree is detached" };
  }
  if (!clean) {
    return { ...base, action: "inspect", reason: "the worktree has uncommitted changes" };
  }
  const held = heldByModel(record.branch, model);
  if (held) {
    return {
      ...base,
      action: "inspect",
      reason: `the worktree holds ${held}`,
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
    if (model.fork && published.has(record.branch)) {
      return {
        ...base,
        action: "inspect",
        reason:
          `the branch is published on a remote, so containment in ${model.trunk} is not evidence the carry is finished`,
      };
    }
    return {
      ...base,
      action: "remove_worktree",
      reason: `the clean worktree HEAD is contained in local ${model.trunk}`,
    };
  }
  if (counts.ahead > 0 && counts.behind > 0) {
    return {
      ...base,
      action: "catch_up_to_trunk",
      reason: `the clean branch has commits on both sides of local ${model.trunk}`,
    };
  }
  return {
    ...base,
    action: "inspect",
    reason: counts.ahead > 0
      ? `the inactive branch has commits not in local ${model.trunk}`
      : "Git could not establish a conservative lifecycle action",
  };
}

function trunkHead(repository: string, trunk: string): string | null {
  const result = git(repository, ["rev-parse", "--verify", `refs/heads/${trunk}`]);
  return result.code === 0 ? result.stdout.trim() : null;
}

function configuredValue(repository: string, key: string): string | null {
  const result = git(repository, ["config", "--get", key]);
  return result.code === 0 ? result.stdout.replace(/\n$/, "") : null;
}

/** A declared prefix may legitimately be empty — a linear-stack fork carries
 * no carry heads — so an empty declaration is not a missing one. */
/** Every value of a multi-valued declaration; empty when the key is absent.
 * A key a workshop has not converged yet reads as no values, which must behave
 * exactly as the single-valued world behaved before the key existed. */
function configuredValues(repository: string, key: string): string[] {
  const result = git(repository, ["config", "--get-all", key]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function declaredPrefix(repository: string, key: string): string | null {
  const value = configuredValue(repository, key);
  return value === null || value === "" ? null : value;
}

export function resolveModel(repository: string): RepositoryModel {
  const trunk = configuredValue(repository, "supervisor.trunk")?.trim() ?? "";
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
    mirror: configuredValue(repository, "supervisor.mirror")?.trim() || null,
    carry_prefixes: configuredValues(repository, "supervisor.carryPrefix"),
    carry_refs: configuredValues(repository, "supervisor.carryRef"),
    quarantine_prefix: declaredPrefix(repository, "supervisor.quarantinePrefix"),
    workshop: configuredValue(repository, "supervisor.workshop")?.trim() || null,
    fork: true,
  };
}

/** Branches the declared model keeps. Their worktrees are the fork's standing
 * working set, so containment in the trunk is not evidence they are finished:
 * a published carry head is an ancestor of integration by design. */
function heldByModel(branch: string, model: RepositoryModel): string | null {
  if (branch === model.trunk) return `the declared integration branch ${model.trunk}`;
  if (model.mirror && branch === model.mirror) return `the declared mirror branch ${model.mirror}`;
  for (const prefix of model.carry_prefixes) {
    if (branch.startsWith(prefix)) {
      return `a carried feature under the declared prefix ${prefix}`;
    }
  }
  if (model.carry_refs.includes(branch)) {
    return `the declared carry head ${branch}`;
  }
  if (model.quarantine_prefix && branch.startsWith(model.quarantine_prefix)) {
    return `an explicit deletion marker under ${model.quarantine_prefix}`;
  }
  return null;
}

export function surveyWorktrees(
  options: SurveyOptions,
  occasion: TendSurvey["occasion"] = "snapshot",
): TendSurvey {
  const discovered = findRepositories(options.projectRoots);
  const repositories = discovered.repositories;
  const ownership = options.ownership ?? queryAgents(options.herdrBin);
  const proposals: TendProposal[] = [];
  const issues: TendIssue[] = [...discovered.issues];
  let linkedWorktrees = 0;
  let herdrWorktrees = 0;
  let protectedByAgent = 0;

  if (!ownership.available) {
    issues.push({
      repository: null,
      worktree: null,
      reason: `Herdr ownership unavailable: ${ownership.error ?? "unknown error"}`,
    });
  }

  const herdrRoot = normalize(join(homedir(), ".herdr", "worktrees"));
  for (const repository of repositories) {
    const worktrees = listWorktrees(repository).filter((record) => {
      // The main checkout is never a lifecycle candidate. It was previously
      // excluded only as a side effect of the Herdr-root filter, so it has to
      // be excluded on its own now that worktrees anywhere are considered.
      if (normalize(record.path) === normalize(repository)) return false;
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
    const published = model.fork ? publishedBranchNames(repository) : new Set<string>();
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
    for (const record of worktrees) {
      if (!ownership.available) continue;
      if (worktreeHasActiveAgent(record.path, ownership.agents)) {
        protectedByAgent += 1;
        continue;
      }
      proposals.push(inspectWorktree(
        repository,
        record,
        target,
        model,
        slugForWorktree(options.sessionSlugs ?? {}, record.path),
        published,
      ));
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
      proposals: proposals.length,
    },
    proposals,
    issues,
  };
}

export function surveyFingerprint(survey: TendSurvey): string {
  return JSON.stringify({
    ownership_available: survey.ownership_available,
    proposals: survey.proposals,
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
      once: { type: "boolean", default: false },
      "wake-self": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (parsed.values.help) {
    process.stdout.write(`Usage: watch.ts [--once] [--wake-self] [--project-root PATH]...\n+                [--worktree-root PATH]... [--socket PATH] [--sweep-interval SECONDS]\n+\n+Emits read-only tend_survey JSON records. The long-running mode watches Git and\n+Herdr, while --once prints one snapshot and exits.\n`);
    process.exit(0);
  }
  return {
    projectRoots: (parsed.values["project-root"] ?? [join(homedir(), "code"), join(homedir(), "src")]).map(normalize),
    worktreeRoots: (parsed.values["worktree-root"] ?? []).map(normalize),
    socketPath: normalize(parsed.values.socket ?? defaultSocketPath()),
    sweepIntervalSeconds: parseSeconds(parsed.values["sweep-interval"]),
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
    gitWatches.refresh(findRepositories(options.projectRoots), schedule);
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
