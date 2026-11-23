# Future work (agent-flow fork)

## Profile-agnostic detection (planned, not started)

Today the relay only draws agents it can read from Claude Code and Codex
transcripts, and only sessions active in the last 10 minutes
(`ACTIVE_SESSION_AGE_S`). Hermes profiles (taxis, sophia, omh-*, ...) do not
write Claude transcripts, so they never appear, even while busy.

Goal: detect activity from any provider and any Hermes profile, not just Claude:

- Read each profile's Hermes session store (`~/.hermes/profiles/<name>/state.db`,
  read-only) and map sessions to agents, one agent per profile.
- Keep the Claude and Codex watchers; add a provider-neutral source next to them.
- Make the profile list configurable instead of hard-coded.

Status: future feature, recorded 2026-11-23. Not part of the current fixes.
