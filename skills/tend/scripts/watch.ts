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
  | "catch_up_to_main"
  | "inspect";

export interface TendProposal {
  action: ProposalAction;
  session_slug: string | null;
  repository: string;
  worktree: string;
  branch: string | null;
  head: string;
  main_head: string;
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
  schema_version: 1;
  type: "tend_survey";
  occasion: "snapshot" | "start" | "change";
  generated_at: string;
  ownership_available: boolean;
  counts: {
    repositories: number;
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
  worktreeRoot: string;
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

export function findRepositories(projectRoots: readonly string[]): string[] {
  const byCommonDir = new Map<string, string>();
  for (const root of projectRoots) {
    for (const candidate of candidateDirectories(root)) {
      const commonDir = resolveCommonDir(candidate);
      if (commonDir && !byCommonDir.has(commonDir)) byCommonDir.set(commonDir, normalize(candidate));
    }
  }
  return [...byCommonDir.values()].sort();
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

function worktreeRootForAgentPath(path: string, worktreeRoot: string): string | null {
  const rel = relative(normalize(worktreeRoot), normalize(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/);
  return parts.length >= 2 ? normalize(join(worktreeRoot, parts[0]!, parts[1]!)) : null;
}

/** Keep the human-facing conversation identity after its live agent row
 * disappears. The long-running watcher owns this in memory; no repository or
 * worktree metadata is written. */
export function rememberSessionSlugs(
  remembered: Record<string, string>,
  agents: readonly JsonObject[],
  worktreeRoot: string,
): void {
  for (const agent of agents) {
    const slug = conversationSlug(agent);
    if (!slug) continue;
    for (const path of agentPaths(agent)) {
      const worktree = worktreeRootForAgentPath(path, worktreeRoot);
      if (worktree) remembered[worktree] = slug;
    }
  }
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

function aheadBehind(worktree: string): { ahead: number; behind: number } | null {
  const result = git(worktree, [
    "rev-list",
    "--left-right",
    "--count",
    "refs/heads/main...HEAD",
  ]);
  if (result.code !== 0) return null;
  const [behindText, aheadText] = result.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindText ?? "", 10);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

function inspectWorktree(
  repository: string,
  record: WorktreeRecord,
  mainHead: string,
  sessionSlug: string | null,
): TendProposal {
  const status = git(record.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const clean = status.code === 0 && status.stdout.trim() === "";
  const counts = aheadBehind(record.path) ?? { ahead: 0, behind: 0 };
  const base = {
    session_slug: sessionSlug,
    repository,
    worktree: record.path,
    branch: record.branch,
    head: record.head,
    main_head: mainHead,
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
  if (record.branch === "main") {
    return { ...base, action: "inspect", reason: "the linked worktree has main checked out" };
  }

  const contained = git(record.path, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    "refs/heads/main",
  ]).code === 0;
  if (contained) {
    return {
      ...base,
      action: "remove_worktree",
      reason: "the clean worktree HEAD is contained in local main",
    };
  }
  if (counts.ahead > 0 && counts.behind > 0) {
    return {
      ...base,
      action: "catch_up_to_main",
      reason: "the clean branch has commits on both sides of local main",
    };
  }
  return {
    ...base,
    action: "inspect",
    reason: counts.ahead > 0
      ? "the inactive branch has commits not in local main"
      : "Git could not establish a conservative lifecycle action",
  };
}

function mainHead(repository: string): string | null {
  const result = git(repository, ["rev-parse", "--verify", "refs/heads/main"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

function configuredNonMainTrunk(repository: string): string | null {
  const result = git(repository, ["config", "--get", "supervisor.trunk"]);
  if (result.code !== 0) return null;
  const branch = result.stdout.trim();
  return branch && branch !== "main" ? branch : null;
}

export function surveyWorktrees(
  options: SurveyOptions,
  occasion: TendSurvey["occasion"] = "snapshot",
): TendSurvey {
  const repositories = findRepositories(options.projectRoots);
  const ownership = options.ownership ?? queryAgents(options.herdrBin);
  const proposals: TendProposal[] = [];
  const issues: TendIssue[] = [];
  let herdrWorktrees = 0;
  let protectedByAgent = 0;

  if (!ownership.available) {
    issues.push({
      repository: null,
      worktree: null,
      reason: `Herdr ownership unavailable: ${ownership.error ?? "unknown error"}`,
    });
  }

  for (const repository of repositories) {
    const worktrees = listWorktrees(repository).filter((record) =>
      pathIsWithin(record.path, options.worktreeRoot)
    );
    herdrWorktrees += worktrees.length;
    if (worktrees.length === 0) continue;
    const nonMainTrunk = configuredNonMainTrunk(repository);
    if (nonMainTrunk) {
      issues.push({
        repository,
        worktree: null,
        reason: `repository integrates into ${nonMainTrunk}, not main; Tend will not infer lifecycle actions`,
      });
      continue;
    }
    const target = mainHead(repository);
    if (!target) {
      issues.push({ repository, worktree: null, reason: "repository has no local main branch" });
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
        options.sessionSlugs?.[normalize(record.path)] ?? null,
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
    schema_version: 1,
    type: "tend_survey",
    occasion,
    generated_at: new Date().toISOString(),
    ownership_available: ownership.available,
    counts: {
      repositories: repositories.length,
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
      "worktree-root": { type: "string" },
      socket: { type: "string" },
      "sweep-interval": { type: "string" },
      once: { type: "boolean", default: false },
      "wake-self": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (parsed.values.help) {
    process.stdout.write(`Usage: watch.ts [--once] [--wake-self] [--project-root PATH]...\n+                [--worktree-root PATH] [--socket PATH] [--sweep-interval SECONDS]\n+\n+Emits read-only tend_survey JSON records. The long-running mode watches Git and\n+Herdr, while --once prints one snapshot and exits.\n`);
    process.exit(0);
  }
  return {
    projectRoots: (parsed.values["project-root"] ?? [join(homedir(), "code"), join(homedir(), "src")]).map(normalize),
    worktreeRoot: normalize(parsed.values["worktree-root"] ?? join(homedir(), ".herdr", "worktrees")),
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
    rememberSessionSlugs(rememberedSessionSlugs, ownership.agents, options.worktreeRoot);
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
