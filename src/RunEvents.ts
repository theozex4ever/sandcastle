/**
 * Run events: a structured, machine-readable stream of everything a run does —
 * lifecycle (worktree, sandbox, hooks), iterations, agent output, commits —
 * written as NDJSON to `.sandcastle/events/<session>.ndjson` and/or forwarded
 * to a caller callback. The orchestrator dashboard consumes this stream.
 *
 * Emission sites reach the sink through the optional {@link RunEvents} Effect
 * service (`Effect.serviceOption`), so code paths that run outside a run (or in
 * tests) need no extra wiring — emitting without a provided service is a no-op.
 */

import { Cause, Context, Effect, Option, Runtime } from "effect";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Schema version stamped on every event as `v`. Bump on breaking changes. */
export const RUN_EVENT_SCHEMA_VERSION = 1;

/**
 * Free-form key/value tags attached to a run (e.g. `{ phase: "implement",
 * issue: "42", cycle: 1 }`). Carried on `runStarted` so consumers can group
 * runs — Sandcastle itself does not interpret them.
 */
export type RunEventLabels = Readonly<
  Record<string, string | number | boolean>
>;

/** Token usage reported at the end of an iteration. */
export interface RunEventUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

/** Where a hook ran. */
export type RunEventHookLocation = "host" | "sandbox";

/** The event-specific part of a {@link RunEvent}, before the envelope is stamped. */
export type RunEventPayload =
  | {
      readonly type: "runStarted";
      /** Display name passed via `name`. */
      readonly name?: string;
      readonly labels: RunEventLabels;
      /** Agent provider name (e.g. `"claude-code"`). */
      readonly agent: string;
      readonly model?: string;
      /** Sandbox provider name (e.g. `"docker"`). */
      readonly sandbox: string;
      /** Branch strategy type, or `"sandbox"` / `"worktree"` for handle-based runs. */
      readonly branchStrategy: string;
      /** Branch the agent works on, when known up front. */
      readonly branch?: string;
      readonly maxIterations: number;
      readonly hostRepoDir: string;
    }
  | {
      readonly type: "worktreeReady";
      readonly path: string;
      readonly branch: string;
      /** True when the run reuses a worktree created earlier (e.g. `createWorktree`). */
      readonly reused: boolean;
    }
  | {
      readonly type: "copyToWorktreeStarted";
      readonly paths: readonly string[];
    }
  | { readonly type: "copyToWorktreeFinished"; readonly durationMs: number }
  | { readonly type: "sandboxStarting"; readonly provider: string }
  | {
      readonly type: "sandboxReady";
      readonly provider: string;
      /** True when the run reuses a sandbox started earlier (e.g. `createSandbox`). */
      readonly reused: boolean;
      readonly durationMs?: number;
    }
  | {
      readonly type: "hookStarted";
      readonly hook: string;
      readonly where: RunEventHookLocation;
      readonly command: string;
    }
  | {
      readonly type: "hookFinished";
      readonly hook: string;
      readonly where: RunEventHookLocation;
      readonly command: string;
      readonly durationMs: number;
      readonly ok: boolean;
    }
  | { readonly type: "iterationStarted"; readonly iteration: number }
  | { readonly type: "agentStarted"; readonly iteration: number }
  | {
      readonly type: "agentText";
      readonly iteration: number;
      readonly message: string;
    }
  | {
      readonly type: "toolCall";
      readonly iteration: number;
      readonly name: string;
      readonly formattedArgs: string;
    }
  | {
      readonly type: "idleWarning";
      readonly iteration: number;
      /** Minutes since the agent last produced output. */
      readonly idleMinutes: number;
      /** The configured idle timeout, so consumers can show a countdown. */
      readonly idleTimeoutSeconds: number;
    }
  | {
      readonly type: "completionSignal";
      readonly iteration: number;
      readonly signal: string;
    }
  | {
      readonly type: "hangingProcess";
      readonly iteration: number;
      readonly completionTimeoutSeconds: number;
    }
  | { readonly type: "agentStopped"; readonly iteration: number }
  | {
      readonly type: "commit";
      readonly iteration: number;
      readonly sha: string;
    }
  | {
      readonly type: "iterationFinished";
      readonly iteration: number;
      /** The agent's own session id (e.g. Claude Code's), when captured. Distinct from the envelope's `sessionId`. */
      readonly agentSessionId?: string;
      readonly sessionFilePath?: string;
      readonly usage?: RunEventUsage;
      readonly commits: number;
    }
  | {
      readonly type: "structuredOutput";
      readonly tag: string;
      readonly value: unknown;
    }
  | {
      readonly type: "runFinished";
      readonly iterations: number;
      readonly commits: number;
      readonly branch: string;
      readonly completionSignal?: string;
      readonly preservedWorktreePath?: string;
    }
  | {
      readonly type: "runFailed";
      /** Error `_tag` for Sandcastle errors (e.g. `"AgentIdleTimeoutError"`), else the constructor name. */
      readonly errorTag?: string;
      readonly message: string;
      /** True when the run was cancelled via its `AbortSignal`. */
      readonly aborted: boolean;
    };

/** Envelope fields stamped on every event. */
export interface RunEventEnvelope {
  /** Schema version ({@link RUN_EVENT_SCHEMA_VERSION}). */
  readonly v: number;
  /** ISO-8601 timestamp. */
  readonly ts: string;
  /** Groups every run made by one process (one script invocation). */
  readonly sessionId: string;
  /** Unique per `run()` / `sandbox.run()` / `wt.run()` call. */
  readonly runId: string;
  /** Monotonic per-process sequence number; orders events with equal timestamps. */
  readonly seq: number;
}

/**
 * A single structured event in a run's lifecycle. Discriminate on `type`.
 * Written one-per-line to `.sandcastle/events/<sessionId>.ndjson`.
 */
export type RunEvent = RunEventEnvelope & RunEventPayload;

/** Controls where run events go. Pass `false` to disable them entirely. */
export type RunEventsOption =
  | false
  | {
      /**
       * Invoked synchronously for every event. Errors thrown by the callback —
       * and rejections of a returned promise, which is not awaited — are
       * swallowed so a broken forwarder cannot kill the run.
       */
      readonly onEvent?: (event: RunEvent) => unknown;
      /**
       * NDJSON sink. `true` (default) writes to
       * `<cwd>/.sandcastle/events/<sessionId>.ndjson`; a string writes to that
       * path (relative paths resolve against the host repo directory);
       * `false` disables the file. The `SANDCASTLE_EVENTS=0` environment
       * variable also disables the default file.
       */
      readonly file?: boolean | string;
    };

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

let processSessionId: string | undefined;

/**
 * The session id shared by every run in this process. Taken from
 * `SANDCASTLE_SESSION_ID` when set (so a wrapper can group several processes),
 * otherwise generated once: `YYYYMMDD-HHMMSS-<hex>`.
 */
export const getRunEventSessionId = (): string => {
  if (processSessionId) return processSessionId;
  const fromEnv = process.env.SANDCASTLE_SESSION_ID?.trim();
  if (fromEnv) {
    processSessionId = fromEnv;
  } else {
    const iso = new Date().toISOString(); // 2026-10-11T14:02:00.000Z
    const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
    processSessionId = `${stamp}-${randomBytes(3).toString("hex")}`;
  }
  return processSessionId;
};

/** @internal Test-only: forget the cached session id. */
export const _resetRunEventSessionId = (): void => {
  processSessionId = undefined;
};

const newRunId = (): string => `run_${randomBytes(6).toString("hex")}`;

let seqCounter = 0;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** @internal Emits payloads for a single run, stamping the envelope. */
export interface RunEventEmitter {
  readonly runId: string;
  readonly sessionId: string;
  /** Absolute path of the NDJSON file, when the file sink is enabled. */
  readonly filePath?: string;
  readonly emit: (payload: RunEventPayload) => void;
}

const isFileSinkDisabledByEnv = (): boolean => {
  const v = process.env.SANDCASTLE_EVENTS?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
};

/**
 * Drop a `.gitignore` containing `*` into the events directory so event files
 * stay untracked even in repos whose `.sandcastle/.gitignore` predates the
 * `events/` entry — otherwise an agent's `git add .` would commit them.
 */
const ensureSelfIgnoringDir = (dir: string): void => {
  const marker = join(dir, ".gitignore");
  if (!existsSync(marker)) {
    writeFileSync(
      marker,
      "# Created by Sandcastle: run event files are local artifacts.\n*\n",
    );
  }
};

/** @internal Default NDJSON path for a session under a host repo. */
export const defaultRunEventsFilePath = (
  hostRepoDir: string,
  sessionId: string,
): string => join(hostRepoDir, ".sandcastle", "events", `${sessionId}.ndjson`);

/**
 * @internal Build the emitter for one run from the caller's `events` option.
 * Sink failures (I/O errors, throwing callbacks) are swallowed: observability
 * must never break a run.
 */
export const createRunEventEmitter = (args: {
  readonly hostRepoDir: string;
  readonly events?: RunEventsOption;
}): RunEventEmitter => {
  const sessionId = getRunEventSessionId();
  const runId = newRunId();

  if (args.events === false) {
    return { runId, sessionId, emit: () => {} };
  }

  const fileOpt = args.events?.file ?? true;
  let filePath: string | undefined;
  if (typeof fileOpt === "string") {
    filePath = resolve(args.hostRepoDir, fileOpt);
  } else if (fileOpt && !isFileSinkDisabledByEnv()) {
    filePath = defaultRunEventsFilePath(args.hostRepoDir, sessionId);
  }
  const isDefaultPath = typeof fileOpt !== "string";

  let fileReady = false;
  const onEvent = args.events?.onEvent;

  const emit = (payload: RunEventPayload): void => {
    // Envelope fields are spread last so a payload can never shadow them.
    const event = {
      ...payload,
      v: RUN_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      sessionId,
      runId,
      seq: ++seqCounter,
    } as RunEvent;

    if (filePath) {
      try {
        if (!fileReady) {
          mkdirSync(dirname(filePath), { recursive: true });
          if (isDefaultPath) ensureSelfIgnoringDir(dirname(filePath));
          fileReady = true;
        }
        appendFileSync(filePath, JSON.stringify(event) + "\n");
      } catch {
        // Swallow — event I/O must not kill the run.
      }
    }
    if (onEvent) {
      try {
        const returned = onEvent(event);
        if (
          returned !== null &&
          typeof returned === "object" &&
          typeof (returned as PromiseLike<unknown>).then === "function"
        ) {
          // Swallow async failures too — never awaited, never unhandled.
          (returned as PromiseLike<unknown>).then(undefined, () => {});
        }
      } catch {
        // Swallow — a broken forwarder must not kill the run.
      }
    }
  };

  return { runId, sessionId, filePath, emit };
};

/** @internal Describe a run failure for `runFailed`. */
export const describeRunError = (
  error: unknown,
  signal?: AbortSignal,
): Omit<Extract<RunEventPayload, { type: "runFailed" }>, "type"> => {
  const aborted = signal?.aborted ?? false;
  // Errors surfaced through Effect.runPromise arrive wrapped in a FiberFailure;
  // report the underlying failure (e.g. AgentIdleTimeoutError) instead.
  if (Runtime.isFiberFailure(error)) {
    error = Cause.squash(error[Runtime.FiberFailureCauseId]);
  }
  if (error && typeof error === "object") {
    const tag =
      "_tag" in error && typeof error._tag === "string"
        ? error._tag
        : error.constructor?.name;
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : String(error);
    return { errorTag: tag, message, aborted };
  }
  return { message: String(error), aborted };
};

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

/** @internal Effect service carrying the current run's emitter. Optional by design. */
export class RunEvents extends Context.Tag("RunEvents")<
  RunEvents,
  RunEventEmitter
>() {}

const noopEmitter: RunEventEmitter = {
  runId: "",
  sessionId: "",
  emit: () => {},
};

/** @internal Resolve the current run's emitter, or a no-op when none is provided. */
export const currentRunEvents: Effect.Effect<RunEventEmitter> =
  Effect.serviceOption(RunEvents).pipe(
    Effect.map(Option.getOrElse(() => noopEmitter)),
  );

/** @internal Emit a payload to the current run's emitter (no-op outside a run). */
export const emitRunEvent = (payload: RunEventPayload): Effect.Effect<void> =>
  Effect.map(currentRunEvents, (events) => events.emit(payload));

/**
 * @internal Wrap an effect with `hookStarted` / `hookFinished` events.
 * `ok` reflects whether the effect succeeded; failures still propagate.
 */
export const observeHook = <A, E, R>(
  hook: { readonly hook: string; readonly where: RunEventHookLocation },
  command: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(currentRunEvents, (events) => {
    const started = Date.now();
    events.emit({ type: "hookStarted", ...hook, command });
    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          events.emit({
            type: "hookFinished",
            ...hook,
            command,
            durationMs: Date.now() - started,
            ok: exit._tag === "Success",
          }),
        ),
      ),
    );
  });
