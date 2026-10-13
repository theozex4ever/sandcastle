import { CaretDownIcon } from "@phosphor-icons/react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SessionSummary } from "../../protocol.js";
import { formatAgo, formatStartTime } from "../format.js";

export interface SessionPickerProps {
  readonly sessions: readonly SessionSummary[];
  readonly selectedId?: string;
  readonly onSelect: (sessionId: string) => void;
}

const startOf = (s: SessionSummary) => s.firstEventAt ?? s.modifiedAt;

const SessionLine = ({
  session,
  now,
}: {
  session: SessionSummary;
  now: number;
}) => (
  <>
    <span className="picker-main">
      {session.live && (
        <span className="live-dot" title="Live" aria-label="Live" />
      )}
      <span className="num">{formatStartTime(startOf(session), now)}</span>
      {session.demo && <span className="tag">demo</span>}
    </span>
    <span className="picker-sub num">
      {session.runs} run{session.runs === 1 ? "" : "s"}
      {session.phases.length > 0 && `: ${session.phases.join(", ")}`}
    </span>
  </>
);

export const SessionPicker = ({
  sessions,
  selectedId,
  onSelect,
}: SessionPickerProps) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const now = Date.now();
  const selected = sessions.find((s) => s.sessionId === selectedId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        root.current
          ?.querySelector<HTMLButtonElement>(".picker-button")
          ?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    list.current
      ?.querySelector<HTMLButtonElement>('[aria-selected="true"], button')
      ?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      items[
        (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
      ];
    next?.focus();
  };

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={selectedId}
      >
        {selected ? (
          <SessionLine session={selected} now={now} />
        ) : (
          <span className="picker-main">
            {selectedId ?? "Select a session"}
          </span>
        )}
        <CaretDownIcon size={12} weight="bold" aria-hidden />
      </button>
      {open && (
        <ul
          className="picker-menu"
          role="listbox"
          aria-label="Sessions"
          ref={list}
          onKeyDown={onListKey}
        >
          {sessions.length === 0 && (
            <li className="picker-empty">No sessions</li>
          )}
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                role="option"
                aria-selected={s.sessionId === selectedId}
                onClick={() => {
                  onSelect(s.sessionId);
                  setOpen(false);
                }}
              >
                <SessionLine session={s} now={now} />
                <span className="picker-id mono" title={s.sessionId}>
                  {s.sessionId}
                  {s.lastEventAt !== undefined &&
                    ` | last event ${formatAgo(now - s.lastEventAt)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
