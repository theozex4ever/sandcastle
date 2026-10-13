import {
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  FlagCheckeredIcon,
  HourglassMediumIcon,
  LightningIcon,
  PackageIcon,
  PlugsIcon,
  WrenchIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RunState } from "../../projection.js";
import { STATE_LABELS, formatDuration } from "../format.js";
import { useNow } from "../store.js";

export const STATE_ICONS: Readonly<Record<RunState, Icon>> = {
  provisioning: PackageIcon,
  setup: WrenchIcon,
  working: LightningIcon,
  quiet: HourglassMediumIcon,
  finishing: FlagCheckeredIcon,
  done: CheckCircleIcon,
  failed: XCircleIcon,
  lost: PlugsIcon,
};

/** Icon + label in the state's semantic colour. */
export const StateBadge = ({ state }: { state: RunState }) => {
  const StateIcon = STATE_ICONS[state];
  return (
    <span className="state-badge" data-state={state}>
      <StateIcon size={13} weight="bold" aria-hidden />
      <span>{STATE_LABELS[state]}</span>
    </span>
  );
};

/**
 * Elapsed time from `start` to `end`, or to now (ticking) when `end` is unset.
 */
export const Elapsed = ({
  start,
  end,
  className,
}: {
  start: number;
  end?: number;
  className?: string;
}) => {
  const now = useNow(end === undefined);
  return (
    <span className={`num ${className ?? ""}`}>
      {formatDuration((end ?? now) - start)}
    </span>
  );
};

/** Small icon button that copies `text` and confirms for a moment. */
export const CopyButton = ({
  text,
  label,
}: {
  text: string;
  label: string;
}) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-button"
      title={copied ? "Copied" : label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
    >
      {copied ? (
        <CheckIcon size={14} weight="bold" aria-hidden />
      ) : (
        <CopyIcon size={14} weight="bold" aria-hidden />
      )}
    </button>
  );
};
