# P2-A5: Copilot list-equivalent vs the daily billing CSV (qualitative)

Task t_a67ea090 · 2026-11-25 · helper: `docs/spikes/p2-copilot-reconcile.ts` (read-only; aggregate output only).

Method: every `provider=copilot` `API call` line in `~/.hermes/logs/agent.log*` and
`~/.hermes/profiles/*/logs/agent.log*` (12,162 lines, 0 exact duplicates across files) is parsed with
`parseHermesLogLine` and priced at the built-in Copilot sheet (`priceUsage`, default config, implicit
cache-write inference ON, price chosen by the line's timestamp and per-request prompt tier). Compared with
`/home/idv/workspace/copilot_costs_daily_2026-11-06.csv` (`official_github_usd`, `hermes_ledger_usd`, `calls`).

| day | log calls | agent-flow list-equiv USD | CSV `calls` | CSV `hermes_ledger_usd` | CSV `official_github_usd` |
|---|---|---|---|---|---|
| 2026-11-01 | 451 | 22.50 | 475 | 19.13 | 45.12 |
| 2026-11-02 | 2806 | 127.73 | 2948 | 130.01 | 193.98 |
| 2026-11-04 | 1301 | 55.25 | 1334 | 57.37 | 61.67 |
| 2026-11-05 | 474 | 20.26 | 270 | 10.91 | 81.92 |
| 2026-11-06 | 918 | 21.98 | 106 | 5.31 | 2.40 |

(2026-11-03 has no CSV ledger calls and no log lines; days after 11-06 have no CSV row. Days 11-07..11-22 are
priced by the helper too, 0.01 to 25.80 USD/day, and are not reconcilable.)

## What this shows

- **Calls match closely on 11-01, 11-02 and 11-04** (within about 5 %, log slightly lower), and the list-equivalent
  USD is within 4 % of the plugin's `hermes_ledger_usd` on 11-02 (-1.8 %) and 11-04 (-3.7 %) and 18 % higher on 11-01. This is
  consistent with agent-flow and the `copilot-costs` plugin pricing the same Hermes-routed calls at similar rates.
- **11-05 and 11-06 do not line up**: the logs hold more calls than the plugin ledger recorded (474 vs 270, 918 vs
  106). Likely the ledger was not capturing for part of those days (or the CSV was cut at 11-06 when it was
  generated); not investigated, because the CSV has day totals only and nothing per call.
- **The official GitHub figure is larger** than the Hermes-routed list-equivalent on 11-01, 11-02 and 11-05 (45.12 vs
  22.50, 193.98 vs 127.73, 81.92 vs 20.26), as the 2026-11-12 diagnosis already said: GitHub's total covers
  non-Hermes Copilot usage too, and agent-flow only sees Hermes-routed calls. On 11-04 the two are close
  (61.67 vs 55.25), and on 11-06 the official figure (2.40) is below the Hermes-side figures (billing lag or
  allowance effects; not determinable here).
- Therefore the tooltip wording from plan section 3.1 stands: the Copilot number is **list-equivalent for
  Hermes-routed calls**, not the GitHub bill. No claim of accuracy against the bill is made.

## Gaps (documented, not fixed in P2)

1. CSV has no per-call data and uses its own day boundaries; the helper uses the host-local date of each log line.
2. **U-3 stays open**: whether implicit cache-write inference (default on for Copilot Claude models) matches
   GitHub's bill cannot be decided from daily totals. The inference applied to 58 % of calls on 11-01 and 33 % on 11-02
   (260 of 451, 913 of 2806). Turning it off (`providers.copilot.implicitCacheWrite: false`) changes the figure, so a
   per-call reference (the plugin's `ledger.db`) is needed before P4 claims accuracy.
3. Agent.log carries no `write=` for Copilot Claude lines, so the inference is the only source of cache writes there;
   Copilot `gpt-*` lines do carry `write=` and use the reported value.
4. Code completion, next-edit and code-review usage never appear as `API call` lines and are not priced.
