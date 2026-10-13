/**
 * Client-side session state: an SSE connection feeding the dashboard
 * projection, with React re-renders batched to one per animation frame.
 *
 * Events are folded into the projection as soon as they arrive; subscribers
 * are told at most once per frame. On (re)connect the server resends the whole
 * backlog, so the stream folds it into a fresh projection and swaps it in on
 * `ready`, keeping the last good state on screen while reconnecting.
 */

import { useSyncExternalStore } from "react";
import type { RunEvent } from "../../RunEvents.js";
import {
  applyEvent,
  applyLiveness,
  createSessionView,
  type SessionView,
} from "../projection.js";
import { SSE_EVENTS, type LivenessMessage } from "../protocol.js";
import { sessionEventsUrl } from "./api.js";

export type StreamStatus =
  /** First connection; backlog not delivered yet. */
  | "connecting"
  /** Backlog delivered, connection open. */
  | "open"
  /** Connection dropped; the browser (or we) are retrying. Last state is kept. */
  | "reconnecting"
  /** The server refused the session (e.g. not found). No retry. */
  | "failed";

type Listener = () => void;

/** Retry delay when the browser gives up on an EventSource (non-2xx response). */
const MANUAL_RETRY_MS = 3000;

export class SessionStream {
  readonly sessionId: string;
  /** The projection on screen. Replaced (not mutated) when a replay completes. */
  view: SessionView = createSessionView();
  status: StreamStatus = "connecting";
  /** True once a backlog has been fully delivered at least once. */
  loaded = false;
  errorMessage?: string;

  private version = 0;
  private listeners = new Set<Listener>();
  private frame?: number;
  private es?: EventSource;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** Projection being rebuilt from a replayed backlog, swapped in on `ready`. */
  private pending?: SessionView;
  private lastLiveness?: LivenessMessage;
  private closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.es?.close();
    this.es = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  private connect(): void {
    if (this.closed) return;
    const es = new EventSource(sessionEventsUrl(this.sessionId));
    this.es = es;

    es.addEventListener("open", () => {
      // Every (re)connect replays the full backlog: fold it into a fresh view.
      this.pending = createSessionView();
    });

    es.addEventListener(SSE_EVENTS.events, (e) => {
      const batch = parse<RunEvent[]>(e);
      if (!batch) return;
      const target = this.pending ?? this.view;
      for (const event of batch) applyEvent(target, event);
      if (!this.pending) this.schedule();
    });

    es.addEventListener(SSE_EVENTS.ready, () => {
      if (this.pending) {
        this.view = this.pending;
        this.pending = undefined;
      }
      if (this.lastLiveness) this.applyLivenessTo(this.view, this.lastLiveness);
      this.loaded = true;
      this.status = "open";
      this.errorMessage = undefined;
      this.schedule();
    });

    es.addEventListener(SSE_EVENTS.liveness, (e) => {
      const msg = parse<LivenessMessage>(e);
      if (!msg) return;
      this.lastLiveness = msg;
      const target = this.pending ?? this.view;
      if (this.applyLivenessTo(target, msg) && !this.pending) this.schedule();
    });

    es.addEventListener(SSE_EVENTS.sessionError, (e) => {
      const msg = parse<{ message?: string }>(e);
      this.errorMessage = msg?.message ?? "The session cannot be streamed.";
      this.status = "failed";
      es.close();
      this.schedule();
    });

    es.addEventListener("error", () => {
      if (this.status === "failed") return;
      this.pending = undefined;
      this.status = this.loaded ? "reconnecting" : "connecting";
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up (e.g. server restarting returned 5xx); retry ourselves.
        this.status = "reconnecting";
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), MANUAL_RETRY_MS);
      }
      this.schedule();
    });
  }

  private applyLivenessTo(view: SessionView, msg: LivenessMessage): boolean {
    return applyLiveness(view, (pid) => msg.pids[String(pid)]);
  }

  /** Notify subscribers on the next animation frame, at most once per frame. */
  private schedule(): void {
    if (this.frame !== undefined || this.closed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.version++;
      for (const l of this.listeners) l();
    });
  }
}

const parse = <T>(e: Event): T | undefined => {
  if (!(e instanceof MessageEvent) || typeof e.data !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(e.data) as T;
  } catch {
    return undefined;
  }
};

/** Re-render on every batched change to the stream. */
export const useStream = (stream: SessionStream): number =>
  useSyncExternalStore(stream.subscribe, stream.getVersion, stream.getVersion);

// ---------------------------------------------------------------------------
// One shared 1s clock for every elapsed timer on the page.
// ---------------------------------------------------------------------------

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const tickListeners = new Set<Listener>();

const subscribeTick = (listener: Listener): (() => void) => {
  tickListeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of tickListeners) l();
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const getNow = (): number => now;
const noopSubscribe = (): (() => void) => () => {};

/**
 * Current time, updated once a second while `active`. When inactive the
 * component does not subscribe and gets a value frozen at the last tick.
 */
export const useNow = (active = true): number =>
  useSyncExternalStore(active ? subscribeTick : noopSubscribe, getNow, getNow);
