import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Fragment, memo, useState } from "react";
import {
  STATE_LABELS,
  formatDuration,
  formatOffset,
  formatWallClock,
  ticks,
} from "../format.js";
import {
  TERMINAL_STATES,
  runTitle,
  stationRuns,
  type RunView,
  type SessionView,
} from "../../projection.js";
import { useNow } from "../store.js";

export interface TimelineProps {
  readonly view: SessionView;
  /** True while the session is live; the axis then extends to now. */
  readonly live: boolean;
  readonly cycleFilter?: string;
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string) => void;
}

type Zoom = "fit" | "recent";
const RECENT_MS = 5 * 60_000;

interface Axis {
  readonly from: number;
  readonly to: number;
  /** Where open segments end: now while live, else the last event. */
  readonly end: number;
}

const pct = (axis: Axis, t: number): number =>
  ((t - axis.from) / (axis.to - axis.from)) * 100;

const Row = memo(function Row({
  run,
  axis,
  selected,
  onSelect,
}: {
  run: RunView;
  rev: number;
  axis: Axis;
  selected: boolean;
  onSelect: (runId: string) => void;
}) {
  const title = runTitle(run);
  return (
    <button
      type="button"
      className="gantt-row"
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={() => onSelect(run.runId)}
    >
      <span className="gantt-label" title={title}>
        <span className="gantt-label-dot" data-state={run.state} aria-hidden />
        <span className="gantt-label-text">{title}</span>
      </span>
      <span className="gantt-track">
        {run.segments.map((seg, i) => {
          const end = seg.end ?? axis.end;
          if (end < axis.from || seg.start > axis.to) return null;
          const terminal = TERMINAL_STATES.has(seg.state);
          const left = Math.max(0, pct(axis, seg.start));
          const right = Math.min(100, pct(axis, end));
          const label = `${STATE_LABELS[seg.state]} ${formatDuration(end - seg.start)}`;
          return (
            <span
              key={i}
              className={terminal ? "gantt-cap" : "gantt-seg"}
              data-state={seg.state}
              style={
                terminal
                  ? { left: `${left}%` }
                  : { left: `${left}%`, width: `${Math.max(0, right - left)}%` }
              }
              title={terminal ? STATE_LABELS[seg.state] : label}
            />
          );
        })}
        {run.commits.map((c) =>
          c.at < axis.from || c.at > axis.to ? null : (
            <span
              key={c.sha}
              className="gantt-commit"
              style={{ left: `${pct(axis, c.at)}%` }}
              title={`Commit ${c.sha.slice(0, 7)}`}
            />
          ),
        )}
      </span>
    </button>
  );
});

export const Timeline = ({
  view,
  live,
  cycleFilter,
  selectedRunId,
  onSelect,
}: TimelineProps) => {
  const [open, setOpen] = useState(true);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const ticking = open && live && view.totals.active > 0;
  const now = useNow(ticking);

  const start = view.startedAt ?? now;
  const last = view.lastEventAt ?? start;
  const end = ticking ? Math.max(now, last) : last;
  const from = zoom === "recent" ? Math.max(start, end - RECENT_MS) : start;
  const span = Math.max(end - from, 10_000);
  // A little headroom so the newest activity is not glued to the edge.
  const axis: Axis = { from, to: from + span * 1.03, end };
  const tickList = ticks(0, axis.to - start, 8).filter(
    (t) => start + t >= from,
  );

  return (
    <section
      className="timeline"
      data-open={open || undefined}
      aria-label="Timeline"
    >
      <header className="panel-head">
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <CaretDownIcon size={12} weight="bold" aria-hidden />
          ) : (
            <CaretRightIcon size={12} weight="bold" aria-hidden />
          )}
          <h2 className="panel-title">Timeline</h2>
        </button>
        <span className="panel-meta num">
          {formatWallClock(start)} to {formatWallClock(end)}
        </span>
        {open && (
          <div className="segmented" role="group" aria-label="Time range">
            <button
              type="button"
              aria-pressed={zoom === "fit"}
              onClick={() => setZoom("fit")}
            >
              Fit
            </button>
            <button
              type="button"
              aria-pressed={zoom === "recent"}
              onClick={() => setZoom("recent")}
            >
              Last 5 min
            </button>
          </div>
        )}
      </header>
      {open && (
        <div className="gantt">
          <div className="gantt-axis" aria-hidden>
            <span className="gantt-label" />
            <span className="gantt-track">
              {tickList.map((t) => (
                <span
                  key={t}
                  className="gantt-tick num"
                  style={{ left: `${pct(axis, start + t)}%` }}
                  title={formatWallClock(start + t)}
                >
                  {formatOffset(t)}
                </span>
              ))}
            </span>
          </div>
          <div className="gantt-body">
            <div className="gantt-grid" aria-hidden>
              <span className="gantt-label" />
              <span className="gantt-track">
                {tickList.map((t) => (
                  <span
                    key={t}
                    className="gantt-gridline"
                    style={{ left: `${pct(axis, start + t)}%` }}
                  />
                ))}
                {ticking && (
                  <span
                    className="gantt-now"
                    style={{ left: `${pct(axis, now)}%` }}
                    title={`Now ${formatWallClock(now)}`}
                  />
                )}
              </span>
            </div>
            {view.stations.map((station) => {
              const runs = stationRuns(view, station, cycleFilter);
              if (runs.length === 0) return null;
              return (
                <Fragment key={station.phase}>
                  <div className="gantt-group">{station.phase}</div>
                  {runs.map((run) => (
                    <Row
                      key={run.runId}
                      run={run}
                      rev={run.rev}
                      axis={axis}
                      selected={run.runId === selectedRunId}
                      onSelect={onSelect}
                    />
                  ))}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
