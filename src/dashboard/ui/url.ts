/** Selected session and run, mirrored into `?session=<id>&run=<runId>`. */

export interface UrlSelection {
  readonly session?: string;
  readonly run?: string;
}

export const readUrlSelection = (): UrlSelection => {
  const params = new URLSearchParams(window.location.search);
  return {
    session: params.get("session") ?? undefined,
    run: params.get("run") ?? undefined,
  };
};

export const writeUrlSelection = (sel: UrlSelection): void => {
  const params = new URLSearchParams(window.location.search);
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  };
  set("session", sel.session);
  set("run", sel.run);
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
  if (
    next !==
    `${window.location.pathname}${window.location.search}${window.location.hash}`
  ) {
    window.history.replaceState(null, "", next);
  }
};
