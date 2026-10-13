import { ArrowDownIcon } from "@phosphor-icons/react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { LogEntry, LogKind, RunView } from "../../projection.js";
import { formatCount, formatOffset } from "../format.js";

type Filter = "all" | "agent" | "tools" | "lifecycle";

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agent" },
  { id: "tools", label: "Tools" },
  { id: "lifecycle", label: "Lifecycle" },
];

const FILTER_KINDS: Readonly<Record<Filter, ReadonlySet<LogKind> | undefined>> =
  {
    all: undefined,
    agent: new Set(["text", "output"]),
    tools: new Set(["tool"]),
    lifecycle: new Set(["lifecycle", "commit", "warn", "error"]),
  };

/** Rendered rows per page; older entries load on demand. */
const PAGE = 400;
/** Tool arguments longer than this collapse behind a disclosure. */
const LONG_DETAIL_CHARS = 160;
/** Distance from the bottom (px) that still counts as "at the bottom". */
const BOTTOM_SLACK = 24;

const isLong = (s: string) =>
  s.length > LONG_DETAIL_CHARS || s.split("\n", 4).length > 3;

const LogRow = memo(function LogRow({
  entry,
  runStart,
}: {
  entry: LogEntry;
  runStart: number;
}) {
  return (
    <li className="log-row" data-kind={entry.kind}>
      <span className="log-time num">{formatOffset(entry.at - runStart)}</span>
      <span className="log-iter num">
        {entry.iteration !== undefined ? `i${entry.iteration}` : ""}
      </span>
      <div className="log-body">
        <LogContent entry={entry} />
      </div>
    </li>
  );
});

const LogContent = ({ entry }: { entry: LogEntry }) => {
  switch (entry.kind) {
    case "text":
      return <p className="log-text">{entry.text}</p>;
    case "tool": {
      const detail = entry.detail ?? "";
      if (detail && isLong(detail)) {
        return (
          <details className="log-details">
            <summary>
              <strong>{entry.text}</strong>{" "}
              <span className="mono">{detail.split("\n", 1)[0]}</span>
            </summary>
            <pre className="mono">{detail}</pre>
          </details>
        );
      }
      return (
        <p className="log-tool">
          <strong>{entry.text}</strong> <span className="mono">{detail}</span>
        </p>
      );
    }
    case "commit":
      return (
        <p className="log-commit">
          Commit{" "}
          <span className="mono" title={entry.detail}>
            {(entry.detail ?? entry.text).slice(0, 12)}
          </span>
        </p>
      );
    case "output":
      return (
        <details className="log-details">
          <summary>{entry.text}</summary>
          {entry.detail !== undefined && (
            <pre className="mono">{entry.detail}</pre>
          )}
        </details>
      );
    default:
      return (
        <p className="log-line">
          {entry.text}
          {entry.detail !== undefined && (
            <span className="log-detail mono">{entry.detail}</span>
          )}
        </p>
      );
  }
};

export const LogView = ({ run }: { run: RunView; rev: number }) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [pages, setPages] = useState(1);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const kinds = FILTER_KINDS[filter];
  const entries = kinds ? run.log.filter((e) => kinds.has(e.kind)) : run.log;
  const limit = pages * PAGE;
  const hidden = Math.max(0, entries.length - limit);
  const shown = hidden > 0 ? entries.slice(hidden) : entries;
  const lastSeq = shown.at(-1)?.seq;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [follow, lastSeq, shown.length, filter]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (atBottom !== follow) setFollow(atBottom);
  };

  return (
    <div className="log">
      <div className="log-toolbar">
        <div className="segmented" role="group" aria-label="Filter log">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.id}
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setFollow(true);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="panel-meta num">
          {formatCount(entries.length)} entries
        </span>
      </div>
      <div className="log-scroll" ref={scroller} onScroll={onScroll}>
        {run.logDropped > 0 && (
          <p className="log-note num">
            {formatCount(run.logDropped)} earlier entries dropped
          </p>
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="log-more"
            onClick={() => {
              setFollow(false);
              setPages((p) => p + 1);
            }}
          >
            Show {formatCount(Math.min(hidden, PAGE))} earlier of{" "}
            {formatCount(hidden)}
          </button>
        )}
        {shown.length === 0 ? (
          <p className="log-note">No entries yet</p>
        ) : (
          <ol className="log-list">
            {shown.map((e) => (
              <LogRow
                key={`${e.seq}:${e.kind}:${e.at}`}
                entry={e}
                runStart={run.startedAt}
              />
            ))}
          </ol>
        )}
      </div>
      {!follow && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => setFollow(true)}
        >
          <ArrowDownIcon size={12} weight="bold" aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  );
};
