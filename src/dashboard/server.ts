/**
 * HTTP server behind `sandcastle dashboard`: serves the bundled UI, lists run
 * event files and streams one run session's events over Server-Sent Events,
 * tailing the NDJSON file as it grows. Node built-ins only. See
 * {@link ./protocol.ts} for the wire protocol.
 */

import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../RunEvents.js";
import { startDemoPlayer, type DemoPlayer } from "./demo.js";
import {
  DEMO_SESSION_ID,
  SESSION_ID_PATTERN,
  SSE_EVENTS,
  type LivenessMessage,
  type SessionSummary,
  type SessionsResponse,
} from "./protocol.js";

export interface DashboardServerOptions {
  /** Directory holding `<sessionId>.ndjson` run event files. Need not exist. */
  readonly eventsDir: string;
  /** `0` picks a free port. */
  readonly port: number;
  readonly host: string;
  /** Directory holding the built UI (`index.html`, `app.js`, `app.css`). */
  readonly assetsDir: string;
  /** Serve the synthetic {@link DEMO_SESSION_ID} session. */
  readonly demo?: boolean;
  /** Demo playback speed multiplier. Default `1`. */
  readonly demoSpeed?: number;
  /** How often SSE streams poll their file for new bytes. Default 250ms. */
  readonly pollIntervalMs?: number;
  /** How often SSE streams send `liveness`. Default 2000ms. */
  readonly livenessIntervalMs?: number;
  /** How often SSE streams send a keepalive comment. Default 15000ms. */
  readonly keepaliveIntervalMs?: number;
}

export interface DashboardServer {
  /** Base URL, e.g. `http://127.0.0.1:4477/`. */
  readonly url: string;
  readonly port: number;
  /** Stop accepting connections, end open streams and stop the demo. */
  readonly close: () => Promise<void>;
}

/** Max events per SSE `events` message. */
const SSE_BATCH_SIZE = 500;
/** Max bytes read from an event file per step. */
const READ_CHUNK_BYTES = 1024 * 1024;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a process is running. `EPERM` means it exists but belongs to
 * someone else, so it counts as alive.
 */
export const isPidAlive = (pid: number): boolean => {
  // 0 and negative pids address process groups; never probe those.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Directory holding the built dashboard UI. From the bundled CLI
 * (`dist/*.js`) that is `dist/dashboard/`. When running from source
 * (`src/dashboard/*.ts`) it falls back to `<repo>/dist/dashboard/` if built.
 *
 * @param moduleUrl `import.meta.url` of the calling module.
 */
export const resolveDashboardAssetsDir = (moduleUrl: string): string => {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const besideBundle = join(moduleDir, "dashboard");
  if (existsSync(join(besideBundle, "index.html"))) return besideBundle;
  // Source layout: <repo>/src/dashboard/server.ts or <repo>/src/cli.ts.
  const fromSource = [
    resolve(moduleDir, "..", "dist", "dashboard"),
    resolve(moduleDir, "..", "..", "dist", "dashboard"),
  ];
  for (const candidate of fromSource) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  // Nothing built: point at where the build would put it, for the help page.
  return basename(moduleDir) === "src" ? fromSource[0]! : besideBundle;
};

const isRunEvent = (value: unknown): value is RunEvent =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { runId?: unknown }).runId === "string";

/** Parse NDJSON lines, skipping blank and malformed ones. */
const parseLines = (text: string): RunEvent[] => {
  const events: RunEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRunEvent(value)) events.push(value);
    } catch {
      // Skip malformed lines (e.g. a write torn by a crash).
    }
  }
  return events;
};

const NEWLINE = 0x0a;

/**
 * Incremental NDJSON reader over a file that only grows. Keeps the byte
 * offset of the last complete line and buffers a partial trailing line until
 * its newline arrives. If the file shrinks (truncated or replaced) it starts
 * over from the beginning.
 */
class NdjsonTail {
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(private readonly path: string) {}

  /** Read everything appended since the last call, in chunks. */
  async read(onEvents: (events: RunEvent[]) => void): Promise<void> {
    const { size } = await stat(this.path);
    if (size < this.offset) {
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
    }
    if (size === this.offset) return;
    const handle = await open(this.path, "r");
    try {
      while (this.offset < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - this.offset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const data = Buffer.concat([
          this.remainder,
          chunk.subarray(0, bytesRead),
        ]);
        const lastNewline = data.lastIndexOf(NEWLINE);
        if (lastNewline === -1) {
          this.remainder = data;
          continue;
        }
        this.remainder = data.subarray(lastNewline + 1);
        const events = parseLines(data.subarray(0, lastNewline).toString());
        if (events.length > 0) onEvents(events);
      }
    } finally {
      await handle.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Session summaries
// ---------------------------------------------------------------------------

interface SummaryCacheEntry {
  size: number;
  mtimeMs: number;
  tail: NdjsonTail;
  firstEventAt?: number;
  lastEventAt?: number;
  runs: number;
  phases: string[];
  pids: Set<number>;
}

/** Fold events into a summary accumulator. */
const accumulate = (
  acc: Omit<SummaryCacheEntry, "size" | "mtimeMs" | "tail">,
  events: readonly RunEvent[],
): void => {
  for (const event of events) {
    const at = Date.parse(event.ts);
    if (!Number.isNaN(at)) {
      acc.firstEventAt = Math.min(acc.firstEventAt ?? at, at);
      acc.lastEventAt = Math.max(acc.lastEventAt ?? at, at);
    }
    if (event.type === "runStarted") {
      acc.runs++;
      const phase = event.labels?.phase;
      if (phase !== undefined && !acc.phases.includes(String(phase))) {
        acc.phases.push(String(phase));
      }
      if (typeof event.pid === "number") acc.pids.add(event.pid);
    }
  }
};

const anyAlive = (pids: Iterable<number>): boolean => {
  for (const pid of pids) if (isPidAlive(pid)) return true;
  return false;
};

/**
 * Summarises event files, re-reading only what changed: unchanged files (same
 * size and mtime) are served from cache, grown files are read from where the
 * last scan stopped.
 */
class SessionIndex {
  private readonly cache = new Map<string, SummaryCacheEntry>();

  constructor(private readonly eventsDir: string) {}

  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.eventsDir);
    } catch {
      return []; // Missing or unreadable directory: nothing to show yet.
    }
    const seen = new Set<string>();
    const summaries: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue;
      const sessionId = name.slice(0, -".ndjson".length);
      if (!SESSION_ID_PATTERN.test(sessionId)) continue;
      const path = join(this.eventsDir, name);
      seen.add(path);
      try {
        summaries.push(await this.summarise(sessionId, path));
      } catch {
        // File vanished or is unreadable between readdir and read: skip it.
        this.cache.delete(path);
      }
    }
    for (const path of this.cache.keys()) {
      if (!seen.has(path)) this.cache.delete(path);
    }
    return summaries;
  }

  private async summarise(
    sessionId: string,
    path: string,
  ): Promise<SessionSummary> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    let entry = this.cache.get(path);
    if (entry && info.size < entry.size) entry = undefined; // truncated
    if (!entry) {
      entry = {
        size: -1,
        mtimeMs: -1,
        tail: new NdjsonTail(path),
        runs: 0,
        phases: [],
        pids: new Set(),
      };
      this.cache.set(path, entry);
    }
    if (entry.size !== info.size || entry.mtimeMs !== info.mtimeMs) {
      const acc = entry;
      await entry.tail.read((events) => accumulate(acc, events));
      entry.size = info.size;
      entry.mtimeMs = info.mtimeMs;
    }
    return {
      sessionId,
      sizeBytes: info.size,
      modifiedAt: info.mtimeMs,
      firstEventAt: entry.firstEventAt,
      lastEventAt: entry.lastEventAt,
      runs: entry.runs,
      phases: [...entry.phases],
      live: anyAlive(entry.pids),
    };
  }
}

const demoSummary = (player: DemoPlayer): SessionSummary => {
  const acc = {
    runs: 0,
    phases: [] as string[],
    pids: new Set<number>(),
    firstEventAt: undefined as number | undefined,
    lastEventAt: undefined as number | undefined,
  };
  accumulate(acc, player.backlog());
  return {
    sessionId: DEMO_SESSION_ID,
    sizeBytes: 0,
    modifiedAt: Date.now(),
    firstEventAt: acc.firstEventAt,
    lastEventAt: acc.lastEventAt,
    runs: acc.runs,
    phases: acc.phases,
    live: true,
    demo: true,
  };
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const sendJson = (
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : json);
};

const sendNotFound = (req: IncomingMessage, res: ServerResponse): void =>
  sendJson(req, res, 404, { error: "Not found" });

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

const missingAssetsPage = (assetsDir: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sandcastle dashboard</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5">
<h1>Sandcastle dashboard</h1>
<p>UI assets not found at <code>${escapeHtml(assetsDir)}</code>.</p>
<p>Run <code>npm run build</code> to build them, then reload this page.
The API is still available at <a href="/api/sessions"><code>/api/sessions</code></a>.</p>
</body>
</html>
`;

const sendFile = async (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> => {
  let body: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    body = await readFile(path);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type":
      CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
};

/** One open SSE response. */
interface SseStream {
  readonly send: (event: string, data: unknown) => void;
  readonly sendEvents: (events: readonly RunEvent[]) => void;
  readonly comment: (text: string) => void;
  readonly closed: () => boolean;
}

const openSse = (res: ServerResponse): SseStream => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const closed = () => res.destroyed || res.writableEnded;
  const send = (event: string, data: unknown) => {
    if (closed()) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    send,
    sendEvents: (events) => {
      for (let i = 0; i < events.length; i += SSE_BATCH_SIZE) {
        send(SSE_EVENTS.events, events.slice(i, i + SSE_BATCH_SIZE));
      }
    },
    comment: (text) => {
      if (!closed()) res.write(`: ${text}\n\n`);
    },
    closed,
  };
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the dashboard server. Rejects with a readable error when the port is
 * already taken.
 */
export const startDashboardServer = async (
  options: DashboardServerOptions,
): Promise<DashboardServer> => {
  const eventsDir = resolve(options.eventsDir);
  const assetsDir = resolve(options.assetsDir);
  const pollMs = options.pollIntervalMs ?? 250;
  const livenessMs = options.livenessIntervalMs ?? 2_000;
  const keepaliveMs = options.keepaliveIntervalMs ?? 15_000;
  const index = new SessionIndex(eventsDir);
  const demo = options.demo
    ? startDemoPlayer({ speed: options.demoSpeed })
    : undefined;
  /** Cleanup for every open SSE stream, so `close()` can end them. */
  const streams = new Set<() => void>();

  /** Wire timers to a stream and tear them down when the client goes away. */
  const runStream = (
    req: IncomingMessage,
    res: ServerResponse,
    setup: (
      sse: SseStream,
      every: (ms: number, fn: () => void) => void,
      onClose: (fn: () => void) => void,
    ) => void,
  ): void => {
    const sse = openSse(res);
    const timers: ReturnType<typeof setInterval>[] = [];
    const closers: (() => void)[] = [];
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearInterval(t);
      for (const fn of closers) fn();
      streams.delete(cleanup);
      if (!res.writableEnded) res.end();
    };
    streams.add(cleanup);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    setup(
      sse,
      (ms, fn) => {
        if (!done) timers.push(setInterval(fn, ms));
      },
      (fn) => closers.push(fn),
    );
    if (!done) {
      timers.push(setInterval(() => sse.comment("keepalive"), keepaliveMs));
    }
  };

  const streamFile = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> => {
    try {
      if (!(await stat(path)).isFile()) return sendNotFound(req, res);
    } catch {
      return sendJson(req, res, 404, { error: "Session not found" });
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
      return;
    }
    runStream(req, res, (sse, every) => {
      const tail = new NdjsonTail(path);
      const pids = new Set<number>();
      const onEvents = (events: RunEvent[]) => {
        for (const e of events) {
          if (e.type === "runStarted" && typeof e.pid === "number") {
            pids.add(e.pid);
          }
        }
        sse.sendEvents(events);
      };
      const liveness = () => {
        const message: { pids: Record<string, boolean> } = { pids: {} };
        for (const pid of pids) message.pids[String(pid)] = isPidAlive(pid);
        sse.send(SSE_EVENTS.liveness, message satisfies LivenessMessage);
      };
      let busy = false;
      const poll = async () => {
        if (busy || sse.closed()) return;
        busy = true;
        try {
          await tail.read(onEvents);
        } catch {
          // File briefly missing (rotation) or unreadable: try again next tick.
        } finally {
          busy = false;
        }
      };
      busy = true;
      tail
        .read(onEvents)
        .catch(() => {
          sse.send(SSE_EVENTS.sessionError, {
            message: "Could not read session",
          });
        })
        .finally(() => {
          busy = false;
          if (sse.closed()) return;
          sse.send(SSE_EVENTS.ready, {});
          liveness();
          every(pollMs, () => void poll());
          every(livenessMs, liveness);
        });
    });
  };

  const streamDemo = (
    req: IncomingMessage,
    res: ServerResponse,
    player: DemoPlayer,
  ): void => {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
      return;
    }
    runStream(req, res, (sse, every, onClose) => {
      const liveness = () =>
        sse.send(SSE_EVENTS.liveness, {
          pids: { [String(player.pid)]: true },
        } satisfies LivenessMessage);
      sse.sendEvents(player.backlog());
      sse.send(SSE_EVENTS.ready, {});
      liveness();
      onClose(player.subscribe((events) => sse.sendEvents(events)));
      every(livenessMs, liveness);
    });
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendNotFound(req, res);
    }

    if (pathname === "/" || pathname === "/index.html") {
      if (await sendFile(req, res, join(assetsDir, "index.html"))) return;
      const page = missingAssetsPage(assetsDir);
      res.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(page),
      });
      res.end(req.method === "HEAD" ? undefined : page);
      return;
    }

    if (pathname.startsWith("/assets/")) {
      const name = pathname.slice("/assets/".length);
      if (
        ASSET_NAME_PATTERN.test(name) &&
        (await sendFile(req, res, join(assetsDir, name)))
      ) {
        return;
      }
      return sendNotFound(req, res);
    }

    if (pathname === "/api/sessions") {
      const sessions = await index.list();
      if (demo) {
        const i = sessions.findIndex((s) => s.sessionId === DEMO_SESSION_ID);
        if (i !== -1) sessions.splice(i, 1);
        sessions.push(demoSummary(demo));
      }
      sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
      return sendJson(req, res, 200, {
        sessions,
        eventsDir,
      } satisfies SessionsResponse);
    }

    const match = /^\/api\/sessions\/([^/]+)\/events$/.exec(pathname);
    if (match) {
      let id: string;
      try {
        id = decodeURIComponent(match[1]!);
      } catch {
        return sendNotFound(req, res);
      }
      if (!SESSION_ID_PATTERN.test(id)) return sendNotFound(req, res);
      if (demo && id === DEMO_SESSION_ID) return streamDemo(req, res, demo);
      return streamFile(req, res, join(eventsDir, `${id}.ndjson`));
    }

    return sendNotFound(req, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(req, res, 500, { error: "Internal error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      demo?.stop();
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${options.port} on ${options.host} is already in use. Pick another with --port.`,
          ),
        );
      } else if (error.code === "EACCES") {
        reject(
          new Error(
            `Permission denied binding ${options.host}:${options.port}. Pick another with --port.`,
          ),
        );
      } else {
        reject(error);
      }
    };
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });

  const { port } = server.address() as AddressInfo;
  const hostForUrl = options.host.includes(":")
    ? `[${options.host}]`
    : options.host;

  let closing: Promise<void> | undefined;
  return {
    url: `http://${hostForUrl}:${port}/`,
    port,
    close: () =>
      (closing ??= new Promise<void>((resolvePromise) => {
        demo?.stop();
        for (const cleanup of [...streams]) cleanup();
        server.close(() => resolvePromise());
        server.closeAllConnections();
      })),
  };
};
