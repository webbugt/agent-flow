# Costs P6a: observed Claude limits (screenshots)

Made with the H0 harness against a scratch app (scratch HOME, free port, fixture data), built-in plan `p6a`, three runs:

```
pnpm shot --task-id t_3b942322 --plan builtin:p6a --limits L-4 --start-index 1 --no-build   # no file, no wrapper: opt-in prompt
pnpm shot --task-id t_3b942322 --plan builtin:p6a --limits L-1 --start-index 5 --no-build   # fresh reading
pnpm shot --task-id t_3b942322 --plan builtin:p6a --limits L-3 --start-index 9 --no-build   # reading 3 h old: "as of HH:MM"
```

The harness sets `AGENT_FLOW_SHOT_LIMITS_CONFIGURABLE=1` for the scratch app so the opt-in prompt shows the VS Code variant
(with the "Install wrapper…" button). Without it the relay/standalone host shows the command name to run in VS Code instead,
because only the extension edits `~/.claude/settings.json`. For L-1..L-3 the fixture really runs the installer against the scratch HOME
(demo status line `echo demo-status`), so "Remove wrapper…" is offered. Times are relative to the run; `as of 15:28` is the local time of the old reading.

| File | Shows | Proves |
|---|---|---|
| 01 / 02 `limits-drawer` (L-4) desktop / phone | Cost settings drawer, section "Claude usage limits": question, what is read and stored, "remove any time", `Install wrapper…` | opt-in prompt |
| 03 / 04 `limits-topbar` (L-4) | Top bar with the chip `limits: set up` | opt-in entry point |
| 05 / 06 `limits-drawer` (L-1) | 5-hour 37 % `obs`, Weekly 4.2 % `obs`, reset times, bars, "Claude Code · observed, not estimated", `Remove wrapper…` | observed 5h / weekly values |
| 07 / 08 `limits-topbar` (L-1) | chip `5h 37% · wk 4.2%` | observed values, top bar |
| 09 / 10 `limits-drawer` (L-3) | headline "Last reading as of 15:28. It is not current…", both rows tagged `stale` with `as of 15:28`, amber bars | stale handling, "as of" |
| 11 / 12 `limits-topbar` (L-3) | chip `5h 37% · wk 4.2% · as of 15:28` (amber) | stale handling, top bar |

Row and chip hover text (provider, "observed", source) are native `title` attributes, which headless Chrome does not render; the same
strings are asserted in `web/lib/costs/observed-limits.test.ts`.
