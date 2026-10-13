/**
 * Wire protocol between the `sandcastle dashboard` server and its browser UI.
 * Type-only (plus constants) so both sides import it without pulling in Node.
 *
 * - `GET /`                              the UI (`index.html`)
 * - `GET /assets/<file>`                 bundled UI assets (`app.js`, `app.css`)
 * - `GET /api/sessions`                  {@link SessionsResponse}
 * - `GET /api/sessions/<id>/events`      Server-Sent Events, see {@link SSE_EVENTS}
 */

import type { RunEvent } from "../RunEvents.js";

/** Default port for `sandcastle dashboard`. */
export const DEFAULT_DASHBOARD_PORT = 4477;

/** Session id of the synthetic session served by `sandcastle dashboard --demo`. */
export const DEMO_SESSION_ID = "demo";

/** Session ids are file stems; anything else is rejected (no path traversal). */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface SessionSummary {
  readonly sessionId: string;
  readonly sizeBytes: number;
  /** File mtime, epoch ms. */
  readonly modifiedAt: number;
  /** `ts` of the first event, epoch ms. */
  readonly firstEventAt?: number;
  /** `ts` of the last event, epoch ms. */
  readonly lastEventAt?: number;
  /** Number of `runStarted` events. */
  readonly runs: number;
  /** Distinct `phase` labels, in first-seen order. */
  readonly phases: readonly string[];
  /** True when a process that wrote this session is still running. */
  readonly live: boolean;
  readonly demo?: boolean;
}

export interface SessionsResponse {
  /** Newest first (by `modifiedAt`). */
  readonly sessions: readonly SessionSummary[];
  /** Absolute path of the directory being watched. */
  readonly eventsDir: string;
}

/** Payload of the `liveness` SSE event: pid → is that process still running. */
export interface LivenessMessage {
  readonly pids: Readonly<Record<string, boolean>>;
}

/**
 * SSE event names on `/api/sessions/<id>/events`. The stream sends the whole
 * backlog as `events` batches, then `ready`, then live `events` batches as the
 * file grows, plus `liveness` every couple of seconds. Comment lines
 * (`: keepalive`) are sent periodically and carry nothing.
 */
export const SSE_EVENTS = {
  /** `data`: `RunEvent[]` in file order. */
  events: "events",
  /** `data`: `{}`. Backlog fully delivered; the UI can drop its loading state. */
  ready: "ready",
  /** `data`: {@link LivenessMessage}. */
  liveness: "liveness",
  /** `data`: `{ message: string }`. The session cannot be streamed (e.g. not found). */
  sessionError: "sessionError",
} as const;

export type EventsMessage = readonly RunEvent[];
