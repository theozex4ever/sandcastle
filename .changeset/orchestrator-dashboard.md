---
"@ai-hero/sandcastle": minor
---

Add `sandcastle dashboard`: a local web dashboard that tails run event files and shows runs as a software factory, with a station per `phase` label, live run states and activity, a timeline of parallel runs, and a per-run log inspector. `--demo` serves a synthetic session. `runStarted` events now carry the `pid` of the script that made the run, so the dashboard can mark runs left unfinished by a crashed script as lost.
