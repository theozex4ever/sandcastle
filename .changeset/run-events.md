---
"@ai-hero/sandcastle": minor
---

Add run events: every `run()`, `sandbox.run()` and `wt.run()` now emits a structured stream of lifecycle events (sandbox setup, hooks, iterations, agent text and tool calls, commits, outcome) to `.sandcastle/events/<sessionId>.ndjson`. New `labels` option tags a run for grouping; new `events` option forwards events to a callback or disables them. Agent providers now expose the `model` they were constructed with. Templates tag their runs with `phase`/`cycle`/`issue` labels.
