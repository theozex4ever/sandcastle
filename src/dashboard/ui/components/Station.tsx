import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  TERMINAL_STATES,
  stationRuns,
  type RunState,
  type RunView,
  type SessionView,
  type StationView,
} from "../../projection.js";
import { formatStateCounts } from "../format.js";
import { RunTile } from "./RunTile.js";

export interface StationProps {
  readonly view: SessionView;
  readonly station: StationView;
  readonly cycleFilter?: string;
  readonly selectedRunId?: string;
  readonly hoverIssue?: string;
  readonly onSelect: (runId: string) => void;
  readonly onHoverIssue: (issue: string | undefined) => void;
}

const countStates = (runs: readonly RunView[]) => {
  const counts: Partial<Record<RunState, number>> = {};
  for (const r of runs) counts[r.state] = (counts[r.state] ?? 0) + 1;
  return counts;
};

export const cycleLabel = (cycle: string): string =>
  /^\d+$/.test(cycle) ? `Cycle ${cycle}` : cycle;

interface CycleGroup {
  readonly cycle?: string;
  readonly runs: RunView[];
}

/** Group runs by cycle, most recent cycle first; unlabelled runs last. */
const groupByCycle = (view: SessionView, runs: RunView[]): CycleGroup[] => {
  const byCycle = new Map<string | undefined, RunView[]>();
  for (const r of runs) {
    const list = byCycle.get(r.cycle) ?? [];
    list.push(r);
    byCycle.set(r.cycle, list);
  }
  const order = [...view.cycles].reverse();
  const groups: CycleGroup[] = [];
  for (const c of order) {
    const list = byCycle.get(c);
    if (list) groups.push({ cycle: c, runs: list });
  }
  const none = byCycle.get(undefined);
  if (none) groups.push({ cycle: undefined, runs: none });
  return groups;
};

export const Station = ({
  view,
  station,
  cycleFilter,
  selectedRunId,
  hoverIssue,
  onSelect,
  onHoverIssue,
}: StationProps) => {
  const runs = stationRuns(view, station, cycleFilter);
  const groups = groupByCycle(view, runs);
  // Explicit user toggles, keyed by cycle; otherwise the default applies.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const showHeaders = groups.some((g) => g.cycle !== undefined);

  return (
    <section className="station" aria-label={`Station ${station.phase}`}>
      <header className="station-head">
        <h2 className="station-name">{station.phase}</h2>
        <span className="station-count num">{runs.length}</span>
        <span className="station-summary">
          {formatStateCounts(countStates(runs))}
        </span>
      </header>
      <div className="station-body">
        {runs.length === 0 && (
          <p className="station-empty">No runs in this cycle</p>
        )}
        {groups.map((group, i) => {
          const key = group.cycle ?? "";
          const hasActive = group.runs.some(
            (r) => !TERMINAL_STATES.has(r.state) || r.runId === selectedRunId,
          );
          const defaultOpen = i === 0 || hasActive || cycleFilter !== undefined;
          const open = toggled[key] ?? defaultOpen;
          return (
            <div className="cycle-group" key={key}>
              {showHeaders && (
                <button
                  type="button"
                  className="cycle-head"
                  aria-expanded={open}
                  onClick={() => setToggled((t) => ({ ...t, [key]: !open }))}
                >
                  {open ? (
                    <CaretDownIcon size={12} weight="bold" aria-hidden />
                  ) : (
                    <CaretRightIcon size={12} weight="bold" aria-hidden />
                  )}
                  <span className="cycle-name">
                    {group.cycle === undefined
                      ? "No cycle"
                      : cycleLabel(group.cycle)}
                  </span>
                  {!open && (
                    <span className="cycle-summary">
                      {formatStateCounts(countStates(group.runs))}
                    </span>
                  )}
                </button>
              )}
              {open &&
                group.runs.map((run) => (
                  <RunTile
                    key={run.runId}
                    run={run}
                    rev={run.rev}
                    selected={run.runId === selectedRunId}
                    linked={
                      hoverIssue !== undefined && run.issue === hoverIssue
                    }
                    onSelect={onSelect}
                    onHoverIssue={onHoverIssue}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
};
