# Costs P6-fix: R2 evidence (screenshots)

Made with the harness (`pnpm shot`, scratch HOME, free port, fixture data) and the built-in plans `p6fix_*` (added to `scripts/shot-lib.ts`):

```
pnpm shot --task-id t_2d06cee0 --plan builtin:p6fix_optin --scenario costs --limits L-4 --start-index 1
pnpm shot --task-id t_2d06cee0 --plan builtin:p6fix_stale --scenario costs --limits L-3 --config C-limits --start-index 3 --no-build
pnpm shot --task-id t_2d06cee0 --plan builtin:p6fix_rows  --scenario costs --limits L-1 --config C-limits --start-index 6 --no-build
```

| File | Shows | Proves |
|---|---|---|
| 01 / 02 `optin-drawer` desktop / phone | Opt-in text of "Claude usage limits" | L3: "usage percentages and reset times of each limit window (5-hour, weekly and any other the meter reports)"; L1: names `claude-history.json` and says remove deletes both files and the status line comes back "same content" (L2) |
| 03 / 04 `stale-topbar` desktop / phone | Stale chip `5h 37% · wk 4.2% · as of HH:MM` | L4: at 390 px the panel group wraps, the chip drops to a second line inside the group, Files / Chat / Session / $Cost are fully visible (before the fix the strip was cut at the left: "nat", "Session") |
| 05 `stale-chip-hover` desktop | Hover on the stale chip | hover state of the chip |
| 06 / 07 `row-5h-hover`, `row-7d-hover` desktop | Tooltip of the 5h and 7d LIMITS rows | row hover evidence (provider, "observed", used %, reset time, source) |
| 08 / 09 `row-5h-tap`, `row-7d-tap` phone | Tap sheet of the 5h and 7d rows above the panel | row tap evidence at 390 px, text not clipped |
| 10 `chip-hover` desktop | Hover on the observed chip | the chip tooltip is a native `title` attribute, which headless Chrome does not render; the string is asserted in `web/lib/costs/observed-limits.test.ts` |

Times in the shots are relative to the run (`as of 16:22` is the local time of the old fixture reading).
