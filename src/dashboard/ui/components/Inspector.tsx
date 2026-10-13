import {
  CheckCircleIcon,
  CircleNotchIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import {
  TERMINAL_STATES,
  runTitle,
  totalTokens,
  type RunView,
  type SetupStep,
} from "../../projection.js";
import {
  formatCount,
  formatMs,
  formatTokens,
  formatWallClock,
} from "../format.js";
import { useNow } from "../store.js";
import { CopyButton, Elapsed, StateBadge } from "./common.js";
import { LogView } from "./LogView.js";

type Tab = "log" | "setup" | "iterations" | "output";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "log", label: "Log" },
  { id: "setup", label: "Setup" },
  { id: "iterations", label: "Iterations" },
  { id: "output", label: "Output" },
];

export interface InspectorProps {
  readonly run: RunView;
  readonly rev: number;
  readonly onClose: () => void;
}

const Field = ({
  label,
  children,
  mono,
  copy,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  copy?: string;
}) => (
  <div className="field">
    <dt>{label}</dt>
    <dd className={mono ? "mono" : undefined}>
      <span className="field-value" title={copy}>
        {children}
      </span>
      {copy !== undefined && <CopyButton text={copy} label={`Copy ${label}`} />}
    </dd>
  </div>
);

export const Inspector = ({ run, onClose }: InspectorProps) => {
  const [tab, setTab] = useState<Tab>("log");
  const terminal = TERMINAL_STATES.has(run.state);
  const title = runTitle(run);
  const labels = Object.entries(run.labels);

  return (
    <aside className="inspector" aria-label={`Run ${title}`}>
      <header className="inspector-head">
        <div className="inspector-title-row">
          <h2 className="inspector-title" title={title}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close (Esc)"
          >
            <XIcon size={16} weight="bold" aria-hidden />
          </button>
        </div>
        <div className="inspector-state">
          <StateBadge state={run.state} />
          <Elapsed
            start={run.startedAt}
            end={terminal ? (run.endedAt ?? run.lastEventAt) : undefined}
          />
          <span className="num inspector-meta">
            started {formatWallClock(run.startedAt)}
          </span>
        </div>
        <dl className="fields">
          <Field label="Agent">
            {run.agent}
            {run.model !== undefined && (
              <span className="mono field-sub"> {run.model}</span>
            )}
          </Field>
          <Field label="Sandbox">{run.sandbox}</Field>
          <Field label="Branch strategy">{run.branchStrategy}</Field>
          {run.branch !== undefined && (
            <Field label="Branch" mono copy={run.branch}>
              {run.branch}
            </Field>
          )}
          {run.worktreePath !== undefined && (
            <Field label="Worktree" mono copy={run.worktreePath}>
              {run.worktreePath}
            </Field>
          )}
          {run.pid !== undefined && (
            <Field label="PID" mono>
              {run.pid}
            </Field>
          )}
          {labels.length > 0 && (
            <Field label="Labels" mono>
              {labels.map(([k, v]) => `${k}=${String(v)}`).join("  ")}
            </Field>
          )}
        </dl>
      </header>
      <div className="tabs" role="tablist" aria-label="Run details">
        {TABS.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "setup" && run.setup.length > 0 && (
              <span className="tab-count num">{run.setup.length}</span>
            )}
            {t.id === "iterations" && run.iterations.length > 0 && (
              <span className="tab-count num">{run.iterations.length}</span>
            )}
          </button>
        ))}
      </div>
      <div
        className="tab-panel"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "log" && <LogView key={run.runId} run={run} rev={run.rev} />}
        {tab === "setup" && <SetupTab run={run} />}
        {tab === "iterations" && <IterationsTab run={run} />}
        {tab === "output" && <OutputTab run={run} />}
      </div>
    </aside>
  );
};

const stepDuration = (step: SetupStep, now: number): number =>
  step.durationMs ?? (step.end ?? now) - step.start;

const SETUP_KINDS = {
  worktree: "Worktree",
  copy: "Copy",
  sandbox: "Sandbox",
  hook: "Hook",
} as const;

const SetupTab = ({ run }: { run: RunView }) => {
  const running = run.setup.some((s) => s.ok === undefined);
  const now = useNow(running && !TERMINAL_STATES.has(run.state));
  if (run.setup.length === 0) {
    return <p className="tab-empty">No setup steps recorded</p>;
  }
  const max = Math.max(1, ...run.setup.map((s) => stepDuration(s, now)));
  return (
    <ol className="setup-list">
      {run.setup.map((step, i) => {
        const dur = stepDuration(step, now);
        const status =
          step.ok === undefined ? "running" : step.ok ? "ok" : "failed";
        return (
          <li className="setup-step" data-status={status} key={i}>
            <span className="setup-icon" aria-label={status}>
              {status === "running" ? (
                <CircleNotchIcon size={14} weight="bold" />
              ) : status === "ok" ? (
                <CheckCircleIcon size={14} weight="bold" />
              ) : (
                <XCircleIcon size={14} weight="bold" />
              )}
            </span>
            <div className="setup-main">
              <div className="setup-line">
                <span className="setup-kind">{SETUP_KINDS[step.kind]}</span>
                <span className="setup-label" title={step.label}>
                  {step.label}
                </span>
                {step.reused && <span className="setup-tag">reused</span>}
                <span className="num setup-dur">{formatMs(dur)}</span>
              </div>
              <div className="setup-bar" aria-hidden>
                <span style={{ width: `${(dur / max) * 100}%` }} />
              </div>
              {step.detail !== undefined && (
                <div className="setup-detail mono" title={step.detail}>
                  {step.detail}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
};

const IterationsTab = ({ run }: { run: RunView }) => {
  const now = useNow(!TERMINAL_STATES.has(run.state));
  if (run.iterations.length === 0) {
    return <p className="tab-empty">No iterations yet</p>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Duration</th>
            <th>Tools</th>
            <th>Commits</th>
            <th title="Input tokens">In</th>
            <th title="Cache read tokens">Cache rd</th>
            <th title="Cache write tokens">Cache wr</th>
            <th title="Output tokens">Out</th>
          </tr>
        </thead>
        <tbody>
          {run.iterations.map((it) => (
            <tr key={it.iteration}>
              <td>{it.iteration}</td>
              <td>
                {formatMs(
                  (it.end ??
                    (TERMINAL_STATES.has(run.state) ? run.lastEventAt : now)) -
                    it.start,
                )}
              </td>
              <td>{formatCount(it.toolCalls)}</td>
              <td>{formatCount(it.commits)}</td>
              <td>{it.usage ? formatTokens(it.usage.inputTokens) : "-"}</td>
              <td>
                {it.usage ? formatTokens(it.usage.cacheReadInputTokens) : "-"}
              </td>
              <td>
                {it.usage
                  ? formatTokens(it.usage.cacheCreationInputTokens)
                  : "-"}
              </td>
              <td>{it.usage ? formatTokens(it.usage.outputTokens) : "-"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>All</td>
            <td />
            <td>{formatCount(run.toolCalls)}</td>
            <td>{formatCount(run.commits.length)}</td>
            <td>{formatTokens(run.usage.inputTokens)}</td>
            <td>{formatTokens(run.usage.cacheReadInputTokens)}</td>
            <td>{formatTokens(run.usage.cacheCreationInputTokens)}</td>
            <td>{formatTokens(run.usage.outputTokens)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="tab-note num">
        {formatTokens(totalTokens(run.usage))} tokens total
      </p>
    </div>
  );
};

const stringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const OutputTab = ({ run }: { run: RunView }) => {
  const nothing =
    !run.structuredOutput &&
    run.completionSignal === undefined &&
    !run.error &&
    run.preservedWorktreePath === undefined &&
    run.commits.length === 0;
  if (nothing) {
    return <p className="tab-empty">No output yet</p>;
  }
  return (
    <div className="output">
      {run.error && (
        <section className="output-block" data-tone="error">
          <h3>{run.error.aborted ? "Aborted" : (run.error.tag ?? "Error")}</h3>
          <pre className="mono">{run.error.message}</pre>
        </section>
      )}
      {run.completionSignal !== undefined && (
        <section className="output-block">
          <h3>Completion signal</h3>
          <p className="mono">{run.completionSignal}</p>
        </section>
      )}
      {run.structuredOutput && (
        <section className="output-block">
          <h3>
            Structured output{" "}
            <span className="mono">&lt;{run.structuredOutput.tag}&gt;</span>
          </h3>
          <pre className="mono">{stringify(run.structuredOutput.value)}</pre>
        </section>
      )}
      {run.commits.length > 0 && (
        <section className="output-block">
          <h3>Commits</h3>
          <ul className="commit-list">
            {run.commits.map((c) => (
              <li key={c.sha}>
                <span className="mono commit-sha">{c.sha.slice(0, 12)}</span>
                <span className="num">i{c.iteration}</span>
                <span className="num">{formatWallClock(c.at)}</span>
                <CopyButton text={c.sha} label="Copy commit sha" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.preservedWorktreePath !== undefined && (
        <section className="output-block">
          <h3>Preserved worktree</h3>
          <p className="mono output-path">
            <span>{run.preservedWorktreePath}</span>
            <CopyButton
              text={run.preservedWorktreePath}
              label="Copy worktree path"
            />
          </p>
        </section>
      )}
    </div>
  );
};
