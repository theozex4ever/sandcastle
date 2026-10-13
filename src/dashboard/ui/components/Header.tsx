import { ArrowsClockwiseIcon, WarningIcon } from "@phosphor-icons/react";
import { totalTokens, type SessionView } from "../../projection.js";
import type { SessionSummary } from "../../protocol.js";
import { formatClock, formatCount, formatTokens } from "../format.js";
import { useNow, type StreamStatus } from "../store.js";
import { SessionPicker } from "./SessionPicker.js";

export type Connection =
  | { kind: "none" }
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "ended" }
  | { kind: "reconnecting" }
  | { kind: "failed" };

export const connectionOf = (
  status: StreamStatus | undefined,
  live: boolean,
): Connection => {
  switch (status) {
    case undefined:
      return { kind: "none" };
    case "connecting":
      return { kind: "connecting" };
    case "reconnecting":
      return { kind: "reconnecting" };
    case "failed":
      return { kind: "failed" };
    case "open":
      return live ? { kind: "live" } : { kind: "ended" };
  }
};

const ConnectionState = ({ connection }: { connection: Connection }) => {
  switch (connection.kind) {
    case "none":
      return null;
    case "connecting":
      return (
        <span className="conn" data-kind="connecting">
          <ArrowsClockwiseIcon size={13} weight="bold" aria-hidden />
          Loading
        </span>
      );
    case "live":
      return (
        <span className="conn" data-kind="live">
          <span className="live-dot" aria-hidden />
          Live
        </span>
      );
    case "ended":
      return (
        <span className="conn" data-kind="ended" title="The session has ended">
          Replayed
          <span className="conn-sub">session ended</span>
        </span>
      );
    case "reconnecting":
      return (
        <span className="conn" data-kind="reconnecting" role="status">
          <WarningIcon size={13} weight="bold" aria-hidden />
          Reconnecting
        </span>
      );
    case "failed":
      return (
        <span className="conn" data-kind="failed">
          <WarningIcon size={13} weight="bold" aria-hidden />
          Unavailable
        </span>
      );
  }
};

const SessionClock = ({
  start,
  end,
  ticking,
}: {
  start: number;
  end: number;
  ticking: boolean;
}) => {
  const now = useNow(ticking);
  return (
    <span className="stat" title="Session elapsed">
      <span className="stat-label">Elapsed</span>
      <span className="stat-value num">
        {formatClock((ticking ? Math.max(now, end) : end) - start)}
      </span>
    </span>
  );
};

const Stat = ({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "accent" | "ok" | "bad";
  title?: string;
}) => (
  <span className="stat" data-tone={tone} title={title}>
    <span className="stat-label">{label}</span>
    <span className="stat-value num">{value}</span>
  </span>
);

export interface HeaderProps {
  readonly sessions: readonly SessionSummary[];
  readonly selectedId?: string;
  readonly onSelectSession: (id: string) => void;
  readonly connection: Connection;
  /** Present once a session's backlog has loaded. */
  readonly view?: SessionView;
  /** True while any run in a live session is still active. */
  readonly ticking: boolean;
}

export const Header = ({
  sessions,
  selectedId,
  onSelectSession,
  connection,
  view,
  ticking,
}: HeaderProps) => {
  const t = view?.totals;
  return (
    <header className="topbar">
      <span className="wordmark">Sandcastle</span>
      <SessionPicker
        sessions={sessions}
        selectedId={selectedId}
        onSelect={onSelectSession}
      />
      <ConnectionState connection={connection} />
      {view?.startedAt !== undefined && t && (
        <div className="stats">
          <SessionClock
            start={view.startedAt}
            end={view.lastEventAt ?? view.startedAt}
            ticking={ticking}
          />
          <Stat
            label="Active"
            value={formatCount(t.active)}
            tone={t.active > 0 ? "accent" : undefined}
          />
          <Stat label="Done" value={formatCount(t.done)} tone="ok" />
          <Stat
            label="Failed"
            value={formatCount(t.failed + t.lost)}
            tone={t.failed + t.lost > 0 ? "bad" : undefined}
            title={
              t.lost > 0 ? `${t.failed} failed, ${t.lost} lost` : undefined
            }
          />
          <Stat label="Commits" value={formatCount(t.commits)} />
          <Stat label="Tool calls" value={formatCount(t.toolCalls)} />
          <Stat
            label="Tokens"
            value={formatTokens(totalTokens(t.usage))}
            title={`${formatCount(totalTokens(t.usage))} tokens`}
          />
        </div>
      )}
    </header>
  );
};
