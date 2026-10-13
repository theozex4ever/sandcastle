import { Effect } from "effect";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProvider, ParsedStreamEvent } from "./AgentProvider.js";
import { run } from "./run.js";
import {
  _resetRunEventSessionId,
  createRunEventEmitter,
  defaultRunEventsFilePath,
  describeRunError,
  emitRunEvent,
  getRunEventSessionId,
  observeHook,
  RunEvents,
  type RunEvent,
} from "./RunEvents.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const readNdjson = (path: string): RunEvent[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);

describe("createRunEventEmitter", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.SANDCASTLE_EVENTS;
    delete process.env.SANDCASTLE_SESSION_ID;
    _resetRunEventSessionId();
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    _resetRunEventSessionId();
  });

  it("stamps the envelope and writes NDJSON to the default session file", () => {
    const dir = tempDir("run-events-");
    const emitter = createRunEventEmitter({ hostRepoDir: dir });
    emitter.emit({ type: "iterationStarted", iteration: 1 });
    emitter.emit({ type: "agentStarted", iteration: 1 });

    expect(emitter.filePath).toBe(
      defaultRunEventsFilePath(dir, emitter.sessionId),
    );
    const events = readNdjson(emitter.filePath!);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      v: 1,
      type: "iterationStarted",
      iteration: 1,
      runId: emitter.runId,
      sessionId: emitter.sessionId,
    });
    expect(Date.parse(events[0]!.ts)).not.toBeNaN();
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
  });

  it("gives each emitter its own runId but shares the process session id", () => {
    const dir = tempDir("run-events-");
    const a = createRunEventEmitter({
      hostRepoDir: dir,
      events: { file: false },
    });
    const b = createRunEventEmitter({
      hostRepoDir: dir,
      events: { file: false },
    });
    expect(a.runId).not.toBe(b.runId);
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.sessionId).toBe(getRunEventSessionId());
  });

  it("takes the session id from SANDCASTLE_SESSION_ID", () => {
    process.env.SANDCASTLE_SESSION_ID = "nightly-42";
    expect(getRunEventSessionId()).toBe("nightly-42");
  });

  it("forwards events to onEvent and swallows callback errors", () => {
    const dir = tempDir("run-events-");
    const seen: RunEvent[] = [];
    const emitter = createRunEventEmitter({
      hostRepoDir: dir,
      events: {
        file: false,
        onEvent: (e) => {
          seen.push(e);
          throw new Error("broken forwarder");
        },
      },
    });
    expect(() =>
      emitter.emit({ type: "agentStopped", iteration: 3 }),
    ).not.toThrow();
    expect(seen.map((e) => e.type)).toEqual(["agentStopped"]);
    expect(emitter.filePath).toBeUndefined();
  });

  it("resolves a custom file path against the host repo directory", () => {
    const dir = tempDir("run-events-");
    const emitter = createRunEventEmitter({
      hostRepoDir: dir,
      events: { file: "out/events.ndjson" },
    });
    emitter.emit({ type: "iterationStarted", iteration: 1 });
    expect(emitter.filePath).toBe(join(dir, "out", "events.ndjson"));
    expect(readNdjson(emitter.filePath!)).toHaveLength(1);
  });

  it("writes nothing when events is false", () => {
    const dir = tempDir("run-events-");
    const seen: RunEvent[] = [];
    const emitter = createRunEventEmitter({ hostRepoDir: dir, events: false });
    emitter.emit({ type: "iterationStarted", iteration: 1 });
    expect(emitter.filePath).toBeUndefined();
    expect(existsSync(join(dir, ".sandcastle", "events"))).toBe(false);
    expect(seen).toEqual([]);
  });

  it("SANDCASTLE_EVENTS=0 disables the default file but keeps onEvent", () => {
    process.env.SANDCASTLE_EVENTS = "0";
    const dir = tempDir("run-events-");
    const seen: RunEvent[] = [];
    const emitter = createRunEventEmitter({
      hostRepoDir: dir,
      events: { onEvent: (e) => seen.push(e) },
    });
    emitter.emit({ type: "iterationStarted", iteration: 1 });
    expect(emitter.filePath).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

describe("RunEvents service", () => {
  it("emitRunEvent is a no-op when no service is provided", async () => {
    await expect(
      Effect.runPromise(
        emitRunEvent({ type: "iterationStarted", iteration: 1 }),
      ),
    ).resolves.toBeUndefined();
  });

  it("observeHook brackets an effect with hookStarted/hookFinished", async () => {
    const seen: RunEvent[] = [];
    const emitter = createRunEventEmitter({
      hostRepoDir: tempDir("run-events-"),
      events: { file: false, onEvent: (e) => seen.push(e) },
    });
    const failing = observeHook(
      { hook: "onSandboxReady", where: "sandbox" },
      "npm install",
      Effect.fail("boom"),
    );
    await Effect.runPromise(
      Effect.either(failing).pipe(Effect.provideService(RunEvents, emitter)),
    );
    expect(seen.map((e) => e.type)).toEqual(["hookStarted", "hookFinished"]);
    expect(seen[1]).toMatchObject({
      hook: "onSandboxReady",
      where: "sandbox",
      command: "npm install",
      ok: false,
    });
  });
});

describe("describeRunError", () => {
  it("uses the _tag of Sandcastle errors", () => {
    expect(
      describeRunError({ _tag: "AgentIdleTimeoutError", message: "idle" }),
    ).toEqual({
      errorTag: "AgentIdleTimeoutError",
      message: "idle",
      aborted: false,
    });
  });

  it("falls back to the constructor name and reports aborts", () => {
    const controller = new AbortController();
    controller.abort("stop");
    expect(describeRunError(new TypeError("bad"), controller.signal)).toEqual({
      errorTag: "TypeError",
      message: "bad",
      aborted: true,
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: run() with the no-sandbox provider and a scripted agent
// ---------------------------------------------------------------------------

/**
 * A scripted agent: runs `script` and understands `TEXT:<msg>` and
 * `TOOL:<name>:<args>` stdout lines.
 */
const scriptedAgent = (script: string): AgentProvider => ({
  name: "scripted",
  model: "scripted-1",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: script }),
  parseStreamLine: (line): ParsedStreamEvent[] => {
    if (line.startsWith("TEXT:"))
      return [{ type: "text", text: line.slice(5) }];
    if (line.startsWith("TOOL:")) {
      const [, name, ...args] = line.split(":");
      return [{ type: "tool_call", name: name!, args: args.join(":") }];
    }
    return [];
  },
});

const makeRepo = (): string => {
  const dir = tempDir("run-events-repo-");
  execSync(
    "git init -q -b main && git config user.email t@example.com && git config user.name Test && git commit -q --allow-empty -m init",
    { cwd: dir },
  );
  writeFileSync(join(dir, ".gitignore"), ".sandcastle/\n");
  return dir;
};

describe("run() emits run events", () => {
  it("emits the full lifecycle for a committing, completing run", async () => {
    const repo = makeRepo();
    const seen: RunEvent[] = [];
    const agent = scriptedAgent(
      [
        "echo 'TEXT:Working on it'",
        "echo 'TOOL:Bash:git commit -m feat'",
        "echo hi > f.txt && git add f.txt && git commit -qm feat",
        "echo 'TEXT:<promise>COMPLETE</promise>'",
      ].join(" && "),
    );

    const result = await run({
      agent,
      sandbox: noSandbox(),
      cwd: repo,
      prompt: "do the thing",
      maxIterations: 3,
      name: "implementer",
      labels: { phase: "implement", issue: "42" },
      logging: { type: "file", path: join(repo, ".sandcastle", "test.log") },
      hooks: { sandbox: { onSandboxReady: [{ command: "true" }] } },
      events: { onEvent: (e) => seen.push(e) },
    });

    expect(result.commits).toHaveLength(1);

    const types = seen.map((e) => e.type);
    expect(types[0]).toBe("runStarted");
    expect(types.at(-1)).toBe("runFinished");
    expect(types).toEqual(
      expect.arrayContaining([
        "iterationStarted",
        "sandboxStarting",
        "sandboxReady",
        "hookStarted",
        "hookFinished",
        "agentStarted",
        "agentText",
        "toolCall",
        "completionSignal",
        "agentStopped",
        "commit",
        "iterationFinished",
      ]),
    );
    // Completion signal stops the loop after one iteration.
    expect(types.filter((t) => t === "iterationStarted")).toHaveLength(1);

    const started = seen[0]!;
    expect(started).toMatchObject({
      type: "runStarted",
      name: "implementer",
      labels: { phase: "implement", issue: "42" },
      agent: "scripted",
      model: "scripted-1",
      sandbox: "no-sandbox",
      branchStrategy: "head",
      branch: "main",
      maxIterations: 3,
      pid: process.pid,
    });
    // Every event belongs to the same run.
    expect(new Set(seen.map((e) => e.runId)).size).toBe(1);

    expect(seen.find((e) => e.type === "commit")).toMatchObject({
      iteration: 1,
      sha: result.commits[0]!.sha,
    });
    expect(seen.find((e) => e.type === "toolCall")).toMatchObject({
      name: "Bash",
      formattedArgs: "git commit -m feat",
    });
    expect(seen.at(-1)).toMatchObject({
      type: "runFinished",
      iterations: 1,
      commits: 1,
      completionSignal: "<promise>COMPLETE</promise>",
    });

    // The same stream lands in the session NDJSON file.
    const fileEvents = readNdjson(
      defaultRunEventsFilePath(repo, started.sessionId),
    ).filter((e) => e.runId === started.runId);
    expect(fileEvents.map((e) => e.type)).toEqual(types);
  });

  it("emits runFailed when the agent exits non-zero", async () => {
    const repo = makeRepo();
    const seen: RunEvent[] = [];
    await expect(
      run({
        agent: scriptedAgent("echo 'TEXT:about to fail' && exit 3"),
        sandbox: noSandbox(),
        cwd: repo,
        prompt: "fail",
        logging: { type: "file", path: join(repo, ".sandcastle", "test.log") },
        events: { file: false, onEvent: (e) => seen.push(e) },
      }),
    ).rejects.toThrow();

    expect(seen[0]!.type).toBe("runStarted");
    expect(seen.at(-1)).toMatchObject({
      type: "runFailed",
      errorTag: "AgentError",
      aborted: false,
    });
    expect(seen.some((e) => e.type === "runFinished")).toBe(false);
  });

  it("writes no event file when events is false", async () => {
    const repo = makeRepo();
    await run({
      agent: scriptedAgent("echo 'TEXT:done'"),
      sandbox: noSandbox(),
      cwd: repo,
      prompt: "noop",
      logging: { type: "file", path: join(repo, ".sandcastle", "test.log") },
      events: false,
    });
    expect(existsSync(join(repo, ".sandcastle", "events"))).toBe(false);
  });
});

describe("describeRunError with Effect failures", () => {
  it("unwraps FiberFailure from Effect.runPromise", async () => {
    const error = await Effect.runPromise(
      Effect.fail({ _tag: "AgentError", message: "exit 3" }),
    ).catch((e: unknown) => e);
    expect(describeRunError(error)).toMatchObject({
      errorTag: "AgentError",
      message: "exit 3",
    });
  });
});

// ---------------------------------------------------------------------------
// Regressions from PR #1 review
// ---------------------------------------------------------------------------

describe("run events review regressions", () => {
  it("keeps the envelope sessionId on every event, including iterationFinished", async () => {
    const repo = makeRepo();
    const seen: RunEvent[] = [];
    await run({
      agent: scriptedAgent("echo 'TEXT:done'"),
      sandbox: noSandbox(),
      cwd: repo,
      prompt: "noop",
      maxIterations: 2,
      logging: { type: "file", path: join(repo, ".sandcastle", "test.log") },
      events: { onEvent: (e) => seen.push(e) },
    });

    const processSession = getRunEventSessionId();
    expect(seen.length).toBeGreaterThan(0);
    for (const event of seen) expect(event.sessionId).toBe(processSession);
    const finished = seen.filter((e) => e.type === "iterationFinished");
    expect(finished).toHaveLength(2);
    // The scripted agent reports no agent session.
    for (const e of finished)
      expect(e).not.toHaveProperty("agentSessionId", expect.anything());

    const fileEvents = readNdjson(
      defaultRunEventsFilePath(repo, processSession),
    );
    for (const event of fileEvents)
      expect(event.sessionId).toBe(processSession);
  });

  it("does not let an agent commit event files in repos with a pre-events .gitignore", async () => {
    const repo = tempDir("run-events-oldignore-");
    execSync(
      [
        "git init -q -b main",
        "git config user.email t@example.com",
        "git config user.name Test",
        "mkdir -p .sandcastle",
        // The .sandcastle/.gitignore scaffolded before events/ was added.
        "printf '.env\\nlogs/\\nworktrees/\\n' > .sandcastle/.gitignore",
        "git add -A",
        "git commit -q -m init",
      ].join(" && "),
      { cwd: repo },
    );

    await run({
      agent: scriptedAgent(
        "echo hi > f.txt && git add . && git commit -qm feat && echo 'TEXT:done'",
      ),
      sandbox: noSandbox(),
      cwd: repo,
      prompt: "commit everything",
      logging: {
        type: "file",
        path: join(repo, ".sandcastle", "logs", "t.log"),
      },
    });

    const committed = execSync("git show --name-only --format= HEAD", {
      cwd: repo,
    })
      .toString()
      .trim()
      .split("\n");
    expect(committed).toEqual(["f.txt"]);
    expect(execSync("git status --porcelain", { cwd: repo }).toString()).toBe(
      "",
    );
    expect(
      readFileSync(join(repo, ".sandcastle", "events", ".gitignore"), "utf8"),
    ).toContain("*");
  });

  it("flushes buffered text and emits agentStopped before runFailed", async () => {
    const repo = makeRepo();
    const seen: RunEvent[] = [];
    // "short" has no sentence boundary or newline, so it sits in the text buffer.
    await expect(
      run({
        agent: scriptedAgent("echo 'TEXT:short' && exit 3"),
        sandbox: noSandbox(),
        cwd: repo,
        prompt: "fail",
        logging: { type: "file", path: join(repo, ".sandcastle", "test.log") },
        events: { file: false, onEvent: (e) => seen.push(e) },
      }),
    ).rejects.toThrow();

    const typesAtRejection = seen.map((e) => e.type);
    expect(typesAtRejection.slice(-3)).toEqual([
      "agentText",
      "agentStopped",
      "runFailed",
    ]);
    // Nothing trickles in after the outcome (TextDeltaBuffer debounce is ~100ms).
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen.map((e) => e.type)).toEqual(typesAtRejection);
  });

  it("swallows rejections from async onEvent callbacks", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const emitter = createRunEventEmitter({
        hostRepoDir: tempDir("run-events-"),
        events: {
          file: false,
          onEvent: async () => {
            throw new Error("broken async forwarder");
          },
        },
      });
      expect(() =>
        emitter.emit({ type: "iterationStarted", iteration: 1 }),
      ).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
