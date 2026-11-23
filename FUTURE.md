# Future work (agent-flow fork)

## Profile-agnostic detection (partly done)

Done (branch feat/hermes-log-sessions): Hermes profiles are read live from
their own `logs/agent.log` (`scripts/hermes-logs.ts`). Each Hermes session is
its own node, and every node carries its profile in `group`, ready for a
grouped fleet view. Read-only, no synthetic transcripts, no Hermes restart.

Still open:
- Sessions that were idle when the relay started only appear once they log
  again (the watcher starts at end-of-file). Option: replay the last N minutes.
- The profile list is taken from `~/.hermes/profiles/*` automatically; make it
  configurable if needed.
- Providers beyond Claude, Codex and Hermes logs are not covered.
- Hermes does not say which cache TTL it used; cache writes are counted in the
  5-minute bucket, which may under-price 1-hour writes.

Recorded 2026-11-23.
