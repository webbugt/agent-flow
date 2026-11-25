# Costs P6b: limits estimator and LIMITS panel (screenshots)

Made with the harness (`pnpm shot`, scratch HOME, free port, fixture data) and the built-in plans `p6b`, `p6b_fable_tip`, `p6b_row_tip`
(see the plan comment in `scripts/shot-lib.ts`). One fixture state per run:

| Run | Flags | Files |
|---|---|---|
| observed 5h / 7d, no Fable calls | `--scenario claude --limits L-1 --config C-limits` | 01, 02 |
| observed 5h / 7d + Fable calls | `--scenario costs --limits L-2 --config C-limits` | 03, 04, 05, 06, 14 |
| estimates only | `--scenario costs --limits L-4 --config C-limits` | 07, 08, 09 |
| calibrated on the reading history | `--scenario costs --limits L-5 --config C-limits` | 10, 11, 12, 13 |

The mapping of file to acceptance item below is taken from what each image shows (checked by opening every file).

| File | What it shows | Acceptance item |
|---|---|---|
| 01 / 02 `observed-no-fable` desktop / phone | 5h 37 % `obs`, 7d 4.2 % `obs`, reset times, bars; no Fable row | observed meters tagged observed; the Fable row appears only when Fable was used |
| 03 / 04 `observed-with-fable` | the same plus `Fable ~0.6‰ ≈ est`, "$0.622 list-equiv this window", footnote "Estimates use this machine's sessions only..." | Fable is estimate-only (`est`, `≈`), per-mille for values under 1 % |
| 05 `fable-tooltip-typed-budget` desktop hover | Fable tooltip: estimate 0.6‰, lower 0.3‰, upper 1.6‰, confidence low, basis "typed budget x 50 % share", assumptions, 5h share 72 % | estimate shown with bounds, confidence and basis |
| 06 `fable-tooltip-typed-budget` phone tap | the same as a tap sheet | tooltip by tap at 390 px (Fable row) |
| 07 / 08 `estimates-est-permille` | no observed file: 5h `>=11% ≈ est`, 7d `>=0.4‰ ≈ est`, Fable `~0.6‰ ≈ est`, "trailing 7d" | estimates labelled `est` with lower-bound marker; per-mille |
| 09 `estimate-5h-tooltip` desktop hover | 5h estimate tooltip: used >=11 % = $0.865 / typed budget $8.000, lower bound, window start/end, "No fresh observed reading" | 5h estimate tooltip (hover) |
| 10 / 11 `calibrated-cal` | 5h `>=27% ≈ cal`, 7d `>=5.2% ≈ cal`, Fable `~12% ≈ est` | calibration from reading pairs (`cal` tag) |
| 12 `fable-tooltip-weekly-meter` desktop hover | Fable tooltip: estimate 12 %, lower 3.7 %, upper 53 %, basis "weekly meter x 50 % share (1 pair, 2026-11-25)" | basis from the weekly meter |
| 13 `fable-tooltip-weekly-meter` phone tap | the same as a tap sheet | tooltip by tap at 390 px |
| 14 `observed-5h-tooltip` desktop hover | "Claude Code 5-hour usage limit observed (reported by Claude Code, not an estimate and not a price)", used 37 %, resets, source statusLine | observed 5h tooltip (hover) |

Not in this folder: the 5h and 7d row tap sheets at phone width, the 7d row hover, and the chip hover. They are in
`docs/screenshots/t_2d06cee0/` (06 to 10), together with the stale-chip layout check at 390 px.
