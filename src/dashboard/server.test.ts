import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvent } from "../RunEvents.js";
import type { LivenessMessage, SessionsResponse } from "./protocol.js";
import {
  isPidAlive,
  resolveDashboardAssetsDir,
  startDashboardServer,
  type DashboardServer,
} from "./server.js";

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A pid that is (almost certainly) not running. */
const DEAD_PID = 2 ** 22 + 12_345;

let seq = 0;
const ev = (
  sessionId: string,
  runId: string,
  payload: Record<string, unknown>,
  ts = "2026-10-11T12:00:00.000Z",
): RunEvent =>
  ({
    ...payload,
    v: RUN_EVENT_SCHEMA_VERSION,
    ts,
    sessionId,
    runId,
    seq: ++seq,
  }) as RunEvent;

const runStarted = (
  sessionId: string,
  runId: string,
  phase: string | undefined,
  pid: number,
  ts?: string,
) =>
  ev(
    sessionId,
    runId,
    {
      type: "runStarted",
      labels: phase ? { phase } : {},
      agent: "claude-code",
      sandbox: "docker",
      branchStrategy: "branch",
      maxIterations: 1,
      hostRepoDir: "/repo",
      pid,
    },
    ts,
  );

const line = (e: RunEvent) => JSON.stringify(e) + "\n";

const servers: DashboardServer[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

afterEach(async () => {
  for (const r of readers.splice(0)) await r.cancel().catch(() => {});
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const start = async (
  opts: { eventsDir?: string; assetsDir?: string; demo?: boolean } = {},
) => {
  const server = await startDashboardServer({
    eventsDir: opts.eventsDir ?? tempDir("dash-events-"),
    assetsDir: opts.assetsDir ?? tempDir("dash-assets-"),
    port: 0,
    host: "127.0.0.1",
    demo: opts.demo,
    demoSpeed: 1000,
    pollIntervalMs: 20,
    livenessIntervalMs: 50,
  });
  servers.push(server);
  return server;
};

interface SseMessage {
  readonly event: string;
  readonly data: unknown;
}

/** Minimal SSE client: yields parsed messages from a fetch body. */
const openSse = async (url: string) => {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  readers.push(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: SseMessage[] = [];

  const next = async (timeoutMs = 3000): Promise<SseMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (queue.length === 0) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const data: string[] = [];
        for (const l of block.split("\n")) {
          if (l.startsWith("event: ")) event = l.slice(7);
          else if (l.startsWith("data: ")) data.push(l.slice(6));
        }
        if (data.length > 0) {
          queue.push({ event, data: JSON.parse(data.join("\n")) });
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error("SSE timeout");
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE timeout")), timeoutMs),
        ),
      ]);
      if (chunk.done) throw new Error("SSE stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return queue.shift()!;
  };

  /** Next message with the given event name, skipping others. */
  const nextOf = async (event: string, timeoutMs = 3000) => {
    for (;;) {
      const m = await next(timeoutMs);
      if (m.event === event) return m;
    }
  };
  return { next, nextOf };
};

describe("startDashboardServer", () => {
  it("lists sessions with counts, phases and liveness, newest first", async () => {
    const dir = tempDir("dash-events-");
    writeFileSync(
      join(dir, "old.ndjson"),
      line(
        runStarted("old", "r1", "plan", DEAD_PID, "2026-10-11T10:00:00.000Z"),
      ) +
        "not json\n" +
        line(
          runStarted(
            "old",
            "r2",
            "implement",
            DEAD_PID,
            "2026-10-11T10:05:00.000Z",
          ),
        ) +
        line(
          runStarted("old", "r3", "plan", DEAD_PID, "2026-10-11T10:06:00.000Z"),
        ),
    );
    // Make sure mtimes differ.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(
      join(dir, "new.ndjson"),
      line(runStarted("new", "r1", undefined, process.pid)),
    );
    writeFileSync(join(dir, "notes.txt"), "ignored");
    writeFileSync(join(dir, "bad name!.ndjson"), "ignored");

    const server = await start({ eventsDir: dir });
    const res = await fetch(`${server.url}api/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.eventsDir).toBe(dir);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
    expect(body.sessions[1]).toMatchObject({
      runs: 3,
      phases: ["plan", "implement"],
      live: false,
      firstEventAt: Date.parse("2026-10-11T10:00:00.000Z"),
      lastEventAt: Date.parse("2026-10-11T10:06:00.000Z"),
    });
    expect(body.sessions[1]!.sizeBytes).toBeGreaterThan(0);
    expect(body.sessions[0]).toMatchObject({ runs: 1, phases: [], live: true });

    // Appended lines are picked up on the next poll.
    appendFileSync(
      join(dir, "old.ndjson"),
      line(runStarted("old", "r4", "merge", process.pid)),
    );
    const again = (await (
      await fetch(`${server.url}api/sessions`)
    ).json()) as SessionsResponse;
    expect(again.sessions.find((s) => s.sessionId === "old")).toMatchObject({
      runs: 4,
      phases: ["plan", "implement", "merge"],
      live: true,
    });
  });

  it("returns an empty list when the events directory does not exist", async () => {
    const server = await start({
      eventsDir: join(tempDir("dash-"), "missing"),
    });
    const body = (await (
      await fetch(`${server.url}api/sessions`)
    ).json()) as SessionsResponse;
    expect(body.sessions).toEqual([]);
  });

  it("streams the backlog, then ready, then appended lines (including split writes)", async () => {
    const dir = tempDir("dash-events-");
    const file = join(dir, "s1.ndjson");
    writeFileSync(
      file,
      line(runStarted("s1", "r1", "plan", DEAD_PID)) +
        "{ torn line\n" +
        line(ev("s1", "r1", { type: "iterationStarted", iteration: 1 })),
    );
    const server = await start({ eventsDir: dir });
    const sse = await openSse(`${server.url}api/sessions/s1/events`);

    const backlog = await sse.next();
    expect(backlog.event).toBe("events");
    expect((backlog.data as RunEvent[]).map((e) => e.type)).toEqual([
      "runStarted",
      "iterationStarted",
    ]);
    expect((await sse.next()).event).toBe("ready");
    const liveness = await sse.next();
    expect(liveness.event).toBe("liveness");
    expect(liveness.data).toEqual({
      pids: { [String(DEAD_PID)]: false },
    } satisfies LivenessMessage);

    appendFileSync(
      file,
      line(ev("s1", "r1", { type: "agentText", iteration: 1, message: "hi" })),
    );
    const live = await sse.nextOf("events");
    expect((live.data as RunEvent[]).map((e) => e.type)).toEqual(["agentText"]);

    // One line delivered in two writes: nothing is sent until the newline lands.
    const split = line(
      ev("s1", "r1", { type: "agentText", iteration: 1, message: "héllo ✓" }),
    );
    const bytes = Buffer.from(split);
    const cut = bytes.indexOf(Buffer.from("✓")) + 1; // mid multi-byte char
    appendFileSync(file, bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 100));
    appendFileSync(file, bytes.subarray(cut));
    const joined = await sse.nextOf("events");
    expect(joined.data).toEqual([JSON.parse(split)]);
  });

  it("resets to the start of the file when it is truncated", async () => {
    const dir = tempDir("dash-events-");
    const file = join(dir, "s1.ndjson");
    writeFileSync(
      file,
      line(runStarted("s1", "r1", "plan", DEAD_PID)) +
        line(ev("s1", "r1", { type: "iterationStarted", iteration: 1 })),
    );
    const server = await start({ eventsDir: dir });
    const sse = await openSse(`${server.url}api/sessions/s1/events`);
    await sse.nextOf("ready");
    writeFileSync(file, line(runStarted("s1", "r9", "plan", DEAD_PID)));
    const after = await sse.nextOf("events");
    expect((after.data as RunEvent[]).map((e) => e.runId)).toEqual(["r9"]);
  });

  it("splits a large backlog into batches of at most 500 events", async () => {
    const dir = tempDir("dash-events-");
    const lines = [line(runStarted("big", "r1", "plan", DEAD_PID))];
    for (let i = 0; i < 1200; i++) {
      lines.push(
        line(
          ev("big", "r1", { type: "agentText", iteration: 1, message: `${i}` }),
        ),
      );
    }
    writeFileSync(join(dir, "big.ndjson"), lines.join(""));
    const server = await start({ eventsDir: dir });
    const sse = await openSse(`${server.url}api/sessions/big/events`);
    const sizes: number[] = [];
    for (;;) {
      const m = await sse.next();
      if (m.event === "ready") break;
      sizes.push((m.data as RunEvent[]).length);
    }
    expect(sizes.every((n) => n <= 500)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1201);
  });

  it("404s unknown sessions, bad ids and unknown routes; 405s other methods", async () => {
    const server = await start();
    const status = async (path: string, init?: RequestInit) =>
      (await fetch(`${server.url}${path}`, init)).status;
    expect(await status("api/sessions/nope/events")).toBe(404);
    expect(await status("api/sessions/bad%20id/events")).toBe(404);
    expect(await status("api/sessions/..%2F..%2Fetc/events")).toBe(404);
    expect(await status("api/sessions/%E0%A4%A/events")).toBe(404);
    expect(await status("api/nope")).toBe(404);
    expect(await status("api/sessions", { method: "POST" })).toBe(405);
  });

  it("serves UI assets and rejects path traversal", async () => {
    const root = tempDir("dash-assets-");
    const assets = join(root, "dashboard");
    await mkdir(assets);
    writeFileSync(join(assets, "index.html"), "<html>ui</html>");
    writeFileSync(join(assets, "app.js"), "console.log(1)");
    writeFileSync(join(assets, "app.css"), "body{}");
    writeFileSync(join(root, "secret.txt"), "secret");
    const server = await start({ assetsDir: assets });

    const index = await fetch(server.url);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toBe("<html>ui</html>");

    const js = await fetch(`${server.url}assets/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("console.log(1)");
    const css = await fetch(`${server.url}assets/app.css`);
    expect(css.headers.get("content-type")).toContain("text/css");

    for (const path of [
      "assets/..%2Fsecret.txt",
      "assets/%2E%2E%2Fsecret.txt",
      "assets/../secret.txt",
      "assets/.hidden",
      "assets/sub/app.js",
      "assets/missing.js",
    ]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("secret");
    }
  });

  it("shows a helpful page when UI assets are missing", async () => {
    const assets = join(tempDir("dash-"), "nowhere");
    const server = await start({ assetsDir: assets });
    const res = await fetch(server.url);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("UI assets not found");
    expect(html).toContain(assets);
    expect(html).toContain("npm run build");
  });

  it("fails clearly when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(
        startDashboardServer({
          eventsDir: tempDir("dash-"),
          assetsDir: tempDir("dash-"),
          port,
          host: "127.0.0.1",
        }),
      ).rejects.toThrow(/already in use.*--port/);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("serves a shared demo session that plays live", async () => {
    const server = await start({ demo: true });
    const sessions = (await (
      await fetch(`${server.url}api/sessions`)
    ).json()) as SessionsResponse;
    expect(sessions.sessions[0]).toMatchObject({
      sessionId: "demo",
      demo: true,
      live: true,
    });

    const sse = await openSse(`${server.url}api/sessions/demo/events`);
    await sse.nextOf("ready");
    const liveness = await sse.nextOf("liveness");
    expect(liveness.data).toEqual({ pids: { [String(process.pid)]: true } });
    const live = await sse.nextOf("events");
    expect((live.data as RunEvent[]).length).toBeGreaterThan(0);
    expect((live.data as RunEvent[])[0]!.sessionId).toBe("demo");
  });

  it("closes cleanly with streams still open", async () => {
    const dir = tempDir("dash-events-");
    writeFileSync(
      join(dir, "s1.ndjson"),
      line(runStarted("s1", "r1", "plan", DEAD_PID)),
    );
    const server = await startDashboardServer({
      eventsDir: dir,
      assetsDir: dir,
      port: 0,
      host: "127.0.0.1",
      demo: true,
    });
    const a = await openSse(`${server.url}api/sessions/s1/events`);
    await a.nextOf("ready");
    const b = await openSse(`${server.url}api/sessions/demo/events`);
    await b.nextOf("ready");
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

describe("isPidAlive", () => {
  it("detects the current process and rejects bogus pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe("resolveDashboardAssetsDir", () => {
  const setup = () => {
    const repo = tempDir("dash-repo-");
    const fileIn = (...parts: string[]) =>
      new URL(`file://${join(repo, ...parts)}`).href;
    const build = (dir: string) => {
      const d = join(repo, dir);
      return mkdir(d, { recursive: true }).then(() =>
        writeFileSync(join(d, "index.html"), ""),
      );
    };
    return { repo, fileIn, build };
  };

  it("uses dashboard/ beside the bundled module", async () => {
    const { repo, fileIn, build } = setup();
    await build("dist/dashboard");
    expect(resolveDashboardAssetsDir(fileIn("dist", "main.js"))).toBe(
      join(repo, "dist", "dashboard"),
    );
    expect(resolveDashboardAssetsDir(fileIn("dist", "chunk-AB12.js"))).toBe(
      join(repo, "dist", "dashboard"),
    );
  });

  it("falls back to <repo>/dist/dashboard when running from source", async () => {
    const { repo, fileIn, build } = setup();
    await build("dist/dashboard");
    expect(resolveDashboardAssetsDir(fileIn("src", "cli.ts"))).toBe(
      join(repo, "dist", "dashboard"),
    );
    expect(
      resolveDashboardAssetsDir(fileIn("src", "dashboard", "server.ts")),
    ).toBe(join(repo, "dist", "dashboard"));
  });

  it("points at the expected build output when nothing is built", () => {
    const { repo, fileIn } = setup();
    expect(resolveDashboardAssetsDir(fileIn("src", "cli.ts"))).toBe(
      join(repo, "dist", "dashboard"),
    );
    expect(resolveDashboardAssetsDir(fileIn("dist", "main.js"))).toBe(
      join(repo, "dist", "dashboard"),
    );
  });
});
