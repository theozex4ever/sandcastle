import { ArrowRightIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import type { SessionView } from "../../projection.js";
import { Station, cycleLabel } from "./Station.js";

export interface FactoryFloorProps {
  readonly view: SessionView;
  readonly cycleFilter?: string;
  readonly onCycleFilter: (cycle: string | undefined) => void;
  readonly selectedRunId?: string;
  readonly hoverIssue?: string;
  readonly onSelect: (runId: string) => void;
  readonly onHoverIssue: (issue: string | undefined) => void;
}

export const FactoryFloor = ({
  view,
  cycleFilter,
  onCycleFilter,
  selectedRunId,
  hoverIssue,
  onSelect,
  onHoverIssue,
}: FactoryFloorProps) => (
  <section className="floor" aria-label="Factory floor">
    <header className="panel-head">
      <h1 className="panel-title">Factory floor</h1>
      <span className="panel-meta num">
        {view.stations.length} station{view.stations.length === 1 ? "" : "s"}
      </span>
      {view.cycles.length > 1 && (
        <div className="segmented" role="group" aria-label="Filter by cycle">
          <button
            type="button"
            aria-pressed={cycleFilter === undefined}
            onClick={() => onCycleFilter(undefined)}
          >
            All
          </button>
          {view.cycles.map((c) => (
            <button
              type="button"
              key={c}
              aria-pressed={cycleFilter === c}
              onClick={() => onCycleFilter(c)}
            >
              {cycleLabel(c)}
            </button>
          ))}
        </div>
      )}
    </header>
    <div className="line">
      {view.stations.map((station, i) => (
        <Fragment key={station.phase}>
          {i > 0 && (
            <div className="line-link" aria-hidden>
              <ArrowRightIcon size={12} weight="bold" />
            </div>
          )}
          <Station
            view={view}
            station={station}
            cycleFilter={cycleFilter}
            selectedRunId={selectedRunId}
            hoverIssue={hoverIssue}
            onSelect={onSelect}
            onHoverIssue={onHoverIssue}
          />
        </Fragment>
      ))}
    </div>
  </section>
);
