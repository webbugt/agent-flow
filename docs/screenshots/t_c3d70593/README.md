# Costs N1: the wrapper cannot find node (screenshots)

Made with the harness: `pnpm shot --task-id t_c3d70593 --plan builtin:n1_nonode --scenario costs --session none --limits L-6 --config C-limits --no-build`
(scratch HOME, free port, fixture L-6 = wrapper installed, last reading 3 h old, `node-missing.json` newer than the reading).

| File | What it shows |
|---|---|
| 01 `nonode-panel-desktop` | Top-bar chip `5h 37% · wk 4.2% · as of 07:20 · no node`; the LIMITS panel with stale rows and the note "The wrapper cannot find node (last tried 10:16)…"; the estimate rows (Fable `est`) are still there |
| 02 `nonode-panel-phone` | The same at 390 px: chip wraps under the tabs, panel sheet shows the note, nothing clipped |
| 03 `nonode-drawer-desktop` | Cost settings drawer, Claude usage limits: headline, stale meters, `Repair wrapper…` button, the note in amber |
| 04 `nonode-drawer-phone` | The same at 390 px |
