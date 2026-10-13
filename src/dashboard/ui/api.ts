/**
 * HTTP client for the dashboard server. See `../protocol.ts` for the routes.
 */

import type { SessionsResponse } from "../protocol.js";

export const fetchSessions = async (
  signal?: AbortSignal,
): Promise<SessionsResponse> => {
  const res = await fetch("/api/sessions", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/sessions failed: ${res.status}`);
  }
  return (await res.json()) as SessionsResponse;
};

export const sessionEventsUrl = (sessionId: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/events`;
