/**
 * Synthetic run session for `sandcastle dashboard --demo`: a believable replay
 * of the `parallel-planner-with-review` template — a planner, four parallel
 * implement → review pipelines (one goes quiet and recovers, one times out,
 * one hangs after signalling completion) and a merger — looping cycle after
 * cycle.
 *
 * {@link demoScript} is pure and deterministic for a given seed; it describes
 * one cycle as offsets from the cycle's start. {@link startDemoPlayer} plays
 * cycles on timers, stamps the envelope and fans events out to subscribers.
 */

import {
  RUN_EVENT_SCHEMA_VERSION,
  type RunEvent,
  type RunEventPayload,
  type RunEventUsage,
} from "../RunEvents.js";
import { DEMO_SESSION_ID } from "./protocol.js";

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/** One event in a demo cycle, positioned relative to the cycle's start. */
export interface DemoScriptEntry {
  /** Offset from the start of the cycle, in ms at speed 1. */
  readonly atMs: number;
  readonly runId: string;
  readonly payload: RunEventPayload;
}

export interface DemoScriptOptions {
  /** PRNG seed. The same seed and cycle always produce the same script. */
  readonly seed?: number;
  /** Cycle number stamped on every run's labels. Default `1`. */
  readonly cycle?: number;
  /** Pid stamped on `runStarted`. Default `process.pid`. */
  readonly pid?: number;
  /** `hostRepoDir` stamped on `runStarted`. */
  readonly hostRepoDir?: string;
}

const DEFAULT_HOST_REPO_DIR = "/home/dev/acme-api";
const COMPLETE = "<promise>COMPLETE</promise>";
const IDLE_TIMEOUT_SECONDS = 600;
const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-6";

/** mulberry32: tiny, fast, good enough for shaping a demo. */
const createRng = (seed: number) => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const hex = (len: number): string => {
    let s = "";
    while (s.length < len) s += int(0, 15).toString(16);
    return s;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { next, int, pick, hex, shuffle };
};

type Rng = ReturnType<typeof createRng>;

interface DemoIssue {
  readonly id: string;
  readonly title: string;
  /** Source files the implementer reads and edits. */
  readonly files: readonly string[];
  readonly test: string;
  readonly symbol: string;
  /** What the agent says while working, in order. */
  readonly narrative: readonly string[];
}

const ISSUE_POOL: readonly DemoIssue[] = [
  {
    id: "118",
    title: "Retry flaky webhook delivery",
    files: ["src/webhooks/deliver.ts", "src/webhooks/queue.ts"],
    test: "src/webhooks/deliver.test.ts",
    symbol: "deliverWebhook",
    narrative: [
      "Webhook delivery currently fires once and logs on failure. I'll add exponential backoff with jitter, capped at 5 attempts.",
      "Writing a failing test first: a 503 followed by a 200 should result in one successful delivery.",
      "The test fails as expected. Implementing `withRetry` around the fetch call.",
      "Tests pass. Making sure 4xx responses (other than 429) are not retried.",
    ],
  },
  {
    id: "121",
    title: "Add rate limiting to the public API",
    files: ["src/api/middleware.ts", "src/api/rateLimit.ts"],
    test: "src/api/rateLimit.test.ts",
    symbol: "rateLimit",
    narrative: [
      "No rate limiting exists yet. I'll add a token-bucket middleware keyed by API key, falling back to client IP.",
      "RED: requests beyond the bucket size should get a 429 with a Retry-After header.",
      "Implementing the bucket with a monotonic clock so tests can fake time.",
      "All green. Wiring the middleware into the public router only, not the internal one.",
    ],
  },
  {
    id: "124",
    title: "Paginate the audit log endpoint",
    files: ["src/routes/audit.ts", "src/db/auditLog.ts"],
    test: "src/routes/audit.test.ts",
    symbol: "listAuditEvents",
    narrative: [
      "GET /audit returns every row. I'll switch it to cursor pagination on (created_at, id).",
      "Adding a test that walks three pages and checks no row is returned twice.",
      "The query needs a composite index; adding a migration alongside the change.",
      "Pagination works. Keeping `?limit` bounded to 200.",
    ],
  },
  {
    id: "127",
    title: "Fix timezone drift in billing reports",
    files: ["src/billing/reportPeriod.ts", "src/billing/invoice.ts"],
    test: "src/billing/reportPeriod.test.ts",
    symbol: "reportPeriod",
    narrative: [
      "Report periods are computed in the server's local time, so customers in UTC-8 lose their last evening of the month.",
      "Reproducing with a fixed clock at 2026-03-31T23:30:00-08:00.",
      "Computing period boundaries in the account's timezone instead of the host's.",
      "Fixed. Also covered the DST transition week.",
    ],
  },
  {
    id: "131",
    title: "Move session store to Redis",
    files: ["src/session/store.ts", "src/session/memoryStore.ts"],
    test: "src/session/store.test.ts",
    symbol: "SessionStore",
    narrative: [
      "Sessions live in process memory, which breaks with more than one replica. Introducing a `SessionStore` interface first.",
      "Keeping the memory store for tests and adding a Redis implementation behind the same interface.",
      "TTL handling differs between the two; normalising on seconds.",
      "Both stores pass the shared contract tests.",
    ],
  },
  {
    id: "133",
    title: "Debounce search-as-you-type requests",
    files: ["src/ui/search/useSearch.ts", "src/ui/search/SearchBox.tsx"],
    test: "src/ui/search/useSearch.test.ts",
    symbol: "useSearch",
    narrative: [
      "Every keystroke triggers a request. I'll debounce at 200ms and cancel in-flight requests with AbortController.",
      "Test: typing five characters quickly should produce a single request.",
      "Using fake timers to drive the debounce in tests.",
      "Done; stale responses can no longer overwrite newer results.",
    ],
  },
  {
    id: "136",
    title: "Validate CSV import headers",
    files: ["src/import/csv.ts", "src/import/schema.ts"],
    test: "src/import/csv.test.ts",
    symbol: "parseCsvImport",
    narrative: [
      "Imports with a missing `email` column fail deep inside the row loop. Validating headers up front instead.",
      "RED: a file without `email` should fail with a message listing the missing columns.",
      "Header matching is now case-insensitive and trims whitespace.",
      "Green. The error lists every missing column at once rather than the first.",
    ],
  },
  {
    id: "140",
    title: "Surface S3 upload errors to the user",
    files: ["src/uploads/s3.ts", "src/uploads/UploadButton.tsx"],
    test: "src/uploads/s3.test.ts",
    symbol: "uploadToS3",
    narrative: [
      "Upload failures are swallowed and the spinner never stops. Propagating the error to the button state.",
      "Adding a test that a 403 from S3 surfaces 'Upload not permitted'.",
      "Mapping the common S3 error codes to user-facing messages.",
      "Tests pass; the spinner resets on failure too.",
    ],
  },
];

/** How a pipeline behaves in the demo, so every UI state shows up each cycle. */
type PipelineRole = "clean" | "quiet" | "failed" | "hanging";
const ROLES: readonly PipelineRole[] = ["clean", "quiet", "failed", "hanging"];

const branchFor = (issue: DemoIssue): string => `sandcastle/issue-${issue.id}`;

/** Appends entries for one run, advancing its own clock. */
class RunTrack {
  t: number;
  constructor(
    private readonly out: DemoScriptEntry[],
    readonly runId: string,
    start: number,
  ) {
    this.t = start;
  }
  emit(afterMs: number, payload: RunEventPayload): void {
    this.t += afterMs;
    this.out.push({ atMs: Math.round(this.t), runId: this.runId, payload });
  }
}

const usageFor = (rng: Rng, scale: number): RunEventUsage => ({
  inputTokens: rng.int(800, 4000),
  cacheCreationInputTokens: Math.round(rng.int(18_000, 42_000) * scale),
  cacheReadInputTokens: Math.round(rng.int(200_000, 900_000) * scale),
  outputTokens: Math.round(rng.int(3_000, 14_000) * scale),
});

/**
 * Build one cycle of the demo session: planner → four parallel
 * implement/review pipelines → merger. Entries are sorted by `atMs`; entries
 * with equal offsets keep emission order.
 */
export const demoScript = (
  options: DemoScriptOptions = {},
): DemoScriptEntry[] => {
  const cycle = options.cycle ?? 1;
  const rng = createRng((options.seed ?? 42) * 7919 + cycle);
  const pid = options.pid ?? process.pid;
  const hostRepoDir = options.hostRepoDir ?? DEFAULT_HOST_REPO_DIR;
  const out: DemoScriptEntry[] = [];
  const newRunId = () => `run_${rng.hex(12)}`;

  const issues = rng.shuffle(ISSUE_POOL).slice(0, 4);
  const roles = rng.shuffle(ROLES);

  const started = (
    name: string,
    labels: Record<string, string | number>,
    model: string,
    extra: { branchStrategy: string; branch?: string; maxIterations: number },
  ): RunEventPayload => ({
    type: "runStarted",
    name,
    labels,
    agent: "claude-code",
    model,
    sandbox: "docker",
    hostRepoDir,
    pid,
    ...extra,
  });

  /** Fresh docker sandbox + `npm install` hook. */
  const provision = (track: RunTrack, slowInstall = false): void => {
    track.emit(rng.int(150, 400), {
      type: "sandboxStarting",
      provider: "docker",
    });
    const boot = rng.int(2_500, 4_500);
    track.emit(boot, {
      type: "sandboxReady",
      provider: "docker",
      reused: false,
      durationMs: boot,
    });
    track.emit(rng.int(100, 300), {
      type: "hookStarted",
      hook: "onSandboxReady",
      where: "sandbox",
      command: "npm install",
    });
    const install = slowInstall
      ? rng.int(8_000, 11_000)
      : rng.int(4_500, 7_000);
    track.emit(install, {
      type: "hookFinished",
      hook: "onSandboxReady",
      where: "sandbox",
      command: "npm install",
      durationMs: install,
      ok: true,
    });
  };

  const text = (
    track: RunTrack,
    iteration: number,
    message: string,
    gap: [number, number] = [1_500, 4_000],
  ) => track.emit(rng.int(...gap), { type: "agentText", iteration, message });

  const tool = (
    track: RunTrack,
    iteration: number,
    name: string,
    formattedArgs: string,
    gap: [number, number] = [1_200, 4_500],
  ) =>
    track.emit(rng.int(...gap), {
      type: "toolCall",
      iteration,
      name,
      formattedArgs,
    });

  const finishIteration = (
    track: RunTrack,
    iteration: number,
    commits: number,
    usageScale: number,
    signal?: string,
  ): void => {
    if (signal) {
      track.emit(rng.int(800, 2_000), {
        type: "completionSignal",
        iteration,
        signal,
      });
    }
    track.emit(rng.int(300, 900), { type: "agentStopped", iteration });
    for (let c = 0; c < commits; c++) {
      track.emit(rng.int(80, 250), {
        type: "commit",
        iteration,
        sha: rng.hex(40),
      });
    }
    track.emit(rng.int(100, 300), {
      type: "iterationFinished",
      iteration,
      agentSessionId: `${rng.hex(8)}-${rng.hex(4)}-${rng.hex(4)}-${rng.hex(4)}-${rng.hex(12)}`,
      usage: usageFor(rng, usageScale),
      commits,
    });
  };

  // --- Phase 1: plan ---------------------------------------------------------
  const planner = new RunTrack(out, newRunId(), 0);
  planner.emit(
    0,
    started("planner", { phase: "plan", cycle }, OPUS, {
      branchStrategy: "head",
      branch: "main",
      maxIterations: 1,
    }),
  );
  provision(planner);
  planner.emit(rng.int(200, 500), { type: "iterationStarted", iteration: 1 });
  planner.emit(rng.int(300, 800), { type: "agentStarted", iteration: 1 });
  text(
    planner,
    1,
    "I'll start by listing the open issues and reading each one to map out dependencies.",
  );
  tool(
    planner,
    1,
    "Bash",
    "gh issue list --state open --json number,title,labels --limit 50",
  );
  for (const issue of issues.slice(0, 3)) {
    tool(
      planner,
      1,
      "Bash",
      `gh issue view ${issue.id} --json body,comments`,
      [900, 2_500],
    );
  }
  tool(planner, 1, "Grep", `"${issues[0]!.symbol}" src/`);
  tool(planner, 1, "Read", issues[1]!.files[0]!);
  text(
    planner,
    1,
    `Building the dependency graph. #${issues[2]!.id} and #${issues[3]!.id} touch separate modules, and none of the four depends on another open issue, so they can run in parallel.`,
    [4_000, 7_000],
  );
  tool(planner, 1, "Read", "package.json");
  const plan = {
    issues: issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      branch: branchFor(issue),
    })),
  };
  text(planner, 1, `<plan>\n${JSON.stringify(plan)}\n</plan>`, [3_000, 5_000]);
  finishIteration(planner, 1, 0, 0.6);
  planner.emit(rng.int(200, 600), {
    type: "structuredOutput",
    tag: "plan",
    value: plan,
  });
  planner.emit(rng.int(50, 150), {
    type: "runFinished",
    iterations: 1,
    commits: 0,
    branch: "main",
  });

  // --- Phase 2: implement + review, in parallel --------------------------------
  const pipelinesStart = planner.t + rng.int(800, 1_500);
  const merged: DemoIssue[] = [];
  let latestPipelineEnd = pipelinesStart;

  issues.forEach((issue, index) => {
    const role = roles[index]!;
    const branch = branchFor(issue);
    const impl = new RunTrack(
      out,
      newRunId(),
      pipelinesStart + index * rng.int(1_500, 4_000),
    );
    impl.emit(
      0,
      started(
        "implementer",
        { phase: "implement", cycle, issue: issue.id },
        SONNET,
        {
          branchStrategy: "branch",
          branch,
          maxIterations: 100,
        },
      ),
    );
    impl.emit(rng.int(200, 600), {
      type: "worktreeReady",
      path: `${hostRepoDir}/.sandcastle/worktrees/sandcastle-issue-${issue.id}`,
      branch,
      reused: false,
    });
    if (index === 0) {
      impl.emit(rng.int(50, 150), {
        type: "copyToWorktreeStarted",
        paths: ["node_modules"],
      });
      const copy = rng.int(1_800, 3_200);
      impl.emit(copy, { type: "copyToWorktreeFinished", durationMs: copy });
    }
    provision(impl, index === 2);

    const [srcA, srcB] = issue.files;
    const iterations = role === "failed" ? 1 : role === "clean" ? 3 : 2;
    let commits = 0;
    let failed = false;

    for (let it = 1; it <= iterations; it++) {
      impl.emit(rng.int(200, 600), { type: "iterationStarted", iteration: it });
      impl.emit(rng.int(300, 900), { type: "agentStarted", iteration: it });
      const last = it === iterations;
      if (it === 1) {
        tool(impl, it, "Bash", `gh issue view ${issue.id}`);
        text(impl, it, issue.narrative[0]!);
        tool(impl, it, "Read", srcA!);
        tool(impl, it, "Grep", `"${issue.symbol}" src/ --files-with-matches`);
        tool(impl, it, "Read", issue.test);
        if (role === "quiet") {
          // Long silent think, trips the idle warning, then picks back up.
          impl.emit(rng.int(18_000, 24_000), {
            type: "idleWarning",
            iteration: it,
            idleMinutes: 1,
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          });
          text(
            impl,
            it,
            "Back on track: the existing helper already handles the edge case I was worried about, so the change is smaller than expected.",
            [9_000, 13_000],
          );
        }
        if (role === "failed") {
          tool(impl, it, "Bash", "npm test -- --watch=false", [2_000, 3_000]);
          impl.emit(rng.int(20_000, 26_000), {
            type: "idleWarning",
            iteration: it,
            idleMinutes: 1,
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          });
          impl.emit(rng.int(9_000, 12_000), {
            type: "idleWarning",
            iteration: it,
            idleMinutes: 2,
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          });
          impl.emit(rng.int(9_000, 12_000), {
            type: "agentStopped",
            iteration: it,
          });
          impl.emit(rng.int(200, 500), {
            type: "runFailed",
            errorTag: "AgentIdleTimeoutError",
            message: `Agent idle for ${IDLE_TIMEOUT_SECONDS} seconds — no output received. Consider increasing the idle timeout with --idle-timeout.`,
            aborted: false,
          });
          failed = true;
          break;
        }
        text(impl, it, issue.narrative[1]!);
        tool(impl, it, "Edit", issue.test);
        tool(impl, it, "Bash", `npx vitest run ${issue.test}`, [2_000, 5_000]);
        text(impl, it, issue.narrative[2]!);
        tool(impl, it, "Edit", srcA!);
        tool(impl, it, "Edit", srcB!);
        tool(impl, it, "Bash", `npx vitest run ${issue.test}`, [3_000, 6_000]);
        tool(impl, it, "Bash", "npm run typecheck", [3_000, 6_000]);
        tool(
          impl,
          it,
          "Bash",
          `git add -A && git commit -m "RALPH: #${issue.id} ${issue.title.toLowerCase()}"`,
        );
      } else {
        tool(impl, it, "Bash", "git log -n 3 --oneline");
        text(impl, it, issue.narrative[3]!);
        tool(impl, it, "Read", srcB!);
        tool(impl, it, "Edit", srcB!);
        tool(impl, it, "Bash", "npm test", [4_000, 8_000]);
        tool(
          impl,
          it,
          "Bash",
          `git commit -am "RALPH: #${issue.id} cover edge cases"`,
        );
        if (last) {
          tool(
            impl,
            it,
            "Bash",
            `gh issue comment ${issue.id} --body "Implemented on ${branch}; tests pass."`,
          );
          text(impl, it, COMPLETE, [1_000, 2_000]);
        }
      }
      if (last && role === "hanging") {
        impl.emit(rng.int(800, 1_500), {
          type: "completionSignal",
          iteration: it,
          signal: COMPLETE,
        });
        // Agent process stays alive after signalling; the completion timeout kicks in.
        impl.emit(rng.int(9_000, 12_000), {
          type: "hangingProcess",
          iteration: it,
          completionTimeoutSeconds: 10,
        });
        impl.emit(rng.int(300, 800), { type: "agentStopped", iteration: it });
        impl.emit(rng.int(100, 300), {
          type: "commit",
          iteration: it,
          sha: rng.hex(40),
        });
        impl.emit(rng.int(100, 300), {
          type: "iterationFinished",
          iteration: it,
          usage: usageFor(rng, 1),
          commits: 1,
        });
        commits += 1;
      } else {
        finishIteration(impl, it, 1, 1, last ? COMPLETE : undefined);
        commits += 1;
      }
    }

    if (failed) {
      latestPipelineEnd = Math.max(latestPipelineEnd, impl.t);
      return;
    }
    impl.emit(rng.int(200, 600), {
      type: "runFinished",
      iterations,
      commits,
      branch,
      completionSignal: COMPLETE,
    });

    // Reviewer: same sandbox, same branch.
    const review = new RunTrack(out, newRunId(), impl.t + rng.int(400, 1_200));
    review.emit(
      0,
      started("reviewer", { phase: "review", cycle, issue: issue.id }, SONNET, {
        branchStrategy: "branch",
        branch,
        maxIterations: 1,
      }),
    );
    review.emit(rng.int(50, 150), {
      type: "worktreeReady",
      path: `${hostRepoDir}/.sandcastle/worktrees/sandcastle-issue-${issue.id}`,
      branch,
      reused: true,
    });
    review.emit(rng.int(50, 150), {
      type: "sandboxReady",
      provider: "docker",
      reused: true,
    });
    review.emit(rng.int(200, 500), { type: "iterationStarted", iteration: 1 });
    review.emit(rng.int(300, 800), { type: "agentStarted", iteration: 1 });
    tool(review, 1, "Bash", `git diff main...${branch} --stat`);
    text(
      review,
      1,
      `Reviewing ${commits} commit${commits === 1 ? "" : "s"} on ${branch}. Behaviour looks right; a couple of clarity improvements to make.`,
    );
    tool(review, 1, "Read", srcA!);
    text(
      review,
      1,
      `Flattening a nested conditional in \`${issue.symbol}\` and renaming a vague local.`,
    );
    tool(review, 1, "Edit", srcA!);
    tool(review, 1, "Bash", "npm test", [3_000, 6_000]);
    tool(
      review,
      1,
      "Bash",
      `git commit -am "Review: simplify ${issue.symbol}"`,
    );
    text(review, 1, COMPLETE, [800, 1_500]);
    finishIteration(review, 1, 1, 0.5, COMPLETE);
    review.emit(rng.int(200, 500), {
      type: "runFinished",
      iterations: 1,
      commits: 1,
      branch,
      completionSignal: COMPLETE,
    });
    merged.push(issue);
    latestPipelineEnd = Math.max(latestPipelineEnd, review.t);
  });

  // --- Phase 3: merge ----------------------------------------------------------
  const merger = new RunTrack(
    out,
    newRunId(),
    latestPipelineEnd + rng.int(1_000, 2_000),
  );
  merger.emit(
    0,
    started("merger", { phase: "merge", cycle }, SONNET, {
      branchStrategy: "head",
      branch: "main",
      maxIterations: 1,
    }),
  );
  provision(merger);
  merger.emit(rng.int(200, 500), { type: "iterationStarted", iteration: 1 });
  merger.emit(rng.int(300, 800), { type: "agentStarted", iteration: 1 });
  text(
    merger,
    1,
    `Merging ${merged.length} branches into main: ${merged.map(branchFor).join(", ")}.`,
  );
  for (const issue of merged) {
    tool(
      merger,
      1,
      "Bash",
      `git merge ${branchFor(issue)} --no-edit`,
      [1_500, 3_000],
    );
  }
  tool(merger, 1, "Bash", "npm run typecheck && npm run test", [5_000, 8_000]);
  text(
    merger,
    1,
    "All merges clean and the suite is green. Closing the merged issues.",
  );
  for (const issue of merged) {
    tool(
      merger,
      1,
      "Bash",
      `gh issue close ${issue.id} --comment "Merged in cycle ${cycle}"`,
      [600, 1_500],
    );
  }
  text(merger, 1, COMPLETE, [800, 1_500]);
  finishIteration(merger, 1, 1, 0.4, COMPLETE);
  merger.emit(rng.int(200, 500), {
    type: "runFinished",
    iterations: 1,
    commits: 1,
    branch: "main",
    completionSignal: COMPLETE,
  });

  // Stable sort: equal offsets keep emission order.
  return out
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.atMs - b.entry.atMs || a.i - b.i)
    .map(({ entry }) => entry);
};

/** Stamp the envelope on script entries, as if the cycle started at `startTime`. */
export const stampDemoEvents = (
  entries: readonly DemoScriptEntry[],
  options: { readonly startTime: number; readonly firstSeq?: number },
): RunEvent[] => {
  let seq = (options.firstSeq ?? 1) - 1;
  return entries.map(
    (entry) =>
      ({
        ...entry.payload,
        v: RUN_EVENT_SCHEMA_VERSION,
        ts: new Date(options.startTime + entry.atMs).toISOString(),
        sessionId: DEMO_SESSION_ID,
        runId: entry.runId,
        seq: ++seq,
      }) as RunEvent,
  );
};

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface DemoPlayerOptions {
  /** Playback speed multiplier. `2` plays twice as fast. Default `1`. */
  readonly speed?: number;
  readonly seed?: number;
  /** Pid stamped on `runStarted`. Default `process.pid`. */
  readonly pid?: number;
  /** Pause between the merger finishing and the next planner, ms at speed 1. Default 6000. */
  readonly cycleGapMs?: number;
  /** Cycles kept in the backlog for late subscribers; older ones are dropped. Default 2. */
  readonly bufferedCycles?: number;
}

export interface DemoPlayer {
  /** Pid stamped on every demo `runStarted`. */
  readonly pid: number;
  /** Events already emitted (bounded to the last few cycles), in emission order. */
  readonly backlog: () => readonly RunEvent[];
  /** Receive each batch of newly emitted events. Returns an unsubscribe function. */
  readonly subscribe: (
    listener: (events: readonly RunEvent[]) => void,
  ) => () => void;
  /** Stop playback and clear timers. */
  readonly stop: () => void;
}

/**
 * Play demo cycles on timers, forever, until stopped. One player is shared by
 * every client so a late-joining tab sees the backlog. Events are stamped with
 * the wall-clock time they are emitted.
 */
export const startDemoPlayer = (
  options: DemoPlayerOptions = {},
): DemoPlayer => {
  const speed = options.speed ?? 1;
  const scale = (ms: number) =>
    Number.isFinite(speed) && speed > 0 ? ms / speed : 0;
  const pid = options.pid ?? process.pid;
  const seed = options.seed ?? 42;
  const keepCycles = Math.max(1, options.bufferedCycles ?? 2);
  const gapMs = options.cycleGapMs ?? 6_000;

  const cycles: RunEvent[][] = [];
  const listeners = new Set<(events: readonly RunEvent[]) => void>();
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (events: RunEvent[]) => {
    cycles.at(-1)!.push(...events);
    for (const listener of listeners) {
      try {
        listener(events);
      } catch {
        // A broken subscriber must not stop playback.
      }
    }
  };

  const playCycle = (cycle: number) => {
    if (stopped) return;
    const script = demoScript({ seed, cycle, pid });
    cycles.push([]);
    while (cycles.length > keepCycles) cycles.shift();
    const start = Date.now();
    let index = 0;

    const tick = () => {
      if (stopped) return;
      const elapsed = Date.now() - start;
      const due: RunEvent[] = [];
      while (index < script.length && scale(script[index]!.atMs) <= elapsed) {
        const entry = script[index++]!;
        due.push({
          ...entry.payload,
          v: RUN_EVENT_SCHEMA_VERSION,
          ts: new Date().toISOString(),
          sessionId: DEMO_SESSION_ID,
          runId: entry.runId,
          seq: ++seq,
        } as RunEvent);
      }
      if (due.length > 0) publish(due);
      if (index < script.length) {
        timer = setTimeout(
          tick,
          Math.max(0, scale(script[index]!.atMs) - (Date.now() - start)),
        );
      } else {
        timer = setTimeout(() => playCycle(cycle + 1), scale(gapMs));
      }
      timer.unref?.();
    };
    tick();
  };

  playCycle(1);

  return {
    pid,
    backlog: () => cycles.flat(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      listeners.clear();
    },
  };
};
