import { TerminalWindowIcon, WarningIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** Loading placeholder shaped like the floor and timeline. */
export const Skeleton = () => (
  <div className="skeleton" aria-busy="true" aria-label="Loading session">
    <div className="floor">
      <div className="panel-head">
        <span className="sk sk-text" style={{ width: 96 }} />
      </div>
      <div className="line">
        {[3, 2, 2, 1].map((tiles, i) => (
          <section className="station" key={i}>
            <div className="station-head">
              <span className="sk sk-text" style={{ width: 72 }} />
              <span className="sk sk-text" style={{ width: 110 }} />
            </div>
            <div className="station-body">
              {Array.from({ length: tiles }, (_, j) => (
                <span className="sk sk-tile" key={j} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
    <div className="timeline" data-open>
      <div className="panel-head">
        <span className="sk sk-text" style={{ width: 72 }} />
      </div>
      <div className="gantt">
        {Array.from({ length: 5 }, (_, i) => (
          <div className="sk-row" key={i}>
            <span className="sk sk-text" style={{ width: 120 }} />
            <span
              className="sk sk-bar"
              style={{ marginLeft: `${i * 9}%`, width: `${30 + i * 8}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  </div>
);

export const Message = ({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "error";
  children?: ReactNode;
}) => (
  <div className="message" data-tone={tone} role={tone ? "alert" : undefined}>
    <div className="message-inner">
      <h1 className="message-title">
        {tone === "error" ? (
          <WarningIcon size={16} weight="bold" aria-hidden />
        ) : (
          <TerminalWindowIcon size={16} weight="bold" aria-hidden />
        )}
        {title}
      </h1>
      {children}
    </div>
  </div>
);

export const NoSessions = ({ eventsDir }: { eventsDir: string }) => (
  <Message title="No run sessions yet">
    <p>
      Run a Sandcastle script with run events enabled. Each session appears here
      as soon as it writes its first event.
    </p>
    <p>To see the dashboard with sample data, start it in demo mode:</p>
    <pre className="mono">sandcastle dashboard --demo</pre>
    <dl className="fields">
      <div className="field">
        <dt>Watching</dt>
        <dd className="mono">{eventsDir}</dd>
      </div>
    </dl>
  </Message>
);
