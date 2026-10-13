import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_SCHEMA_VERSION,
  type RunEvent,
  type RunEventPayload,
} from "../RunEvents.js";
import { demoScript, stampDemoEvents } from "./demo.js";
import {
  applyEvent,
  applyLiveness,
  createSessionView,
  MAX_LOG_ENTRIES,
  projectSession,
  stationRuns,
  TERMINAL_STATES,
  UNLABELED_PHASE,
  type RunView,
} from "./projection.js";

const T0 = Date.parse("2026-10-11T12:00:00.000Z");

/** Builds events for one session with a shared seq counter and a fake clock. */
const makeSession = () => {
  let seq = 0;
  const event = (runId: string, atSec: number, payload: RunEventPayload) =>
    ({
      ...payload,
      v: RUN_EVENT_SCHEMA_VERSION,
      ts: new Date(T0 + atSec * 1000).toISOString(),
      sessionId: "s1",
      runId,
      seq: ++seq,
    }) as RunEvent;
  return { event };
};

const started = (
  labels: Record<string, string | number> = {},
  extra: Partial<Extract<RunEventPayload, { type: "runStarted" }>> = {},
): RunEventPayload => ({
  type: "runStarted",
  name: "implementer",
  labels,
  agent: "claude-code",
  model: "claude-sonnet-4-6",
  sandbox: "docker",
  branchStrategy: "branch",
  branch: "sandcastle/issue-1",
  maxIterations: 3,
  hostRepoDir: "/repo",
  pid: 1234,
  ...extra,
});

const states = (run: RunView) => run.segments.map((s) => s.state);

describe("projectSession", () => {
  it("measures quiet from the agent's last output, not the warning's minute count", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("r1", 0, started()),
      event("r1", 1, { type: "iterationStarted", iteration: 1 }),
      event("r1", 1, { type: "agentStarted", iteration: 1 }),
      event("r1", 5, { type: "agentText", iteration: 1, message: "thinking" }),
      // Late warning: 1 minute claimed, 90s actually silent.
      event("r1", 95, {
        type: "idleWarning",
        iteration: 1,
        idleMinutes: 1,
        idleTimeoutSeconds: 600,
      }),
    ]);
    const run = view.runs.get("r1")!;
    expect(run.state).toBe("quiet");
    expect(run.idle).toMatchObject({
      minutes: 1,
      timeoutSeconds: 600,
      silentSince: T0 + 5_000,
    });
  });

  it("walks a run through provisioning → setup → working → quiet → working → finishing → done", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("r1", 0, started({ phase: "implement" })),
      event("r1", 1, { type: "sandboxStarting", provider: "docker" }),
      event("r1", 4, {
        type: "sandboxReady",
        provider: "docker",
        reused: false,
        durationMs: 3000,
      }),
      event("r1", 4, {
        type: "hookStarted",
        hook: "onSandboxReady",
        where: "sandbox",
        command: "npm install",
      }),
      event("r1", 10, {
        type: "hookFinished",
        hook: "onSandboxReady",
        where: "sandbox",
        command: "npm install",
        durationMs: 6000,
        ok: true,
      }),
      event("r1", 11, { type: "iterationStarted", iteration: 1 }),
      event("r1", 11, { type: "agentStarted", iteration: 1 }),
      event("r1", 12, {
        type: "agentText",
        iteration: 1,
        message: "Hi\nthere",
      }),
      event("r1", 80, {
        type: "idleWarning",
        iteration: 1,
        idleMinutes: 1,
        idleTimeoutSeconds: 600,
      }),
      event("r1", 90, {
        type: "toolCall",
        iteration: 1,
        name: "Bash",
        formattedArgs: "npm test",
      }),
      event("r1", 95, {
        type: "completionSignal",
        iteration: 1,
        signal: "<promise>COMPLETE</promise>",
      }),
      event("r1", 96, { type: "agentStopped", iteration: 1 }),
      event("r1", 96, { type: "commit", iteration: 1, sha: "a".repeat(40) }),
      event("r1", 97, {
        type: "iterationFinished",
        iteration: 1,
        commits: 1,
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 20,
          cacheReadInputTokens: 30,
          outputTokens: 40,
        },
      }),
      event("r1", 98, {
        type: "runFinished",
        iterations: 1,
        commits: 1,
        branch: "sandcastle/issue-1",
        completionSignal: "<promise>COMPLETE</promise>",
      }),
    ]);

    const run = view.runs.get("r1")!;
    expect(states(run)).toEqual([
      "provisioning",
      "setup",
      "working",
      "quiet",
      "working",
      "finishing",
      "done",
    ]);
    expect(run.state).toBe("done");
    expect(run.endedAt).toBe(T0 + 98_000);
    expect(run.idle).toBeUndefined();
    expect(run.lastActivity).toMatchObject({
      kind: "tool",
      text: "Bash npm test",
    });
    expect(run.completionSignal).toBe("<promise>COMPLETE</promise>");
    // Every segment but the terminal marker is closed.
    expect(run.segments.every((s) => s.end !== undefined)).toBe(true);

    expect(run.setup).toEqual([
      expect.objectContaining({
        kind: "sandbox",
        label: "docker",
        durationMs: 3000,
        ok: true,
        reused: false,
      }),
      expect.objectContaining({
        kind: "hook",
        label: "onSandboxReady",
        detail: "npm install",
        durationMs: 6000,
        ok: true,
        end: T0 + 10_000,
      }),
    ]);

    expect(run.iterations).toEqual([
      expect.objectContaining({ iteration: 1, toolCalls: 1, commits: 1 }),
    ]);
    expect(view.totals).toMatchObject({
      runs: 1,
      done: 1,
      active: 0,
      commits: 1,
      toolCalls: 1,
      usage: {
        inputTokens: 10,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
        outputTokens: 40,
      },
    });
    expect(view.eventCount).toBe(15);
    expect(view.lastSeq).toBe(15);
    expect(view.startedAt).toBe(T0);
    expect(view.lastEventAt).toBe(T0 + 98_000);
  });

  it("records a failed run with its error", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("r1", 0, started()),
      event("r1", 2, {
        type: "hookStarted",
        hook: "onSandboxReady",
        where: "sandbox",
        command: "npm ci",
      }),
      event("r1", 5, {
        type: "hookFinished",
        hook: "onSandboxReady",
        where: "sandbox",
        command: "npm ci",
        durationMs: 3000,
        ok: false,
      }),
      event("r1", 5, {
        type: "runFailed",
        errorTag: "ExecError",
        message: "npm ci exited 1",
        aborted: false,
      }),
    ]);
    const run = view.runs.get("r1")!;
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({
      tag: "ExecError",
      message: "npm ci exited 1",
      aborted: false,
    });
    expect(run.setup[0]).toMatchObject({ kind: "hook", ok: false });
    expect(run.log.at(-1)).toMatchObject({
      kind: "error",
      text: "Run failed: ExecError",
    });
    expect(view.totals).toMatchObject({ failed: 1, active: 0 });
  });

  it("groups runs into phase stations in first-seen order, with cycles", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("plan1", 0, started({ phase: "plan", cycle: 1 })),
      event("impl1", 1, started({ phase: "implement", cycle: 1, issue: "7" })),
      event("impl2", 2, started({ phase: "implement", cycle: 1, issue: "8" })),
      event("loose", 3, started()),
      event("plan2", 4, started({ phase: "plan", cycle: 2 })),
    ]);
    expect(view.stations.map((s) => s.phase)).toEqual([
      "plan",
      "implement",
      UNLABELED_PHASE,
    ]);
    expect(view.stations[0]!.runIds).toEqual(["plan1", "plan2"]);
    expect(view.stations[1]!.runIds).toEqual(["impl1", "impl2"]);
    expect(view.cycles).toEqual(["1", "2"]);
    expect(view.runs.get("impl2")).toMatchObject({ cycle: "1", issue: "8" });
    expect(view.runs.get("loose")!.phase).toBe(UNLABELED_PHASE);
    expect(
      stationRuns(view, view.stations[0]!, "2").map((r) => r.runId),
    ).toEqual(["plan2"]);
    expect(view.runOrder).toEqual([
      "plan1",
      "impl1",
      "impl2",
      "loose",
      "plan2",
    ]);
  });

  it("creates a placeholder run when runStarted is missing", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("orphan", 0, { type: "iterationStarted", iteration: 2 }),
      event("orphan", 1, {
        type: "toolCall",
        iteration: 2,
        name: "Read",
        formattedArgs: "src/a.ts",
      }),
    ]);
    const run = view.runs.get("orphan")!;
    expect(run).toMatchObject({
      agent: "unknown",
      phase: UNLABELED_PHASE,
      state: "working",
      iteration: 2,
      toolCalls: 1,
    });
    expect(run.pid).toBeUndefined();
    expect(view.stations.map((s) => s.phase)).toEqual([UNLABELED_PHASE]);
  });

  it("records copy-to-worktree and reused worktree/sandbox setup steps", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("r1", 0, started()),
      event("r1", 0, {
        type: "worktreeReady",
        path: "/repo/.sandcastle/worktrees/x",
        branch: "sandcastle/issue-1",
        reused: true,
      }),
      event("r1", 1, {
        type: "copyToWorktreeStarted",
        paths: ["node_modules"],
      }),
      event("r1", 3, { type: "copyToWorktreeFinished", durationMs: 2000 }),
      event("r1", 3, {
        type: "sandboxReady",
        provider: "docker",
        reused: true,
      }),
    ]);
    const run = view.runs.get("r1")!;
    expect(run.setup).toEqual([
      expect.objectContaining({ kind: "worktree", reused: true, ok: true }),
      expect.objectContaining({
        kind: "copy",
        detail: "node_modules",
        durationMs: 2000,
        ok: true,
      }),
      expect.objectContaining({ kind: "sandbox", reused: true, ok: true }),
    ]);
    expect(run.worktreePath).toBe("/repo/.sandcastle/worktrees/x");
    expect(run.state).toBe("setup");
  });

  it("caps the log and counts dropped entries", () => {
    const { event } = makeSession();
    const view = createSessionView();
    applyEvent(view, event("r1", 0, started()));
    applyEvent(
      view,
      event("r1", 0, { type: "iterationStarted", iteration: 1 }),
    );
    const extra = 25;
    for (let i = 0; i < MAX_LOG_ENTRIES + extra; i++) {
      applyEvent(
        view,
        event("r1", 1, { type: "agentText", iteration: 1, message: `m${i}` }),
      );
    }
    const run = view.runs.get("r1")!;
    expect(run.log).toHaveLength(MAX_LOG_ENTRIES);
    // runStarted + iterationStarted + texts, minus what fits.
    expect(run.logDropped).toBe(2 + extra);
    expect(run.log.at(-1)!.text).toBe(`m${MAX_LOG_ENTRIES + extra - 1}`);
  });
});

describe("applyLiveness", () => {
  it("marks runs of dead processes lost and recovers on a late event", () => {
    const { event } = makeSession();
    const view = projectSession([
      event("r1", 0, started({}, { pid: 111 })),
      event("r1", 1, { type: "iterationStarted", iteration: 1 }),
      event("done", 0, started({}, { pid: 111 })),
      event("done", 1, {
        type: "runFinished",
        iterations: 1,
        commits: 0,
        branch: "b",
      }),
      event("nopid", 0, started({}, { pid: undefined })),
    ]);

    expect(applyLiveness(view, () => true, T0 + 5_000)).toBe(false);
    const rev = view.rev;
    expect(applyLiveness(view, () => false, T0 + 5_000)).toBe(true);
    expect(view.rev).toBeGreaterThan(rev);

    const run = view.runs.get("r1")!;
    expect(run.state).toBe("lost");
    expect(run.lastLiveState).toBe("working");
    // Ends at its last sign of life, not when the death was noticed.
    expect(run.endedAt).toBe(T0 + 1_000);
    expect(run.log.at(-1)).toMatchObject({ kind: "error", detail: "pid 111" });
    expect(view.runs.get("done")!.state).toBe("done");
    expect(view.runs.get("nopid")!.state).toBe("provisioning");
    expect(view.totals).toMatchObject({ lost: 1, done: 1, active: 1 });

    // Idempotent: already lost.
    expect(applyLiveness(view, () => false, T0 + 6_000)).toBe(false);
    // Unknown liveness leaves it alone.
    expect(applyLiveness(view, () => undefined, T0 + 6_000)).toBe(false);

    // A late event proves the process is alive: back to where it was.
    applyEvent(
      view,
      event("r1", 7, {
        type: "agentText",
        iteration: 1,
        message: "still here",
      }),
    );
    expect(run.state).toBe("working");
    expect(run.endedAt).toBeUndefined();
    expect(states(run)).toEqual(["provisioning", "working", "lost", "working"]);
    expect(view.totals).toMatchObject({ lost: 0, active: 2 });
  });
});

describe("demo session", () => {
  const events = stampDemoEvents(demoScript({ seed: 7, cycle: 1, pid: 99 }), {
    startTime: T0,
  });

  it("is deterministic for a seed", () => {
    const again = stampDemoEvents(demoScript({ seed: 7, cycle: 1, pid: 99 }), {
      startTime: T0,
    });
    expect(again).toEqual(events);
    const other = demoScript({ seed: 8, cycle: 1, pid: 99 });
    expect(other.map((e) => e.runId)).not.toEqual(events.map((e) => e.runId));
  });

  it("emits well-formed, time-ordered events over a few minutes", () => {
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const times = events.map((e) => Date.parse(e.ts));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const durationMin = (times.at(-1)! - times[0]!) / 60_000;
    expect(durationMin).toBeGreaterThan(2);
    expect(durationMin).toBeLessThan(6);
    for (const e of events) {
      expect(e).toMatchObject({
        v: RUN_EVENT_SCHEMA_VERSION,
        sessionId: "demo",
      });
      if (e.type === "runStarted") expect(e.pid).toBe(99);
      if (e.type === "commit") expect(e.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("projects into a full cycle that exercises every state", () => {
    const view = projectSession(events);
    const runs = [...view.runs.values()];

    expect(view.stations.map((s) => s.phase)).toEqual([
      "plan",
      "implement",
      "review",
      "merge",
    ]);
    expect(view.cycles).toEqual(["1"]);
    expect(runs.every((r) => TERMINAL_STATES.has(r.state))).toBe(true);
    expect(runs.filter((r) => r.phase === "implement")).toHaveLength(4);
    // The failed implementer gets no reviewer.
    expect(runs.filter((r) => r.state === "failed")).toHaveLength(1);
    expect(runs.filter((r) => r.phase === "review")).toHaveLength(3);
    expect(runs.find((r) => r.state === "failed")!.error?.tag).toBe(
      "AgentIdleTimeoutError",
    );

    const quietRecovered = runs.find(
      (r) => r.state === "done" && r.segments.some((s) => s.state === "quiet"),
    );
    expect(quietRecovered).toBeDefined();
    expect(
      runs.some((r) => r.log.some((l) => l.text.includes("did not exit"))),
    ).toBe(true);
    expect(runs.some((r) => r.setup.some((s) => s.kind === "copy"))).toBe(true);
    expect(
      runs
        .filter((r) => r.phase === "review")
        .every((r) => r.setup.some((s) => s.kind === "sandbox" && s.reused)),
    ).toBe(true);

    const planner = runs.find((r) => r.phase === "plan")!;
    expect(planner.structuredOutput?.tag).toBe("plan");
    expect(
      (planner.structuredOutput?.value as { issues: unknown[] }).issues,
    ).toHaveLength(4);

    // Implementers overlap in time (parallel pipelines).
    const impls = runs.filter((r) => r.phase === "implement");
    const latestStart = Math.max(...impls.map((r) => r.startedAt));
    const earliestEnd = Math.min(...impls.map((r) => r.endedAt!));
    expect(latestStart).toBeLessThan(earliestEnd);

    // The merger starts after every reviewer has finished.
    const merger = view.runs.get(view.stations[3]!.runIds[0]!)!;
    for (const r of runs.filter((r) => r.phase === "review")) {
      expect(merger.startedAt).toBeGreaterThan(r.endedAt!);
    }
    expect(view.totals.commits).toBeGreaterThan(5);
    expect(view.totals.usage.outputTokens).toBeGreaterThan(0);
  });

  it("gives every cycle fresh run ids", () => {
    const c1 = new Set(demoScript({ seed: 7, cycle: 1 }).map((e) => e.runId));
    const c2 = demoScript({ seed: 7, cycle: 2 });
    expect(c2.some((e) => c1.has(e.runId))).toBe(false);
    const planner = c2.find((e) => e.payload.type === "runStarted")!;
    expect(planner.payload).toMatchObject({
      labels: { phase: "plan", cycle: 2 },
    });
  });
});
