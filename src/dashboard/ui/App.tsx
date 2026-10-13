import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionsResponse } from "../protocol.js";
import { fetchSessions } from "./api.js";
import { FactoryFloor } from "./components/FactoryFloor.js";
import { Header, connectionOf } from "./components/Header.js";
import { Inspector } from "./components/Inspector.js";
import { Message, NoSessions, Skeleton } from "./components/States.js";
import { Timeline } from "./components/Timeline.js";
import { SessionStream, useStream } from "./store.js";
import { readUrlSelection, writeUrlSelection } from "./url.js";

const SESSIONS_POLL_MS = 5000;

/** Poll `/api/sessions`. Keeps the last good list when a poll fails. */
const useSessions = () => {
  const [data, setData] = useState<SessionsResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const poll = async () => {
      try {
        const res = await fetchSessions(ctrl.signal);
        if (cancelled) return;
        setData(res);
        setError(undefined);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) timer = setTimeout(poll, SESSIONS_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, []);
  return { data, error };
};

export const App = () => {
  const initial = useMemo(readUrlSelection, []);
  const { data: sessions, error: sessionsError } = useSessions();
  const [sessionId, setSessionId] = useState<string | undefined>(
    initial.session,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    initial.run,
  );
  const [cycleFilter, setCycleFilter] = useState<string>();
  const [hoverIssue, setHoverIssue] = useState<string>();

  // Default to the newest live session, else the newest one.
  useEffect(() => {
    if (sessionId !== undefined || !sessions || sessions.sessions.length === 0)
      return;
    const pick = sessions.sessions.find((s) => s.live) ?? sessions.sessions[0];
    if (pick) setSessionId(pick.sessionId);
  }, [sessions, sessionId]);

  useEffect(() => {
    writeUrlSelection({ session: sessionId, run: selectedRunId });
  }, [sessionId, selectedRunId]);

  const stream = useMemo(
    () => (sessionId !== undefined ? new SessionStream(sessionId) : undefined),
    [sessionId],
  );
  useEffect(() => {
    if (!stream) return;
    stream.start();
    return () => stream.close();
  }, [stream]);

  const placeholder = useMemo(() => new SessionStream(""), []);
  useStream(stream ?? placeholder);

  const view = stream?.loaded ? stream.view : undefined;
  const summary = sessions?.sessions.find((s) => s.sessionId === sessionId);
  const live = summary?.live ?? false;
  const connection = connectionOf(stream?.status, live);
  const ticking =
    live && stream?.status !== "failed" && (view?.totals.active ?? 0) > 0;

  const selectedRun =
    selectedRunId !== undefined ? view?.runs.get(selectedRunId) : undefined;

  const selectSession = useCallback((id: string) => {
    setSessionId(id);
    setSelectedRunId(undefined);
    setCycleFilter(undefined);
    setHoverIssue(undefined);
  }, []);

  const selectRun = useCallback((runId: string) => {
    setSelectedRunId((cur) => (cur === runId ? undefined : runId));
  }, []);

  const closeInspector = useCallback(() => {
    setSelectedRunId((cur) => {
      if (cur !== undefined) {
        // Return focus to the tile that opened the inspector.
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(
              `.tile[data-run-id="${CSS.escape(cur)}"]`,
            )
            ?.focus(),
        );
      }
      return undefined;
    });
  }, []);

  useEffect(() => {
    if (!selectedRun) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeInspector();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedRun, closeInspector]);

  // A cycle filter from another session or a cycle that no longer exists.
  const activeCycle =
    cycleFilter !== undefined && view?.cycles.includes(cycleFilter)
      ? cycleFilter
      : undefined;

  let body;
  if (!sessions && sessionsError) {
    body = (
      <Message title="Cannot reach the dashboard server" tone="error">
        <p>{sessionsError}</p>
        <p>Retrying every 5 seconds.</p>
      </Message>
    );
  } else if (!sessions && sessionId === undefined) {
    body = <Skeleton />;
  } else if (sessions && sessions.sessions.length === 0 && !stream) {
    body = <NoSessions eventsDir={sessions.eventsDir} />;
  } else if (stream?.status === "failed") {
    body = (
      <Message title="This session cannot be shown" tone="error">
        <p>{stream.errorMessage ?? "The server refused the session."}</p>
        <p className="mono">{stream.sessionId}</p>
        {sessions && sessions.sessions.length > 0 && (
          <p>Pick another session from the list above.</p>
        )}
      </Message>
    );
  } else if (!view) {
    body = <Skeleton />;
  } else if (view.runs.size === 0) {
    body = (
      <Message title="Waiting for runs">
        <p>This session has not started any runs yet.</p>
      </Message>
    );
  } else {
    body = (
      <div className="workspace">
        <FactoryFloor
          view={view}
          cycleFilter={activeCycle}
          onCycleFilter={setCycleFilter}
          selectedRunId={selectedRun?.runId}
          hoverIssue={hoverIssue}
          onSelect={selectRun}
          onHoverIssue={setHoverIssue}
        />
        <Timeline
          view={view}
          live={live}
          cycleFilter={activeCycle}
          selectedRunId={selectedRun?.runId}
          onSelect={selectRun}
        />
      </div>
    );
  }

  return (
    <div className="app" data-inspector={selectedRun ? "open" : undefined}>
      <Header
        sessions={sessions?.sessions ?? []}
        selectedId={sessionId}
        onSelectSession={selectSession}
        connection={connection}
        view={view}
        ticking={ticking}
      />
      <main className="main">
        {body}
        {selectedRun && (
          <Inspector
            run={selectedRun}
            rev={selectedRun.rev}
            onClose={closeInspector}
          />
        )}
      </main>
    </div>
  );
};
