/**
 * Dashboard projection: folds a run session's {@link RunEvent} stream into the
 * view model the orchestrator dashboard renders — runs grouped into phase
 * stations, each run's current state, a state timeline for the gantt, setup
 * steps and a bounded log.
 *
 * Pure and platform-neutral (type-only imports) so it runs in the browser and
 * in tests. The projection is mutable for throughput: every change bumps the
 * touched run's `rev` and the session's `rev`, so renderers can memoise on
 * those numbers instead of diffing.
 */

import type { RunEvent, RunEventLabels, RunEventUsage } from "../RunEvents.js";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/**
 * Where a run is in its lifecycle.
 *
 * - `provisioning`: worktree, copy-to-worktree and sandbox start
 * - `setup`: hooks running before the first iteration
 * - `working`: the agent is producing output
 * - `quiet`: the agent has gone silent long enough to trip an idle warning
 * - `finishing`: the agent stopped or signalled completion; commits are being collected
 * - `done` / `failed`: terminal
 * - `lost`: not terminal, but the process that made it is gone (crash, Ctrl+C)
 */
export type RunState =
  | "provisioning"
  | "setup"
  | "working"
  | "quiet"
  | "finishing"
  | "done"
  | "failed"
  | "lost";

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "done",
  "failed",
  "lost",
]);

/** A span of time a run spent in one state. `end` is unset while it is current. */
export interface StateSegment {
  readonly state: RunState;
  readonly start: number;
  end?: number;
}

export type SetupStepKind = "worktree" | "copy" | "sandbox" | "hook";

export interface SetupStep {
  readonly kind: SetupStepKind;
  /** Human label: hook name, sandbox provider, worktree branch. */
  readonly label: string;
  /** Hook command, worktree path or copied paths. */
  readonly detail?: string;
  readonly start: number;
  end?: number;
  durationMs?: number;
  /** `undefined` while running. */
  ok?: boolean;
  /** True when a worktree or sandbox was reused rather than created. */
  reused?: boolean;
}

export type LogKind =
  | "text"
  | "tool"
  | "lifecycle"
  | "commit"
  | "warn"
  | "error"
  | "output";

export interface LogEntry {
  readonly seq: number;
  readonly at: number;
  readonly kind: LogKind;
  readonly iteration?: number;
  /** Primary line: agent text, tool name, lifecycle message. */
  readonly text: string;
  /** Secondary line: tool arguments, hook command, JSON payload. */
  readonly detail?: string;
}

export interface IterationView {
  readonly iteration: number;
  readonly start: number;
  end?: number;
  toolCalls: number;
  commits: number;
  usage?: RunEventUsage;
  agentSessionId?: string;
}

export interface RunView {
  readonly runId: string;
  readonly sessionId: string;
  /** Bumped on every change to this run. */
  rev: number;

  readonly name?: string;
  readonly labels: RunEventLabels;
  /** `labels.phase`, or {@link UNLABELED_PHASE}. */
  readonly phase: string;
  readonly cycle?: string;
  readonly issue?: string;
  readonly agent: string;
  readonly model?: string;
  readonly sandbox: string;
  readonly branchStrategy: string;
  branch?: string;
  readonly maxIterations: number;
  readonly hostRepoDir: string;
  readonly pid?: number;

  state: RunState;
  /** Last non-terminal state, kept so a `lost` run can show where it died. */
  lastLiveState: RunState;
  readonly segments: StateSegment[];
  readonly startedAt: number;
  endedAt?: number;
  lastEventAt: number;
  /** Most recent thing the agent did, for the one-line card summary. */
  lastActivity?: { kind: "text" | "tool"; text: string; at: number };

  iteration: number;
  readonly iterations: IterationView[];
  readonly commits: { sha: string; iteration: number; at: number }[];
  usage: RunEventUsage;
  toolCalls: number;
  readonly setup: SetupStep[];

  /** Bounded: the oldest entries are dropped past {@link MAX_LOG_ENTRIES}. */
  readonly log: LogEntry[];
  /** How many log entries were dropped from the front. */
  logDropped: number;

  worktreePath?: string;
  preservedWorktreePath?: string;
  completionSignal?: string;
  structuredOutput?: { tag: string; value: unknown };
  /**
   * Set while the agent is quiet. `silentSince` is when it last produced
   * output (or started), so durations stay right even if warnings are late.
   */
  idle?: {
    minutes: number;
    timeoutSeconds: number;
    at: number;
    silentSince: number;
  };
  /** When the agent last produced output or (re)started. */
  lastOutputAt?: number;
  error?: { tag?: string; message: string; aborted: boolean };
}

/** A phase column on the factory floor. */
export interface StationView {
  readonly phase: string;
  /** Run ids, in start order. */
  readonly runIds: string[];
}

export interface SessionTotals {
  runs: number;
  active: number;
  done: number;
  failed: number;
  lost: number;
  commits: number;
  toolCalls: number;
  usage: RunEventUsage;
}

export interface SessionView {
  sessionId?: string;
  /** Bumped on every applied event. */
  rev: number;
  readonly runs: Map<string, RunView>;
  /** Run ids in start order. */
  readonly runOrder: string[];
  /** Phase stations, in first-seen order. */
  readonly stations: StationView[];
  /** Distinct cycle labels, in first-seen order. */
  readonly cycles: string[];
  startedAt?: number;
  lastEventAt?: number;
  eventCount: number;
  lastSeq: number;
  readonly totals: SessionTotals;
}

/** Station name for runs that carry no `phase` label. */
export const UNLABELED_PHASE = "runs";

/** Per-run log cap, so a chatty agent cannot grow the page without bound. */
export const MAX_LOG_ENTRIES = 2000;

/** Agent text longer than this is truncated in the log. */
const MAX_TEXT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const zeroUsage = (): RunEventUsage => ({
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
});

const addUsage = (into: RunEventUsage, add: RunEventUsage): RunEventUsage => ({
  inputTokens: into.inputTokens + add.inputTokens,
  cacheCreationInputTokens:
    into.cacheCreationInputTokens + add.cacheCreationInputTokens,
  cacheReadInputTokens: into.cacheReadInputTokens + add.cacheReadInputTokens,
  outputTokens: into.outputTokens + add.outputTokens,
});

/** Total tokens across every bucket. */
export const totalTokens = (u: RunEventUsage): number =>
  u.inputTokens +
  u.cacheCreationInputTokens +
  u.cacheReadInputTokens +
  u.outputTokens;

export const createSessionView = (): SessionView => ({
  rev: 0,
  runs: new Map(),
  runOrder: [],
  stations: [],
  cycles: [],
  eventCount: 0,
  lastSeq: 0,
  totals: {
    runs: 0,
    active: 0,
    done: 0,
    failed: 0,
    lost: 0,
    commits: 0,
    toolCalls: 0,
    usage: zeroUsage(),
  },
});

const labelString = (
  labels: RunEventLabels,
  key: string,
): string | undefined => {
  const v = labels[key];
  return v === undefined ? undefined : String(v);
};

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + "…" : s;

const firstLine = (s: string): string => {
  const trimmed = s.trim();
  const nl = trimmed.indexOf("\n");
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
};

const setState = (run: RunView, state: RunState, at: number): void => {
  if (run.state === state) return;
  const current = run.segments.at(-1);
  if (current && current.end === undefined) current.end = at;
  run.state = state;
  if (!TERMINAL_STATES.has(state)) run.lastLiveState = state;
  if (TERMINAL_STATES.has(state)) {
    run.endedAt = at;
    // Terminal states get a zero-length marker segment so the gantt can draw an end cap.
    run.segments.push({ state, start: at, end: at });
  } else {
    // Leaving a terminal state (a `lost` run that turned out to be alive): it has not ended.
    run.endedAt = undefined;
    run.segments.push({ state, start: at });
  }
};

const pushLog = (run: RunView, entry: LogEntry): void => {
  run.log.push(entry);
  if (run.log.length > MAX_LOG_ENTRIES) {
    const drop = run.log.length - MAX_LOG_ENTRIES;
    run.log.splice(0, drop);
    run.logDropped += drop;
  }
};

const openStep = (run: RunView, kind: SetupStepKind, label: string) =>
  [...run.setup]
    .reverse()
    .find((s) => s.kind === kind && s.label === label && s.end === undefined);

const recomputeTotals = (view: SessionView): void => {
  const t = view.totals;
  t.runs = view.runs.size;
  t.active = 0;
  t.done = 0;
  t.failed = 0;
  t.lost = 0;
  t.commits = 0;
  t.toolCalls = 0;
  t.usage = zeroUsage();
  for (const run of view.runs.values()) {
    if (run.state === "done") t.done++;
    else if (run.state === "failed") t.failed++;
    else if (run.state === "lost") t.lost++;
    else t.active++;
    t.commits += run.commits.length;
    t.toolCalls += run.toolCalls;
    t.usage = addUsage(t.usage, run.usage);
  }
};

/**
 * Apply one event. Events for unknown runs (whose `runStarted` was not seen,
 * e.g. a truncated file) create a placeholder run so nothing is silently lost.
 * Duplicate or out-of-order events (by `seq`) within a run are applied in
 * arrival order; the server delivers file order, which is emission order.
 */
export const applyEvent = (view: SessionView, event: RunEvent): void => {
  const at = Date.parse(event.ts) || Date.now();
  view.sessionId ??= event.sessionId;
  view.eventCount++;
  view.lastSeq = Math.max(view.lastSeq, event.seq);
  view.startedAt = Math.min(view.startedAt ?? at, at);
  view.lastEventAt = Math.max(view.lastEventAt ?? at, at);
  view.rev++;

  let run = view.runs.get(event.runId);
  if (!run) {
    run = createRun(view, event, at);
  }
  run.rev++;
  run.lastEventAt = Math.max(run.lastEventAt, at);

  // A late event on a run already marked lost means the process is alive after all.
  if (run.state === "lost" && event.type !== "runStarted") {
    setState(run, run.lastLiveState, at);
  }

  applyToRun(run, event, at);
  recomputeTotals(view);
};

const createRun = (view: SessionView, event: RunEvent, at: number): RunView => {
  const started = event.type === "runStarted" ? event : undefined;
  const labels = started?.labels ?? {};
  const phase = labelString(labels, "phase") ?? UNLABELED_PHASE;
  const cycle = labelString(labels, "cycle");
  const run: RunView = {
    runId: event.runId,
    sessionId: event.sessionId,
    rev: 0,
    name: started?.name,
    labels,
    phase,
    cycle,
    issue: labelString(labels, "issue"),
    agent: started?.agent ?? "unknown",
    model: started?.model,
    sandbox: started?.sandbox ?? "unknown",
    branchStrategy: started?.branchStrategy ?? "unknown",
    branch: started?.branch,
    maxIterations: started?.maxIterations ?? 1,
    hostRepoDir: started?.hostRepoDir ?? "",
    pid: started?.pid,
    state: "provisioning",
    lastLiveState: "provisioning",
    segments: [{ state: "provisioning", start: at }],
    startedAt: at,
    lastEventAt: at,
    iteration: 0,
    iterations: [],
    commits: [],
    usage: zeroUsage(),
    toolCalls: 0,
    setup: [],
    log: [],
    logDropped: 0,
  };
  view.runs.set(run.runId, run);
  view.runOrder.push(run.runId);

  let station = view.stations.find((s) => s.phase === phase);
  if (!station) {
    station = { phase, runIds: [] };
    view.stations.push(station);
  }
  station.runIds.push(run.runId);
  if (cycle !== undefined && !view.cycles.includes(cycle)) {
    view.cycles.push(cycle);
  }
  return run;
};

const currentIteration = (run: RunView): IterationView | undefined =>
  run.iterations.at(-1);

const applyToRun = (run: RunView, event: RunEvent, at: number): void => {
  const log = (
    kind: LogKind,
    text: string,
    extra?: { iteration?: number; detail?: string },
  ) => pushLog(run, { seq: event.seq, at, kind, text, ...extra });

  switch (event.type) {
    case "runStarted": {
      const where = event.branch ? ` on ${event.branch}` : "";
      log(
        "lifecycle",
        `Run started: ${event.agent}${event.model ? ` (${event.model})` : ""} in ${event.sandbox}${where}`,
      );
      return;
    }
    case "worktreeReady": {
      run.worktreePath = event.path;
      run.branch ??= event.branch;
      run.setup.push({
        kind: "worktree",
        label: event.branch,
        detail: event.path,
        start: at,
        end: at,
        ok: true,
        reused: event.reused,
      });
      log(
        "lifecycle",
        `Worktree ${event.reused ? "reused" : "ready"}: ${event.branch}`,
        { detail: event.path },
      );
      return;
    }
    case "copyToWorktreeStarted": {
      run.setup.push({
        kind: "copy",
        label: "copy to worktree",
        detail: event.paths.join(", "),
        start: at,
      });
      log("lifecycle", "Copying into worktree", {
        detail: event.paths.join(", "),
      });
      return;
    }
    case "copyToWorktreeFinished": {
      const step = openStep(run, "copy", "copy to worktree");
      if (step) {
        step.end = at;
        step.durationMs = event.durationMs;
        step.ok = true;
      }
      log("lifecycle", `Copied into worktree in ${event.durationMs}ms`);
      return;
    }
    case "sandboxStarting": {
      run.setup.push({ kind: "sandbox", label: event.provider, start: at });
      log("lifecycle", `Starting ${event.provider} sandbox`);
      return;
    }
    case "sandboxReady": {
      const step = openStep(run, "sandbox", event.provider);
      if (step) {
        step.end = at;
        step.durationMs = event.durationMs;
        step.ok = true;
        step.reused = event.reused;
      } else {
        run.setup.push({
          kind: "sandbox",
          label: event.provider,
          start: at,
          end: at,
          durationMs: event.durationMs,
          ok: true,
          reused: event.reused,
        });
      }
      if (run.iteration === 0) setState(run, "setup", at);
      log(
        "lifecycle",
        `Sandbox ${event.reused ? "reused" : "ready"}: ${event.provider}${
          event.durationMs !== undefined ? ` in ${event.durationMs}ms` : ""
        }`,
      );
      return;
    }
    case "hookStarted": {
      run.setup.push({
        kind: "hook",
        label: event.hook,
        detail: event.command,
        start: at,
      });
      if (run.iteration === 0) setState(run, "setup", at);
      log("lifecycle", `Hook ${event.hook} (${event.where})`, {
        detail: event.command,
      });
      return;
    }
    case "hookFinished": {
      const step = openStep(run, "hook", event.hook);
      if (step) {
        step.end = at;
        step.durationMs = event.durationMs;
        step.ok = event.ok;
      }
      log(
        event.ok ? "lifecycle" : "error",
        `Hook ${event.hook} ${event.ok ? "finished" : "failed"} in ${event.durationMs}ms`,
        { detail: event.command },
      );
      return;
    }
    case "iterationStarted": {
      run.iteration = event.iteration;
      run.idle = undefined;
      run.iterations.push({
        iteration: event.iteration,
        start: at,
        toolCalls: 0,
        commits: 0,
      });
      setState(run, "working", at);
      log("lifecycle", `Iteration ${event.iteration} of ${run.maxIterations}`, {
        iteration: event.iteration,
      });
      return;
    }
    case "agentStarted": {
      run.lastOutputAt = at;
      setState(run, "working", at);
      return;
    }
    case "agentText": {
      run.idle = undefined;
      run.lastOutputAt = at;
      setState(run, "working", at);
      const text = truncate(event.message, MAX_TEXT_CHARS);
      run.lastActivity = { kind: "text", text: firstLine(text), at };
      log("text", text, { iteration: event.iteration });
      return;
    }
    case "toolCall": {
      run.idle = undefined;
      run.lastOutputAt = at;
      setState(run, "working", at);
      run.toolCalls++;
      const it = currentIteration(run);
      if (it) it.toolCalls++;
      run.lastActivity = {
        kind: "tool",
        text: `${event.name} ${firstLine(event.formattedArgs)}`.trim(),
        at,
      };
      log("tool", event.name, {
        iteration: event.iteration,
        detail: truncate(event.formattedArgs, MAX_TEXT_CHARS),
      });
      return;
    }
    case "idleWarning": {
      run.idle = {
        minutes: event.idleMinutes,
        timeoutSeconds: event.idleTimeoutSeconds,
        at,
        silentSince: run.lastOutputAt ?? at - event.idleMinutes * 60_000,
      };
      setState(run, "quiet", at);
      log(
        "warn",
        `Agent quiet for ${event.idleMinutes}m (idle timeout ${Math.round(event.idleTimeoutSeconds / 60)}m)`,
        { iteration: event.iteration },
      );
      return;
    }
    case "completionSignal": {
      run.completionSignal = event.signal;
      setState(run, "finishing", at);
      log("lifecycle", `Completion signal: ${event.signal}`, {
        iteration: event.iteration,
      });
      return;
    }
    case "hangingProcess": {
      log(
        "warn",
        `Agent signalled completion but did not exit within ${event.completionTimeoutSeconds}s`,
        { iteration: event.iteration },
      );
      return;
    }
    case "agentStopped": {
      setState(run, "finishing", at);
      return;
    }
    case "commit": {
      run.commits.push({ sha: event.sha, iteration: event.iteration, at });
      const it = currentIteration(run);
      if (it) it.commits++;
      log("commit", `Commit ${event.sha.slice(0, 7)}`, {
        iteration: event.iteration,
        detail: event.sha,
      });
      return;
    }
    case "iterationFinished": {
      const it = run.iterations.find((i) => i.iteration === event.iteration);
      if (it) {
        it.end = at;
        it.usage = event.usage;
        it.agentSessionId = event.agentSessionId;
      }
      if (event.usage) {
        run.usage = addUsage(run.usage, event.usage);
      }
      setState(run, "finishing", at);
      log(
        "lifecycle",
        `Iteration ${event.iteration} finished: ${event.commits} commit${event.commits === 1 ? "" : "s"}`,
        { iteration: event.iteration },
      );
      return;
    }
    case "structuredOutput": {
      run.structuredOutput = { tag: event.tag, value: event.value };
      let json: string;
      try {
        json = JSON.stringify(event.value, null, 2);
      } catch {
        json = String(event.value);
      }
      log("output", `<${event.tag}> output`, {
        detail: truncate(json, MAX_TEXT_CHARS),
      });
      return;
    }
    case "runFinished": {
      run.branch = event.branch;
      run.completionSignal ??= event.completionSignal;
      run.preservedWorktreePath = event.preservedWorktreePath;
      run.idle = undefined;
      setState(run, "done", at);
      log(
        "lifecycle",
        `Run finished: ${event.iterations} iteration${event.iterations === 1 ? "" : "s"}, ${event.commits} commit${event.commits === 1 ? "" : "s"}`,
        event.preservedWorktreePath
          ? { detail: `Worktree preserved at ${event.preservedWorktreePath}` }
          : undefined,
      );
      return;
    }
    case "runFailed": {
      run.error = {
        tag: event.errorTag,
        message: event.message,
        aborted: event.aborted,
      };
      run.idle = undefined;
      setState(run, "failed", at);
      log(
        "error",
        event.aborted
          ? "Run aborted"
          : `Run failed${event.errorTag ? `: ${event.errorTag}` : ""}`,
        { detail: event.message },
      );
      return;
    }
  }
};

/**
 * Mark non-terminal runs whose process has exited as `lost`. `isAlive` returns
 * `undefined` when liveness is unknown (no pid, or the observer cannot check),
 * in which case the run is left alone. Returns true if anything changed.
 */
export const applyLiveness = (
  view: SessionView,
  isAlive: (pid: number) => boolean | undefined,
  now: number = Date.now(),
): boolean => {
  let changed = false;
  for (const run of view.runs.values()) {
    if (run.pid === undefined) continue;
    if (run.state === "done" || run.state === "failed") continue;
    const alive = isAlive(run.pid);
    if (alive === false && run.state !== "lost") {
      run.idle = undefined;
      // The process died some time after its last event; that is the best end estimate.
      setState(run, "lost", run.lastEventAt);
      pushLog(run, {
        seq: view.lastSeq,
        at: now,
        kind: "error",
        text: "Process exited without finishing the run",
        detail: `pid ${run.pid}`,
      });
      run.rev++;
      changed = true;
    }
  }
  if (changed) {
    view.rev++;
    recomputeTotals(view);
  }
  return changed;
};

/** Fold a whole event list into a fresh view. */
export const projectSession = (events: Iterable<RunEvent>): SessionView => {
  const view = createSessionView();
  for (const e of events) applyEvent(view, e);
  return view;
};

/** Runs in a station, optionally filtered to one cycle. */
export const stationRuns = (
  view: SessionView,
  station: StationView,
  cycle?: string,
): RunView[] =>
  station.runIds
    .map((id) => view.runs.get(id)!)
    .filter((r) => cycle === undefined || r.cycle === cycle);

/** Display title for a run: `name`, else agent; followed by the `issue` label when set. */
export const runTitle = (run: RunView): string => {
  const base = run.name ?? run.agent;
  return run.issue !== undefined ? `${base} ${run.issue}` : base;
};
