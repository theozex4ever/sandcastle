import { GitCommitIcon } from "@phosphor-icons/react";
import { memo } from "react";
import {
  TERMINAL_STATES,
  runTitle,
  totalTokens,
  type RunView,
} from "../../projection.js";
import { formatClock, formatDuration, formatTokens } from "../format.js";
import { useNow } from "../store.js";
import { Elapsed, StateBadge } from "./common.js";

export interface RunTileProps {
  readonly run: RunView;
  /** `run.rev`, passed so memoisation sees in-place mutations. */
  readonly rev: number;
  readonly selected: boolean;
  readonly linked: boolean;
  readonly onSelect: (runId: string) => void;
  readonly onHoverIssue: (issue: string | undefined) => void;
}

const SETUP_KIND_LABELS = {
  worktree: "Worktree",
  copy: "Copying files",
  sandbox: "Starting sandbox",
  hook: "Hook",
} as const;

/** "quiet 3m" plus a countdown to the idle timeout. Ticks every second. */
const QuietLine = ({ idle }: { idle: NonNullable<RunView["idle"]> }) => {
  const now = useNow(true);
  const { silentSince } = idle;
  const timeoutAt = silentSince + idle.timeoutSeconds * 1000;
  const left = timeoutAt - now;
  return (
    <span className="tile-activity tile-activity-quiet">
      <span className="num">quiet {formatDuration(now - silentSince)}</span>
      <span className="num tile-activity-sub">
        {left > 0 ? `idle timeout in ${formatClock(left)}` : "idle timeout due"}
      </span>
    </span>
  );
};

const Activity = ({ run }: { run: RunView }) => {
  if (run.state === "failed" && run.error) {
    const tag = run.error.aborted ? "Aborted" : (run.error.tag ?? "Error");
    const firstLine = run.error.message.split("\n", 1)[0] ?? "";
    return (
      <span
        className="tile-activity tile-activity-error"
        title={run.error.message}
      >
        <strong>{tag}</strong> {firstLine}
      </span>
    );
  }
  if (run.state === "lost") {
    return (
      <span className="tile-activity tile-activity-dim">
        process exited while {run.lastLiveState}
      </span>
    );
  }
  if (run.state === "done") {
    // The agent's last line here is usually a completion tag; summarise the outcome instead.
    const n = run.commits.length;
    const parts = [
      `${run.iterations.length} iteration${run.iterations.length === 1 ? "" : "s"}`,
      `${n} commit${n === 1 ? "" : "s"}`,
    ];
    if (run.structuredOutput)
      parts.push(`<${run.structuredOutput.tag}> output`);
    return (
      <span className="tile-activity tile-activity-dim">
        Finished: {parts.join(", ")}
      </span>
    );
  }
  if (run.state === "quiet" && run.idle) {
    return <QuietLine idle={run.idle} />;
  }
  if (run.state === "provisioning" || run.state === "setup") {
    const step = [...run.setup].reverse().find((s) => s.end === undefined);
    const text = step
      ? `${SETUP_KIND_LABELS[step.kind]}: ${step.label}`
      : run.state === "provisioning"
        ? "Preparing worktree and sandbox"
        : "Running setup";
    return (
      <span className="tile-activity tile-activity-dim" title={step?.detail}>
        {text}
      </span>
    );
  }
  const act = run.lastActivity;
  if (!act) {
    return (
      <span className="tile-activity tile-activity-dim">No output yet</span>
    );
  }
  if (act.kind === "tool") {
    const space = act.text.indexOf(" ");
    const name = space === -1 ? act.text : act.text.slice(0, space);
    const args = space === -1 ? "" : act.text.slice(space + 1);
    return (
      <span className="tile-activity tile-activity-tool" title={act.text}>
        <strong>{name}</strong> <span className="mono">{args}</span>
      </span>
    );
  }
  return (
    <span className="tile-activity tile-activity-text" title={act.text}>
      {act.text}
    </span>
  );
};

export const RunTile = memo(function RunTile({
  run,
  selected,
  linked,
  onSelect,
  onHoverIssue,
}: RunTileProps) {
  const terminal = TERMINAL_STATES.has(run.state);
  const title = runTitle(run);
  const tokens = totalTokens(run.usage);
  const hover = () => onHoverIssue(run.issue);
  const unhover = () => onHoverIssue(undefined);
  return (
    <button
      type="button"
      className="tile"
      data-state={run.state}
      data-selected={selected || undefined}
      data-linked={linked || undefined}
      data-run-id={run.runId}
      aria-pressed={selected}
      onClick={() => onSelect(run.runId)}
      onMouseEnter={hover}
      onMouseLeave={unhover}
      onFocus={hover}
      onBlur={unhover}
    >
      <span className="tile-head">
        <StateBadge state={run.state} />
        <Elapsed
          start={run.startedAt}
          end={terminal ? (run.endedAt ?? run.lastEventAt) : undefined}
          className="tile-elapsed"
        />
      </span>
      <span className="tile-title" title={title}>
        {title}
      </span>
      {run.branch !== undefined && (
        <span className="tile-branch mono" title={run.branch}>
          {run.branch}
        </span>
      )}
      <Activity run={run} />
      <span className="tile-meta num">
        <span title="Iteration">
          iter {run.iteration}/{run.maxIterations}
        </span>
        <span title="Commits" className="tile-meta-commits">
          <GitCommitIcon size={12} weight="bold" aria-hidden />
          {run.commits.length}
        </span>
        {tokens > 0 && <span title="Tokens">{formatTokens(tokens)} tok</span>}
      </span>
    </button>
  );
});
