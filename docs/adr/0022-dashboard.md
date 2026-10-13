# Dashboard: a local server that tails run event files

[Run events](0021-run-events.md) made a run session machine-readable, but there was still no way to watch one. `sandcastle dashboard` is the first consumer: a local web UI that shows a session as a software factory (a station per `phase` label, a tile per run, a shared timeline, a per-run log).

## Decisions

- **Read the files, don't hook the process.** The dashboard tails `.sandcastle/events/*.ndjson`; scripts need no changes and no running dashboard to produce data. It can be started before, during or after a script, and a finished session replays the same way a live one streams.
- **Polling tail over `fs.watch`.** The server stats the file every ~250ms and reads only new bytes, buffering a partial trailing line. `fs.watch` is inconsistent across platforms and filesystems (bind mounts, WSL), and the cost of polling one file per open tab is negligible.
- **Server-Sent Events, raw events on the wire.** The server sends the backlog then live batches of `RunEvent`s; the browser folds them through a pure projection (`src/dashboard/projection.ts`). Keeping the server dumb means one projection, shared with tests, and reconnecting is "reset and replay".
- **Liveness from `pid`.** A script killed with Ctrl+C or a crash leaves runs with no `runFinished`/`runFailed`; they would read as working forever. `runStarted` now carries the emitting process's `pid`, the server reports which pids are alive, and the projection marks unfinished runs of dead processes as `lost`. A late event from a run marked lost revives it. Liveness is host-local: a session file copied from another machine shows its unfinished runs as lost.
- **Labels stay opaque to Sandcastle.** The dashboard interprets `phase`, `cycle` and `issue` only as display conventions (the templates use them); runs without them still render, grouped under one station.
- **Bundled UI, no runtime dependencies.** The UI is React, bundled by tsup into static assets under `dist/dashboard/`. React is a dev dependency; the published package gains no runtime dependency and the page makes no network requests.
- **Bind to 127.0.0.1 by default.** There is no authentication, and event files contain file paths, hook commands and agent output. `--host` opts into exposing it.

## Consequences

- Token usage still arrives once per iteration, so the dashboard's token counts lag by up to one iteration (see ADR 0021).
- Event files written before `pid` existed have no liveness: their unfinished runs stay in their last state.
- The projection caps each run's log at 2000 entries in the browser; the full stream remains in the file.
