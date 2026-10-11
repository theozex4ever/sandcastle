# Run events: a structured NDJSON stream of every run's lifecycle

Sandcastle's progress was only visible as human-readable output (the `Display` service writing to a run log or the terminal) plus the narrow `onAgentStreamEvent` callback, which carried agent text/tool calls without any run identity and only in log-to-file mode. Building an orchestrator dashboard — seeing parallel agents provision, set up, work, go quiet, commit and fail — needs a machine-readable stream with run identity and lifecycle detail. We now emit **run events**: typed records (`runStarted`, `sandboxReady`, `hookFinished`, `iterationFinished`, `toolCall`, `commit`, `runFailed`, …) stamped with `sessionId`, `runId`, `seq` and `ts`, appended by default to `.sandcastle/events/<sessionId>.ndjson` and optionally forwarded to an `events.onEvent` callback.

## Decisions

- **On by default, file-first.** An NDJSON file needs no server, survives the process, works in CI, and can be tailed live or replayed later. `events: false` or `SANDCASTLE_EVENTS=0` opts out. Run logs set the precedent for writing under `.sandcastle/` by default.
- **One file per process.** Template scripts call `run()` many times (planner, parallel implementers, reviewers, merger). A process-wide `sessionId` puts the whole script in one file without threading anything through user code; `SANDCASTLE_SESSION_ID` lets a wrapper group several processes.
- **Labels are opaque.** Sandcastle has no notion of phases, issues or cycles — the user's script owns the pipeline shape. `labels` lets the script tag runs so observers can reconstruct it; Sandcastle never interprets them.
- **Optional Effect service.** Emission sites (`startSandbox`, `runHostHooks`, the lifecycle's hooks, `SandboxFactory`, `orchestrate`) read the `RunEvents` service via `Effect.serviceOption`, falling back to a no-op. No existing signature gains a requirement, so code paths outside a run (and existing tests) need no wiring.
- **Public types stay Effect-free.** `RunEvent` and friends are plain TypeScript; the `RunEvents` tag is internal.
- **Observability never breaks a run.** File I/O errors and throwing callbacks are swallowed.

## Considered alternatives

- **OpenTelemetry spans.** Effect has first-class tracing, and spans would give a trace viewer for free. Rejected as the primary mechanism: it adds a collector dependency for the simplest use (watch a local run), and live "agent is quiet for 52s" views need event granularity rather than span boundaries. An OTel exporter can be layered on the event stream later.
- **Extending `onAgentStreamEvent`.** Rejected: it is scoped to agent output, gated to file logging, and its event shape has no run identity; widening it would break its contract.

## Consequences

- `runStarted` is emitted after setup validation, so synchronous configuration errors (missing prompt file, invalid options) produce no events.
- Token usage arrives only on `iterationFinished`, and only for providers that report it — live cost views have a lag of one iteration.
- `interactive()` is not instrumented.
- Event files accumulate under `.sandcastle/events/`; `sandcastle init` adds the directory to `.sandcastle/.gitignore`.
