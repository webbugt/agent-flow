# Plan v2 (FINAL): configurable costs for agent-flow

Task: t_9f2e1622 (Costs F0) · Author: omh-researcher · Date: 2026-11-25 · Status: PLAN ONLY, no product code written or run.
Supersedes: `/home/idv/workspace/agent-flow-fork/PLAN-configurable-costs-v1.md` (t_ea71db7f, 2026-11-23). v1 is kept unchanged. **v1 sections 2 (schema), 3.1-3.2 (money, energy), 6 (limit meter) and 11 (sources) remain normative except where this document says otherwise. Where v1 and v2 disagree, v2 wins.**
Worktree: `/home/idv/workspace/agent-flow-costs`, branch `feature/configurable-costs`, based on main `21b02e3` (read from the worktree git metadata today, `refs/heads/feature/configurable-costs` = `21b02e34f282abc076e03645d918eff5ba190aa7`).

Evidence labels:
- **[SRC]** read in this worktree today.
- **[DOC]** read on a primary vendor page today (URL, fetched 2026-11-25 unless dated otherwise).
- **[OBS]** observed on this host today (file path given).
- **[3P]** third-party or community report, not vendor-confirmed.
- **[UNVERIFIED]** inference or assumption; a task must verify it, or the user must decide.

---------------------------------------------------------------------------

## 0. What changed versus v1 (summary)

1. Webbugt's six binding decisions are applied (section 1). Codex, spike S2 and the undocumented usage endpoint are removed. Chain task S3 (measured power) is deferred.
2. All 10 open questions are resolved (section 1.2).
3. **Copilot added** as a first-class provider with its own billing kind (`credits`) and its own price sheet. v1 said Copilot is `priceLike: anthropic`; that is wrong (section 3).
4. **Paths corrected.** v1 used `src/web/...`. In this worktree the repo root is the project root: `web/`, `extension/`, `scripts/`, `app/`. New pure modules go in `web/lib/costs/` (section 4).
5. **Layout constraint found in the code:** `extension/tsconfig.json` has `rootDir: "src"`, so `extension/src/*` cannot import `web/lib/*`. `scripts/*` can (precedent: `scripts/hermes-logs.ts` imports `../web/lib/content-privacy`). v1's plan to have `usage-ledger.ts` call the catalog tier logic does not compile. v2 fixes it with fixed prompt-size buckets (section 4.2).
6. **Test-command gap found:** root `pnpm test` runs `scripts/**`, `app/src/**`, `web/hooks/**`, `web/lib/**` only. It does **not** run `extension/test/**` (that is `pnpm --filter agent-flow test`). Every task acceptance below names both.
7. **Number-format bug in v1 fixed:** the v1 table labelled the `‰` band "0.1%-<1%" and the floor "<0.1%"; 1% = 10‰, so the correct bands are 0.01%-<1% and <0.01% (section 6.4). One v1 test pin (0.00999 -> `10.0‰`) is replaced by `1.0%`.
8. **Fable estimator math written out** with explicit lower/upper bound derivation and hover content (section 6.3).
9. **Tooltip content specified** (provider, billing kind, rate source, formula) (section 6.1).
10. Per-task acceptance lists, fixtures and the exact screenshot list per UI task are in section 9-10.
11. A dated price-change hazard is added to P0 (section 3.3): Gemini 4 Carbon promotional price ends **2026-12-01**.

---------------------------------------------------------------------------

## 1. Binding decisions and resolved questions

### 1.1 Decisions from Webbugt (binding, verbatim intent)

| # | Decision | Where applied |
|---|---|---|
| 1 | Show the Fable limit **only when Fable was used in the window**; otherwise show 5h % and weekly %. Fable is **estimate-only**: estimate icon; hover shows lower and upper bounds, confidence tag, calibration basis. Use per-mille (‰) when a value is below 1%. | 6.3, 6.4, 7.2 |
| 2 | Source of truth `~/.agent-flow/costs.json` (+ project override). VS Code settings for scalars only. | v1 D3 unchanged; P3 |
| 3 | Chained `statusLine` wrapper in `~/.claude/settings.json` approved; must chain the existing statusLine, be reversible, and **refuse to install if it cannot chain safely**. | 8; P6a |
| 4 | Undocumented usage endpoint OUT. No spike S2. | removed everywhere |
| 5 | Codex OUT. In scope: Claude Code (subscription and API), Copilot, local models (kWh). Cost hover tooltips MUST state provider and whether the figure is **billed, list-equivalent or estimated**. | 2, 3, 6.1 |
| 6 | Every UI-changing task needs screenshot verification per the H0 protocol. | 9, 10 |

Interpretation to confirm (non-blocking, cheap to flip): decision 1 is read as "5h % and weekly % are always shown when available; the Fable row is **added** only when Fable was used in the current weekly window". If Webbugt meant "Fable row replaces 5h/weekly when Fable is used", it is a one-line change in `limits-panel.tsx` visibility logic and one acceptance item (P6b-A4).

### 1.2 Resolved open questions

| Q | Resolution | Basis |
|---|---|---|
| Q1 Fable as % of what? | Fable **weekly** % as its own row, shown only when Fable was used in the weekly window. The "Fable share of this 5h session" composition ratio appears in the hover only, never as a bar. | Decision 1 + Anthropic documents Fable as a separate weekly limit (v1 3.3). |
| Q2 costs.json as source of truth | **Yes.** | Decision 2. |
| Q3 statusLine wrapper | **Approved** with the three constraints (chain, reversible, refuse when unsafe). | Decision 3. |
| Q4 undocumented usage endpoint | **No.** Not used, not spiked. | Decision 4. |
| Q5 FX | Manual FX only (`currency.fx` + `fxAsOf`). No network fetch. | Sophia default. |
| Q6 Energy attribution | Marginal `(P_load - P_idle)`; `total` stays selectable. | Sophia default. |
| Q7 Local runtimes first | ollama, llama.cpp, vLLM, LM Studio and custom OpenAI-compatible endpoints, identified by the Hermes `provider=` value; configured watts only; no hardware presets. **[OBS] no local-runtime `provider=` line exists in the host's Hermes `agent.log` files** (searched `~/.hermes` today, 0 matches), so local support is **fixture-verified only** until a real local provider is used. | Sophia default + search. |
| Q8 Codex reasoning tokens | **Moot.** Codex deferred. `codex-rollout-parser.ts` and Codex paths are not touched; Codex agents keep the `~` estimate path. | Decision 5. |
| Q9 Catalog updates | Ship with releases only. No runtime fetch. | Sophia default. |
| Q10 Subscription display | Subscription and credits providers show **list-equivalent value with a visible `list-equiv` badge**. User toggle `display.subscriptionValue: "show" \| "hide"` (default `show`). When `hide`, those agents show token counts, are excluded from money totals, and the summary says "N subscription agents hidden". | Sophia default. |

### 1.3 Explicit non-goals

- Codex (cost, limits, rollout parsing). Spike S2. Undocumented endpoints. OAuth/credential reading of any kind.
- Copilot **limit/allowance %** (no observable meter on this host, section 3.2). Copilot is cost-only. A later task could import the `copilot-costs` plugin ledger as the billed reference (section 11, F-1).
- Measured power (NVML/RAPL/plug). Deferred S3.
- Remote-model data-centre energy. Runtime catalog/FX fetch.

---------------------------------------------------------------------------

## 2. Providers in scope and billing kinds

| providerId | Source of the id | `billing` (config) | Tooltip kind | Money meaning |
|---|---|---|---|---|
| `anthropic` (Claude Code transcripts, no provider field) | runtime default | `api` or `subscription` (**user-set**; not visible in transcripts [SRC `usage-ledger.ts`]) | `billed` if api, else `list-equivalent` | tokens x catalog rate |
| `claude-subscription-directsdk-experimental` (Hermes) | `provider=` in `agent.log` [SRC `hermes-logs.test.ts`] | `subscription` | `list-equivalent` | tokens x Anthropic rate |
| `copilot` (Hermes) | `provider=copilot` [OBS `~/.hermes/profiles/sophia/logs/agent.log`] | `credits` | `list-equivalent` (AI-credits equivalent) | tokens x **Copilot sheet** rate; 1 AI credit = $0.01 [DOC] |
| `ollama`, `llama.cpp`, `vllm`, `lmstudio`, `custom` | Hermes `provider=` | `local` | `estimated` (configured power) | kWh x tariff; money only from electricity |
| any other / unseen | Hermes `provider=` | `unknown` -> `pricing.unknownModel.policy` | `estimated` | fallback rate, flagged |

**Billing kind (the word shown in tooltips), pure function `classifyBilling(provider, hadReportedUsage, rateSource)`:**
1. `estimated` if the agent has **no reported usage** (context-size blend, today's `agentCost()` path), **or** `billing = local`, **or** `rateSource = fallback` (unknown model).
2. `billed` if `billing = api` and usage was reported by the API.
3. `list-equivalent` if `billing in {subscription, credits}` and usage was reported.
4. `unpriced` is a fourth display state (policy `unpriced`); the tooltip says "no rate configured".

Rule: a figure is never summed across kinds without a split. The summary panel shows totals per kind.

---------------------------------------------------------------------------

## 3. Copilot: what is observable, how it is priced

### 3.1 Observed evidence on this host (2026-11-25)

| Source | What it holds | Token usage? | Label |
|---|---|---|---|
| Hermes `agent.log`, e.g. `/home/idv/.hermes/profiles/sophia/logs/agent.log` lines 5, 9, 14 | `API call #N: model=claude-haiku-5.5 provider=copilot in=15317 out=287 total=15604 latency=2.2s id=msg_...`; also `model=gemini-3.8-flash provider=copilot in=39905 out=229 ... cache=34956/39905 (88%)`. Model ids use **dots** (`5.5`). | **Yes**: in, out, cache read, latency. `write=` was absent on the Copilot lines I saw, present on the `claude-subscription` fixture line. | [OBS] |
| agent-flow code | `API_RE = /^API call #\d+: model=(\S+) provider=\S+ in=(\d+) out=(\d+)\b/` at `scripts/hermes-logs.ts:76` matches Copilot lines but **discards the provider**; cache and write counts come from separate regexes (lines ~95-107). A repo-wide search for `copilot` in agent-flow source returned 0 matches. | n/a | [SRC] |
| `~/.copilot/logs/process-*.log` (8 lines in the one I read) | Runtime init, `Model HTTP request failed ... http_status:403` warnings. | **No** | [OBS] |
| `~/.copilot/session-state/` | Only `.session-operation-locks/*.lock` files. | **No** | [OBS] |
| `~/.vscode-server/data/agentSessionData/<id>/session.db` (SQLite, 3 DBs sampled) | 14 tables, includes `turn_usage(turn_id, usage TEXT)` and `turns`; `session_metadata.peerChatBackingProvider = copilotcli`. **0 rows in `turn_usage` and `turns` in all 3 sampled DBs.** | Table exists; **unpopulated in samples**. Format of `usage` unknown. | [OBS]; populated-case [UNVERIFIED] |
| VS Code Copilot Chat logs | Searched `~/.vscode-server/data/logs` and `~/.config/Code`: 0 matches. | **No** | [OBS] |
| `copilot-costs` Hermes plugin (README `/home/idv/workspace/project-readmes/hermes-copilot-costs.README.md`) | Own ledger `<hermes root>/copilot-costs/ledger.db`, official GitHub billing import, reconcile. Hermes-routed calls only. | Yes (Hermes-routed), plus official daily USD | [OBS] README only; ledger not opened |
| Billing diagnosis `/home/idv/workspace/reports/copilot-cost-diagnosis-2026-11-12.md` | Nov 1-12: official $723-735 vs Hermes-tracked $246.86; ~$488 untracked, partly non-Hermes usage. | n/a | [OBS] |
| `/home/idv/workspace/copilot_costs_daily_2026-11-06.csv` | Columns `day, official_github_usd, hermes_ledger_usd, untracked_remainder_usd, calls`. | n/a | [OBS] |

**Conclusions (binding for the plan):**
- agent-flow can price Copilot **only for Hermes-routed calls** (`provider=copilot`). Direct Copilot CLI / VS Code Copilot Chat usage has no observable token source here.
- The figure agent-flow shows for Copilot is **list-equivalent at published per-token rates**, not the GitHub bill. Reasons [DOC]: plans include a monthly AI-credits allowance that is not subtracted; usage beyond it is billed at the same per-token rates (1 credit = $0.01). The diagnosis report shows tracked spend covers only about a third of the official total.
- The tooltip for Copilot says so in words (section 6.1).

### 3.2 Copilot limits

No observable allowance meter (the allowance size varies by plan [DOC]). Decision: Copilot has **no limit bar** in this chain. Cost only.

### 3.3 Copilot price sheet (separate catalog section `copilot`)

Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing (fetched 2026-11-25). All prices USD per 1M tokens. "Threshold" = input-token threshold for the long-context tier; whether "input tokens" includes cached tokens is **[UNVERIFIED]** (v1 `promptTokens = in_new + cr + cw` is kept; the `copilot-costs` plugin uses prompt size the same way).

Seed rows P0 must transcribe (rows I verified today; P0 transcribes the **whole** page and adds a test that every row has `source` + `asOf`):

| Model (docs name) | Catalog id after normalisation | Input | Cached input | Cache write | Output | Tier |
|---|---|---|---|---|---|---|
| Claude Haiku 5.5 | `claude-haiku-5-5` | 0.10 / 0.50 | 0.01 / 0.05 | 0.125 / 0.625 | 0.50 / 2.50 | split at **100K** input tokens |
| Claude Opus 5.5 | `claude-opus-5-5` | 4.00 | 0.20 | 5.00 | 20.00 | none |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2.00 | 0.10 | 2.50 | 10.00 | none |
| Claude Sonnet 5 | `claude-sonnet-5` | 2.00 | 0.20 | 2.50 | 10.00 | none |
| Claude Fable 5 | `claude-fable-5` | 10.00 | 1.00 | 12.50 | 50.00 | none |
| Claude Fable 5.1 | `claude-fable-5-1` | 10.00 | 0.25 | 12.50 | 50.00 | none |
| Claude Fable 5.2 | `claude-fable-5-2` | 8.00 | 0.20 | 10.00 | 40.00 | none |
| Gemini 3.8 Flash | `gemini-3-8-flash` | 0.75 | 0.075 | n/a | 3.75 | promo, see below |
| GPT-6.1 Sol | `gpt-6-1-sol` | 2.00 / 4.00 | 0.10 / 0.20 | 2.50 / 5.00 | 10.00 / 15.00 | split at **272K** |
| GPT-6.1 Terra | `gpt-6-1-terra` | 1.00 / 2.00 | 0.05 / 0.10 | 1.25 / 2.50 | 5.00 / 7.50 | split at **272K** |

Normalisation (extends v1): lower-case, `.` and spaces -> `-`. Host ids seen: `claude-haiku-5.5`, `gemini-3.8-flash` [OBS]; `gpt-6.1-sol` appears in the diagnosis report [OBS].

**Dated price hazards P0 must encode as data** (`validUntil` + `afterRate`; the catalog resolver switches by the event timestamp, not by wall clock at render):
- Gemini 4 Argon and Carbon: $2.00 / $0.10 / $10.00 until **2026-12-01**; Carbon becomes $4.00 / $0.20 / $20.00 from 2026-12-01. **This is 6 days from today**; the release must not ship Carbon at the old price after that date.
- Gemini 3.8 Flash promotional until 2026-12-31 (price after not published on the page).
- MAI Code 2 ($0.50 / $0.025 / $2.50) and MAI Code 2 Flash ($0.05 / $0.005 / $0.25) until 2027-05-17, then 2x.
- Code completions and next-edit suggestions are not billed in AI credits [DOC]; they never appear as `API call` lines. Copilot code review is billed per review with an undisclosed model; **not modelled** (documented in the tooltip footnote as "code-review usage not priced").

**Implicit cache-write inference (Copilot Claude models).** The `copilot-costs` README says Copilot-Claude uncached input >= 1,024 tokens with no reported cache write is billed at the cache-write rate, as in Hermes core `agent/usage_pricing.py`. The Copilot `agent.log` lines I saw carry no `write=`. Decision: implement `implicitCacheWrite(provider, family, newInputTokens, reportedWrite)` as a pure function in `web/lib/costs/price.ts`, **default on** for `provider=copilot` + Claude-family models, switch `providers.copilot.implicitCacheWrite` (bool). The tooltip adds "includes inferred cache-write on N tokens". [UNVERIFIED against GitHub's bill.] P2/P4 must reconcile on the existing daily CSV before claiming accuracy (section 11, U-3).

---------------------------------------------------------------------------

## 4. Module layout confirmed against the code on this branch

### 4.1 Current state (re-read today)

| File (worktree-relative) | Facts [SRC] |
|---|---|
| `web/lib/pricing.ts` (44 lines) | `FAMILY_PRICES` regexes: fable/mythos 10/50, opus 5/25, sonnet 3/15, haiku 1/5; `FALLBACK_PRICE` 3/15; `spendUsd()` hard-codes cache read 0.1x, 5m write 1.25x, 1h write 2x. Exports `priceForModel`, `spendUsd`. |
| `web/lib/pricing.test.ts` (1,673 chars) | 3 tests; asserts haiku-5-5 = 1/5 (stale vs vendor page). |
| `web/components/agent-visualizer/canvas/draw-cost.ts` (284 lines) | `modelCostRate()` (blended rate via `MODEL_FAMILY_COST`, fallback `COST_RATE`), `agentCost()`, `agentSpendUsd()` -> `{usd, estimate}`, `toolTypeColor()`, `drawCostLabels()` (line 52), `drawCostSummaryPanel()` (line 136). Imports `COST_RATE, MODEL_FAMILY_COST, COST_DRAW, COST_PANEL` from `@/lib/canvas-constants` and `spendUsd` from `@/lib/pricing`. |
| `web/lib/canvas-constants.ts` | `COST_DRAW` (pill: `pillYOffset 22`, `pillHeight 16`...) and `COST_PANEL` (`width 200`, `xMargin 16`, `yStart 48`, `maxRows 5`) at lines ~309-339; duplicated blended rates (`CLAUDE_FAMILIES.rate`, `MODEL_FAMILY_COST`, `COST_RATE`). |
| `web/components/agent-visualizer/index.tsx` | `showCostOverlay` state (line 79), toggled by `panel === 'cost'`; passed to `canvas.tsx`, which calls `drawCostLabels` (line 274) and `drawCostSummaryPanel` (line 285). `top-bar.tsx` has the cost toggle (`active={showCostOverlay}`). |
| `web/hooks/use-canvas-interaction.ts` | Hover is agent-only: `findAgentAt()` -> `onAgentHover(id)` (lines 95-98). **There is no cost-pill hit test and no tooltip.** |
| `web/lib/session-detail.ts:195` | `formatCostUsd(usd, estimate)` -> `~$0.123` / `$0.0042`. |
| `extension/src/usage-ledger.ts` (70 lines) | `recordAssistantUsage()`; dedupes by message id; `splitCacheWrites()`. No provider, no tiers. |
| `extension/src/protocol.ts` (245 lines) | `VisualizerConfig {mode, autoPlay, showMockData, disable1MContext}` (line 56); `SpendTotals {inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, model?}` (line 221); `ExtensionToWebviewMessage` includes `{type:'config'; config: Partial<VisualizerConfig>}` (line 50). |
| `web/lib/agent-types.ts` | Mirror of `SpendTotals` for the webview (no shared import across the rootDir boundary). |
| `scripts/hermes-logs.ts` | `API_RE` (line 76) drops `provider`; spend merge at lines ~669-676 treats Hermes cache-write as 5-minute; `spend` object created at line ~769. `scripts/hermes-logs.test.ts` fixtures `API_LINE` (claude-subscription, has `write=`) and `API_NO_CACHE`. |
| `scripts/relay.ts`, `app/src/server.ts` | `server.ts:29` already uses `~/.agent-flow/` (telemetry dir, `installation-id`) -> `costs.json` lands in an existing directory. Relay env: `AGENT_FLOW_HERMES_ROOT`, `AGENT_FLOW_RUNTIME`, `AGENT_FLOW_ANONYMIZE_CONTENT`. Relay uses `os.homedir()` for `~/.claude/projects` and `~/.claude/agent-flow`. |
| Test commands | Root `pnpm test` = `node --import tsx --test "scripts/**/*.test.ts" "app/src/**/*.test.ts"` then `tsx --tsconfig web/tsconfig.json --test "web/hooks/**/*.test.ts" "web/lib/**/*.test.ts"`. Extension: `pnpm --filter agent-flow test` (`tsx --test test/**/*.test.ts`), `... run lint` (`tsc --noEmit`), `... run lint:test`. Web has no lint script; typecheck = `cd web && npx tsc --noEmit -p tsconfig.json`. Builds: `build:web`, `build:webview`, `build:extension`, `build:app`. |

### 4.2 Resulting layout (v2, normative)

```
web/lib/costs/                 NEW, pure TS, no I/O, no vscode (importable by web and scripts/*)
  types.ts                     CostConfig, ResolvedConfig, Rate, Tier, BillingKind, RateSource ...
  catalog/anthropic.ts         rows + source + asOf (+ validUntil/afterRate)
  catalog/copilot.ts           separate sheet (section 3.3)
  catalog/index.ts             lookup helpers; local = no rows
  tiers.ts                     TIER_BOUNDARIES, promptBucket()   (mirrors extension/src/spend-tiers.ts)
  validate.ts  resolve.ts  price.ts  format.ts  tooltip.ts        (P1)
  energy.ts                    (P5)
  limits.ts  fable-estimate.ts (P6b)
web/lib/pricing.ts             shim: priceForModel/spendUsd keep signatures
web/lib/pricing.test.ts        kept; two assertions intentionally corrected in P0

extension/src/spend-tiers.ts   NEW, 10 lines, zero imports: TIER_BOUNDARIES + promptBucket()
extension/src/costs-config.ts  NEW (P3): load/merge/validate/watch/atomic-write; no vscode import
extension/src/limits-observer.ts NEW (P6a)
extension/src/statusline-shim.ts + statusline-installer.ts NEW (P6a)
extension/src/usage-ledger.ts, protocol.ts, hooks-config.ts (pattern only), package.json  EDIT
scripts/hermes-logs.ts, scripts/relay.ts, app/src/server.ts  EDIT (provider, latency, config load)
scripts/costs-boundaries.test.ts NEW: cross-checks the two TIER_BOUNDARIES copies and catalog thresholds
web/hooks/use-canvas-interaction.ts  EDIT (P4): cost-pill hit test
web/components/agent-visualizer/cost-tooltip.tsx, cost-settings-drawer.tsx, limits-panel.tsx  NEW (DOM)
web/components/agent-visualizer/canvas/draw-cost.ts  EDIT (P4)
web/lib/canvas-constants.ts    EDIT: drop blended rates; keep CLAUDE_FAMILIES name + context
```

**Prompt-size buckets (fixes the rootDir problem).** `TIER_BOUNDARIES = [100_000, 200_000, 272_000]`. `promptBucket(n)` returns `le100000 | le200000 | le272000 | gt272000`. Ledger and Hermes handler store per-bucket token totals in `SpendTotals.byBucket?: Record<bucket, Tokens>` (summing to the flat totals). Catalog `maxPromptTokens` values must be members of `TIER_BOUNDARIES`; `scripts/costs-boundaries.test.ts` fails otherwise. A user tier boundary outside the list is a **validation error** (clear message) rather than silent mis-pricing. Models without tiers keep flat totals; Haiku 5.5 (100K), GPT-6.x (272K), Grok 4.x (200K) are covered.

**Hotspots (flag in every card that touches them):** `web/components/agent-visualizer/canvas/draw-cost.ts`, `extension/src/protocol.ts` (+ `web/lib/agent-types.ts` mirror), `web/hooks/use-vscode-bridge.ts`, `extension/package.json`. Tasks are sequential, so collisions are only possible with other worktrees; do not touch them.

### 4.3 Surfaces

Two UI builds exist: the Next app (`web/`, served by `app/` and the dev relay) and the Vite VS Code webview (`pnpm run build:webview`). **Screenshots are taken from the Next/standalone app only** (headless Chrome cannot host a VS Code webview). Every UI task must additionally prove `build:webview` and `build:extension` still compile.

---------------------------------------------------------------------------

## 5. Config schema deltas (everything else per v1 section 2)

- `providers.copilot = { "billing": "credits", "implicitCacheWrite": true }` (drops `priceLike`; Copilot resolves in catalog section `copilot`).
- `providers.<id>.billing` enum: `api | subscription | credits | local | free | unknown`.
- `display.subscriptionValue: "show" | "hide"` (default `show`) (Q10).
- `limits.codex` removed. `limits.claude.countProviders: string[]` default `["claude-subscription-directsdk-experimental", "anthropic"]` where `anthropic` counts only if `providers.anthropic.billing = "subscription"`. **Copilot never counts toward Claude plan limits** (a Copilot-routed Fable call does not draw on the Claude Fable limit).
- `limits.claude.fable`: `{ enabled, shareOfWeekly: {lo:0.5, point:0.5, hi:0.5}, relativeWeight: {lo:0.5, hi:2}, anchors: [] }` where `anchors` is the manual calibration list `[{at: ISO, observedPct: number}]` the user may type from claude.ai -> Settings -> Usage. Defaults are priors, labelled as such; tests pin the **arithmetic**, not the defaults.
- `pricing.unknownModel.policy` default stays `provider-default` then `global-rate`; `rateSource: fallback` forces billing kind `estimated`.
- Tier boundaries in config must be members of `TIER_BOUNDARIES` (section 4.2).
- Catalog entry gains optional `validUntil` + `afterRate` (section 3.3).

---------------------------------------------------------------------------

## 6. Specifications

### 6.1 Cost tooltip content (hover on a cost pill or agent while the cost overlay is on; tap on phone)

Pure builder `buildCostTooltip(input) -> { title, rows: Row[], footnotes: string[] }` in `web/lib/costs/tooltip.ts` (testable without a DOM); rendered by `cost-tooltip.tsx` as a **DOM element** (`data-testid="cost-tooltip"`), positioned from the pill rectangle, clamped inside the viewport (phone: bottom-anchored sheet).

Rows, in order (every row mandatory unless marked optional):

| # | Label | Content | Example |
|---|---|---|---|
| 1 | Provider | `providerId` + human label | `copilot (GitHub Copilot via Hermes)` |
| 2 | Billing kind | one of `billed`, `list-equivalent`, `estimated`, `unpriced`, with a one-clause reason | `list-equivalent: AI-credits plan; allowance not subtracted; 1 credit = $0.01` |
| 3 | Model | normalised id + display name | `claude-haiku-5-5 (Haiku 5.5)` |
| 4 | Rate source | `user rule #n` / `catalog <section> asOf <date>` / `provider default` / `fallback (unknown model)`, plus URL host for catalog | `catalog copilot, asOf 2026-11-25 (docs.github.com)` |
| 5 | Rate used | per-MTok in the row's currency, with tier if any | `in 0.10 · out 0.50 · cache-read 0.01 · cache-write 0.125 (tier <=100K)` |
| 6 | Tokens | new-in / out / cache-read / cache-write 5m / 1h | `in 15,317 · out 287 · cr 0 · cw5 0 · cw1 0` |
| 7 | Formula | one line, numbers substituted | `(15317*0.10 + 287*0.50) / 1e6 = $0.001675` |
| 8 | Result | money in display currency, kWh for local | `$0.0017` or `0.0031 kWh x 0.30 = EUR 0.0009` |
| 9 | (optional) Modifiers | multiplier, data-residency, fast, FX | `x1.00 · FX USD->EUR 0.92 (2026-11-23, manual)` |
| 10 | (optional) Inference flags | implicit cache-write, fallback rate, unreported usage | `includes inferred cache-write on 15,317 tokens` |

Footnotes by kind: `billed` -> "computed from reported usage x configured rate; verify against your invoice"; `list-equivalent` -> "value at list price; not what you were charged"; `estimated` -> "no reported usage / configured power / fallback rate; order-of-magnitude only"; Copilot adds "Copilot code review and completions are not included".

For `local`, rows 5 and 7 are replaced by energy rows: busy time (source: latency or throughput fallback), `P_load`, `P_idle`, attribution, pue, kWh formula, tariff window used. The kind is `estimated` and the footnote reads "estimated from configured power, not measured".

### 6.2 Money formulas

Unchanged from v1 3.1 with these amendments: (a) rate lookup follows v1 resolution order with Copilot using catalog section `copilot`; (b) `promptTokens = in_new + cr + cw5 + cw1` selects the tier via `promptBucket`; (c) `implicitCacheWrite` (section 3.3) applied before pricing; (d) the blended estimate rate stays `0.75*in + 0.25*out` and keeps the `~` prefix.

### 6.3 Fable estimator (estimate-only; math, bounds, hover)

**Why estimate-only.** [DOC, fetched 2026-11-23, v1] the documented `statusLine` payload has `rate_limits.five_hour` and `rate_limits.seven_day` only; there is no Fable bucket. [3P] issues #78232 / #88137 request one. Re-fetch today of https://code.claude.com/docs/en/statusline returned only the page intro (truncated by the extractor), so **today's check of the schema is incomplete; spike S1 (t_34bafcf5) is the confirmation point** [UNVERIFIED until S1].

**Applicability.** Only for plan `max5x | ultra | custom` (Fable has a separate weekly limit, "50% of weekly limits" [DOC https://claude.com/pricing, v1]). On Pro Fable is "usage credits" [DOC, v1] -> no bar; hover shows list-equivalent value only. `api` -> no limits UI.

**Show rule.** `fableUsedInWindow = (count of Fable-family calls in the current weekly window attributed to a counted provider) >= 1`. Weekly window = `[R - 7d, R)` with `R` = observed `resets_at`, else configured `{dow, HH:MM, tz}`, else trailing `[now - 7d, now)` (labelled "trailing 7d"). Fable-family = catalog family `fable` (also `mythos` while it shares the rate). If false: no Fable row; 5h and weekly rows only.

**Inputs.**
- `u` = list-equivalent USD of Fable calls in the window (local ledger, counted providers only).
- Weekly calibration pairs (v1 3.3): `B_j = dC_j / (dp_j / 100)`, from observed `seven_day.used_percentage` p and local units C in the same window id, `dp >= 5` points, last 10 pairs.
- Share `s` in `[s_lo, s_hi]` (documented point 0.5).
- Relative weight `rho` in `[rho_lo, rho_hi]`: the unverified premise that limit use is proportional to list-price units (v1 3.3) may weigh Fable differently from other models. Default band `[0.5, 2]` = "within a factor of two" prior [UNVERIFIED].
- `delta_u`: unseen-usage allowance, applied **only** when the budget did not come from the local ledger (basis 3 below). Default 0.25 [UNVERIFIED].
- Two hypotheses about whether observed `seven_day` includes Fable: H1 includes, H2 excludes. Compute `B_j` under both (H2 subtracts Fable units from `dC_j`); bounds use the union.

**Calibration basis (strongest available wins):**

1. **Manual Fable anchors** (user typed the Fable % from claude.ai): `B_F,j = dC_F,j / (dp_F,j / 100)`; `p = u / B_F`; bounds from the min/max of the anchor intervals; `s` and `rho` drop out. Confidence per v1 (n>=5 and MAD/median<0.15 -> high; n>=2 -> medium; n=1 -> low).
2. **Weekly meter x share**: `B_F = s * B_7d`, with `B_7d` from observed weekly pairs. Confidence is **capped at `low`** (because `rho` is unverified), `medium` only if anchors n>=2 corroborate.
3. **No meter, user-entered budget** `B_7d` (USD-equiv): `B_F = s * B_7d`, `delta_u` applies, confidence `low`.
4. **Nothing**: no number. Row shows the estimate icon, "set limit to estimate", and the used list-equivalent value `u`.

**Bounds (basis 2; basis 1 replaces `s`, `rho` by the anchor range):**

```
B_lo, B_pt, B_hi  = nearest-rank P10, median, P90 of {B_j} over H1 and H2   (n<5: min, median, max)
p_pt = u / (s_pt * B_pt)
p_lo = (u * rho_lo)                     / (s_hi * B_hi)
p_hi = (u * (1 + delta_u_if_basis3) * rho_hi) / (s_lo * B_lo)
```
`p_lo <= p_pt <= p_hi` must hold (test invariant). Values are clamped at 0 below; above 100% display as `>=100%`.

**Golden example (a P6b test must reproduce it exactly):**
pairs `B_j = [180,190,195,200,205,210]` -> sorted, n=6, median = (195+200)/2 = **197.5**, P10 (rank ceil(0.6)=1) = **180**, P90 (rank ceil(5.4)=6) = **210**. `s = 0.5/0.5/0.5`, `rho = [0.5, 2]`, `u = 0.34`, basis 2, `delta_u = 0`:
- `p_pt = 0.34 / (0.5*197.5) = 0.003443` -> **3.4‰**
- `p_lo = 0.34*0.5 / (0.5*210) = 0.001619` -> **1.6‰**
- `p_hi = 0.34*2 / (0.5*180) = 0.007556` -> **7.6‰**
- confidence `low` (basis 2 cap); n=6.

**What the hover shows (`data-testid="fable-estimate-tooltip"`):**
```
Fable weekly limit - ESTIMATE (Claude Code does not report this)
estimate 3.4‰    lower bound 1.6‰    upper bound 7.6‰
confidence: low
calibration basis: weekly meter x 50% share (6 pairs, 2026-11-18..2026-11-24); manual anchors: 0
assumptions: relative weight [0.5, 2] (unverified); Fable counted in weekly: both hypotheses applied
used: $0.34 list-equiv of Fable this window; window resets Thu 09:00 (observed)
this machine's sessions only; other devices and claude.ai are not counted
Fable share of this 5h session: 12% (composition, no budget needed)
```
The row itself shows: label `Fable`, the estimate icon (`data-testid="est-icon"`, glyph `≈`, `aria-label="estimate"`), the point value, and no bounds. 5h and weekly rows with observed values carry an `obs` tag and **no** icon.

### 6.4 Limit number format (corrects v1)

`formatLimitPct(f)` with `v = f*100`:

| Condition on v | Output | Note |
|---|---|---|
| `v = 0` | `0%` | |
| `0 < v < 0.01` | `<0.1‰` | 0.01% = 0.1‰ |
| `0.01 <= v < 1` | `x.y‰` (m = v*10, one decimal) | if rounded m reaches `10.0`, output `1.0%` |
| `1 <= v < 10` | `x.y%` | if rounded reaches `10.0`, output `10%` |
| `10 <= v < 100` | `N%` (rounded) | |
| `v >= 100` | observed: `100%`; estimate: `>=100%` | |

Pins: `0.00005 -> <0.1‰`, `0.0001 -> 0.1‰`, `0.0034 -> 3.4‰`, `0.00999 -> 1.0%` (replaces v1's `10.0‰`), `0.01 -> 1.0%`, `0.042 -> 4.2%`, `0.0999 -> 10%`, `0.10 -> 10%`, `0 -> 0%`. Prefixes: `~` estimate, `>=` lower bound (local-only ledger), none for observed (tagged `obs`). Bounds in the Fable hover are formatted independently, so a range may cross units (`9.1‰ - 1.2%`).

### 6.5 5h / weekly estimator and calibration

Unchanged from v1 3.3 (window tracker, `B-hat = dC/(dp/100)`, median of last 10, confidence labels). Counted providers restricted per section 5.

---------------------------------------------------------------------------

## 7. UI specification

### 7.1 Cost overlay (canvas, existing functions)
Pill text per kind: `~$0.012` estimated; `$0.012` billed; `$0.012 sub` list-equivalent (badge `list-equiv`); `0.014 kWh` local; `?` unpriced. Header toggle cycles money -> kWh -> tokens (persisted `display.unit`). Summary panel splits totals by kind (`billed`, `list-equiv`, `estimated`, `local`). `display.subscriptionValue = hide` per Q10.

### 7.2 DOM components (new)
- `cost-tooltip.tsx` (6.1). Hit test added in `use-canvas-interaction.ts`: pill rectangles are registered per frame by `drawCostLabels`; `findCostPillAt(x, y)`.
- `limits-panel.tsx`: DOM, docked under the canvas summary panel on desktop and as a bottom sheet on phone (canvas text is 6-9 px and cannot host hover targets). Rows: `5h`, `7d`, and `Fable` (only when used). Tags `obs`, `cal`, `est`; `>=` for lower bounds.
- `cost-settings-drawer.tsx`: providers (billing, `implicitCacheWrite`), model rules, energy profile + tariff, limits plan/anchors, validation errors inline with JSON pointers.
- `config-error-banner.tsx` (P3).

### 7.3 Test hooks required for screenshots (delivered by H0)
- Stable `data-testid`s: `cost-toggle`, `cost-tooltip`, `fable-estimate-tooltip`, `est-icon`, `limits-panel`, `limits-row-5h|7d|fable`, `cost-settings-drawer`, `config-error-banner`, `subscription-value-toggle`, `unit-toggle`.
- Query `?shot=1`: pre-ticks the force layout N iterations and freezes it (no animation, no timers, no particles) so two runs are pixel-stable, and exposes `window.__AF_TEST__ = { agentRect(id), pillRect(id), setPanel(name), ready }` (only when `shot=1`; never in production behaviour).

---------------------------------------------------------------------------

## 8. statusLine wrapper (decision 3), safety specification (P6a)

Installer `Configure Claude statusLine` / uninstall command. Requirements (each is a P6a acceptance test):
1. Operates on **user scope only** (`~/.claude/settings.json`). Reads with a JSON parser; on parse failure -> refuse.
2. Cases: (a) no `statusLine` -> install wrapper that only tees; (b) `statusLine.type = "command"` -> store the original object **verbatim** in `~/.agent-flow/statusline-original.json` (0600) and wrap; (c) any other type, or a non-object value, or a command it cannot invoke safely -> **refuse**, change nothing, report why; (d) managed/enterprise `statusLine` -> refuse; (e) already wrapped (marker present) -> no-op (idempotent, no double wrap).
3. Project/local settings with their own `statusLine` shadow the user scope: detect in the workspace, warn "limits may not be observed in this project", do not refuse.
4. Before writing: copy `settings.json` to `settings.json.agent-flow.bak` (0600); write via temp + rename; keep other keys byte-stable (hooks installed by `hooks-config.ts` untouched).
5. Wrapper script `~/.claude/agent-flow/statusline-shim.js` (precedent: `hook.js` in the same directory [SRC `discovery.ts`]); invoked with the absolute node path like the existing hook command. It reads stdin once, whitelists keys (`rate_limits`, `session_id`, `model.id`, timestamp) into `~/.agent-flow/limits/claude.json` (0600, atomic), then runs the original command with the same stdin, env and cwd, forwards **stdout and exit code unchanged**. Any failure of the tee path is swallowed: the user's status line must never break because of agent-flow. Total added latency budget: 50 ms p95 (measured in test).
6. Uninstall restores the original `statusLine` object exactly (deep-equal), removes only agent-flow files. If the user changed `statusLine` after install (no longer our wrapper), uninstall leaves it alone and says so.
7. The limits file never contains prompt, transcript path, cwd or credentials; test asserts the written key set equals the whitelist.
8. Stale file -> UI shows `as of HH:MM` and the `obs` tag is replaced by `stale`.

---------------------------------------------------------------------------

## 9. Task chain, ordering and acceptance

**Order:** F0 -> (S1 || H0) -> P0 -> P1 -> (P2 || P3) -> R1 -> P4 -> P5 -> P6a (needs S1) -> P6b -> R2 -> W1 -> D1. The kanban graph owned by the orchestrator prevails; any code-editing tasks run strictly sequentially on the one worktree.

**Common definition of done (every task):** commit on branch `feature/configurable-costs` only (never main, never other worktrees, never port 3001/3301 except D1 deploy); final kanban comment lists HEAD hash, files changed, results of: `pnpm test`; `pnpm --filter agent-flow test`; `pnpm --filter agent-flow run lint` and `lint:test`; `cd web && npx tsc --noEmit`; `pnpm run build:web`, `build:webview`, `build:extension`, `build:app` (each pass/fail, any failure explained, **no claim without the output**). No secrets, tokens, credential values, or real prompt text in code, logs, comments, fixtures or screenshots.

**Screenshot protocol recap (H0 builds it; every UI task follows it):** `scripts/shot.*` against a scratch instance of the built app on a free port (never 3001/3301), isolated `HOME`, seeded fixtures; desktop 1440x900 and phone 390x844, device scale 2; hover via CDP `Input.dispatchMouseEvent` (desktop), tap via touch events (phone); save to `docs/screenshots/<task-id>/<NN>-<slug>-<desktop|phone>[-hover].png`; attach each file to the card; in the final comment one line per screenshot: what it shows, which acceptance item it proves, **and what the author saw when looking at it** (a screenshot not inspected does not count).

### S1. Spike: does Claude Code expose `rate_limits` in hooks, or a Fable bucket in statusLine?
Assignee note: card is on `omh-researcher`, which has **no terminal** and cannot run Claude Code. See blocker B-1.
- S1-A1 Output file `docs/spikes/S1-claude-limits.md` with: Claude Code version(s) tested, redacted captured JSON payloads of a real `statusLine` call and of at least the `Stop` and `UserPromptSubmit` hook inputs, and an explicit yes/no for (a) `rate_limits` in hook payloads, (b) any Fable / per-model key in `statusLine`.
- S1-A2 Payload capture done in an **isolated `CLAUDE_CONFIG_DIR`**; the user's real `settings.json` untouched; credentials never printed; redaction listed.
- S1-A3 If no live subscription session is available, the report says "not run" and lists only documentation evidence with URLs and fetch dates. No guesses.
- No UI. No screenshots.

### H0. Screenshot harness + fixture sessions (omh-coder)
- H0-A1 `scripts/shot.*` runs headless `/usr/bin/google-chrome`, no new runtime dependency (raw CDP over WebSocket; if Node lacks a global `WebSocket` **[UNVERIFIED, check `node --version`]** a dev-only dependency requires a note in the card).
- H0-A2 Harness starts a scratch built app (`pnpm run build:app` output) on a free port with `HOME`, `AGENT_FLOW_HERMES_ROOT` pointing into a temp dir and refuses ports 3001/3301 (test).
- H0-A3 Fixtures F-A..F-H, L-1..L-4, C-* (section 10) exist under `scripts/shot-fixtures/` and are synthetic (no real prompts, ids, tokens).
- H0-A4 `?shot=1` freeze + `window.__AF_TEST__` + the test ids of 7.3. Without `shot=1` behaviour is unchanged (test).
- H0-A5 Determinism: two consecutive runs of the same scenario give pixel-identical PNGs, or <=0.1% differing pixels with the diff written to the card.
- H0-A6 `pnpm test` includes a unit test for harness arg parsing, port refusal and fixture loading.
- H0-A7 Verify (and document) whether the Hermes watcher reads existing `agent.log` lines or only appended ones; harness handles both.
- Screenshots (self-test of the harness, existing UI only), folder `docs/screenshots/<H0-id>/`:
  1. `01-baseline-overlay-off-desktop.png` canvas with fixtures, cost overlay off.
  2. `02-baseline-overlay-on-desktop.png` existing cost pills and panel.
  3. `03-baseline-overlay-on-phone.png`.
  4. `04-agent-hover-desktop-hover.png` hover on an agent proves mouse driving works.
  5. `05-agent-tap-phone.png` proves touch driving works.

### P0. Refresh catalog data + per-model cache multipliers; correct stale tests (omh-coder)
- P0-A1 Catalog data for Anthropic (from https://platform.claude.com/docs/en/about-claude/pricing; read the full page, v1 only captured rows) and Copilot (section 3.3, whole page) with `source` URL and `asOf`; a test fails if any row lacks either.
- P0-A2 `pricing.ts` shim keeps signatures; cache-read multiplier per model (0.1/0.05/0.025); writes 1.25x/2x.
- P0-A3 `pricing.test.ts`: haiku-5-5 corrected (0.10/0.50 up to 100K prompt tokens, 0.50/2.50 above); the unknown-model fallback assertion changed deliberately and noted in the commit message; Opus 5 vs 5.5, Fable 5/5.1/5.2, `.` == `-` normalisation pinned.
- P0-A4 Dated rows encoded (`validUntil`/`afterRate`) with a test at 2026-11-30 and 2026-12-01 for Gemini 4 Carbon.
- P0-A5 `canvas-constants.ts` blended-rate duplicates removed or derived from the catalog; `format-model-name.test.ts` (uses `CLAUDE_FAMILIES`) still passes.
- P0-A6 Comment contains a before/after table of cost for the fixture token counts, so the number change is explicit.
- No UI structure change; **screenshots not required** (numbers only). First visual proof of new numbers is P4.

### P1. Pure `costs/` modules (omh-coder)
- P1-A1 `types, validate, resolve, price, format, tooltip, tiers` exist, zero imports from `vscode`, `fs`, `os`.
- P1-A2 v1 test plan items 1-9 and 14-17 implemented (v1 section 7) with the section 6.4 pins; plus: resolution order table (5 levels), glob matcher, `__proto__` rejection, size cap, tier-boundary membership, `classifyBilling` truth table (all four kinds, including `rateSource: fallback -> estimated`), `implicitCacheWrite` (>=1,024 threshold, reported write wins, off switch).
- P1-A3 `buildCostTooltip` returns all mandatory rows of 6.1 for one fixture per kind (billed, list-equivalent, estimated, unpriced, copilot, local placeholder).
- P1-A4 `pricing.ts` shim and `draw-cost.ts` still compile and behave as before for existing call sites (no UI change).
- P1-A5 `scripts/costs-boundaries.test.ts` fails when the two `TIER_BOUNDARIES` copies or a catalog threshold diverge.

### P2. Provider/timing capture + tiered ingestion (omh-coder)
- P2-A1 `scripts/hermes-logs.ts` captures `provider` and `latency` (and `write=` when present); `hermes-logs.test.ts` covers `API_LINE`, `API_NO_CACHE`, a `provider=copilot` line with `cache=`, a line with no `latency`.
- P2-A2 `SpendTotals` gains `provider?` and `byBucket?` in **both** `extension/src/protocol.ts` and `web/lib/agent-types.ts`; `handle-message-events.ts` `parseSpend` accepts them; `usage-ledger.ts` records `byBucket` via `extension/src/spend-tiers.ts`; dedupe by message id still passes (extension test).
- P2-A3 Hermes handler summed `byBucket` equals the flat totals (property test).
- P2-A4 Codex files untouched (`git diff --stat` shows none).
- P2-A5 Reconcile note: with Copilot fixture lines the list-equivalent total is computed and compared with `/home/idv/workspace/copilot_costs_daily_2026-11-06.csv` **qualitatively only** (that CSV has day totals, not per-call); document the gap.
- No UI. No screenshots.

### P3. Host config loader + `costs-config` message (omh-coder)
- P3-A1 `extension/src/costs-config.ts` load/merge/validate (project > user > VS Code scalar > catalog), hot reload with debounce, atomic write 0600; keeps last-good on error.
- P3-A2 Relay and standalone app load the same file with `HOME` honoured; `costs-config` message reaches the webview via SSE and the extension bridge; `protocol.ts` and `agent-types.ts` stay consistent.
- P3-A3 `package.json` contributes the scalar settings (`enabled, displayCurrency, unit, unknownModelPolicy, configPath`) and `agentVisualizer.openCostsConfig`; `costs.schema.json` shipped for editor autocomplete.
- P3-A4 A project-level `.agent-flow/costs.json` cannot set `configPath` and cannot read or write outside its directory (test).
- P3-A5 Config error banner (`config-error-banner.tsx`) lists JSON-pointer errors; last-good config keeps pricing.
- Screenshots (folder `docs/screenshots/<P3-id>/`):
  1. `01-config-error-banner-desktop.png` fixture C-invalid, banner with 2+ JSON-pointer errors (proves P3-A5).
  2. `02-config-error-banner-phone.png` same, phone, banner readable, not clipped.
  3. `03-hot-reload-before-usd-desktop.png` C-default, pill in USD.
  4. `04-hot-reload-after-eur-desktop.png` same agent after rewriting `costs.json` to C-eur without restart, pill in EUR (proves P3-A1/A2).

### R1. Review P1-P3 (omh-reviewer)
- R1-A1 Verdict addressing: validation completeness, prototype pollution, regex-free matching, path traversal for project config, atomic write mode, `rootDir` boundary respected (no `extension/src` -> `web/lib` import), test commands run by the reviewer with output quoted.
- R1-A2 Reviewer opens the P3 screenshots, states what they show, and independently re-captures at least one (banner, desktop) with the harness.
- R1-A3 Findings are actionable (`kanban_request_changes`) or the card completes with the evidence list.

### P4. Cost overlay: units, kind badges, tooltips, settings drawer (omh-coder)
- P4-A1 `draw-cost.ts` uses `costs/price.ts`; `modelCostRate`/`MODEL_FAMILY_COST` path gone; pill text per 7.1; summary panel split by kind.
- P4-A2 Cost tooltip (6.1) on hover (desktop) and tap (phone) for every kind; `findCostPillAt` unit-tested on rectangles.
- P4-A3 Every tooltip states provider, kind (billed / list-equivalent / estimated), rate source, formula; asserted from the DOM text in a test and visible in the screenshots.
- P4-A4 `display.subscriptionValue = hide` hides subscription/credits money and totals as specified in Q10.
- P4-A5 Settings drawer edits write through the host with validation errors inline.
- P4-A6 `build:webview` and `build:extension` compile; no `vscode` import in `web/`.
- Screenshots (folder `docs/screenshots/<P4-id>/`; D = desktop 1440x900, P = phone 390x844):

| # | File slug | Fixture / state | Viewport | Hover | Proves |
|---|---|---|---|---|---|
| 1 | `overlay-default-usd` | F-A..F-H, C-default | D | no | A1 pills and panel for all kinds |
| 2 | `overlay-default-usd` | same | P | no | A1 narrow layout |
| 3 | `tt-billed-claude-api` | F-A pill | D | yes | A2/A3 billed |
| 4 | `tt-listequiv-claude-sub` | F-B pill | D | yes | A3 list-equivalent + badge |
| 5 | `tt-copilot-claude-haiku` | F-E claude-haiku-5.5 | D | yes | A3 Copilot provider, credits wording, implicit cache-write line |
| 6 | `tt-copilot-gemini` | F-E gemini-3.8-flash | D | yes | A3 non-Claude Copilot rate |
| 7 | `tt-haiku-tier-high` | F-C 120K-prompt call | D | yes | A3 tier line (>100K) |
| 8 | `tt-unknown-fallback` | F-G | D | yes | A3 estimated + fallback rate source |
| 9 | `tt-estimate-no-usage` | F-H | D | yes | A3 estimated, unreported usage |
| 10 | `tt-listequiv-claude-sub` | F-B | P | tap | A2 touch tooltip |
| 11 | `tt-copilot-claude-haiku` | F-E | P | tap | A2 touch, Copilot |
| 12 | `summary-split-by-kind` | all | D | no | A1 totals per kind |
| 13 | `overlay-eur` | C-eur | D | no | currency and FX label |
| 14 | `subscription-hidden` | `subscriptionValue=hide` | D | no | A4 |
| 15 | `unit-tokens` | unit = tokens | D | no | A1 unit toggle |
| 16 | `settings-drawer` | C-default | D | no | A5 |
| 17 | `settings-drawer` | C-default | P | no | A5 narrow |
| 18 | `settings-drawer-validation-error` | bad rate typed | D | no | A5 inline error |

### P5. Energy module + hour-bucket ingestion + kWh UI (omh-coder)
- P5-A1 `energy.ts` implements v1 3.2 (interval sweep, marginal default, tariff by hour bucket, time-of-day split, 23h/25h DST days, midnight wrap, throughput fallback, tool-execution time excluded).
- P5-A2 v1 tests 10-13 implemented. The worked example `(320-45) W x 36 s = 9,900 J = 0.00275 kWh` is asserted; two fully overlapping calls each get half, total conserved.
- P5-A3 Hour-bucketed busy time stored at ingestion (Hermes handler); editing the config re-prices history without re-ingesting (test).
- P5-A4 Tooltip for local pills shows kind `estimated (configured power)`, busy-time source, watts, attribution, tariff window.
- P5-A5 No hardware presets shipped; the drawer shows a "how to measure" hint.
- Screenshots (folder `docs/screenshots/<P5-id>/`):

| # | File slug | Fixture | Viewport | Hover | Proves |
|---|---|---|---|---|---|
| 1 | `overlay-kwh` | F-F, C-local-energy, unit kWh | D | no | A1/A4 kWh pill |
| 2 | `overlay-kwh` | same | P | no | narrow |
| 3 | `tt-local-energy` | F-F pill | D | yes | A4 formula with watts and busy time |
| 4 | `tt-local-tariff-split` | F-F call across 22:00 boundary | D | yes | A1 time-of-day split shown |
| 5 | `drawer-energy-profile` | C-local-energy | D | no | A5 profile + tariff editor + hint |
| 6 | `drawer-energy-profile` | same | P | no | narrow |
| 7 | `summary-with-local` | F-A..F-H | D | no | totals by kind incl. local |

### P6a. Observed limits: statusLine shim, installer, limits file (omh-coder; needs S1)
- P6a-A1..A8 = the eight requirements of section 8, each with a test (chaining preserves stdout and exit code; refuse cases b/c/d; idempotent; exact uninstall; whitelisted keys only; 0600 modes; p95 added latency).
- P6a-A9 `limits-observer.ts` reads `~/.agent-flow/limits/claude.json`, classifies windows by key, tolerates absent windows and stale files.
- P6a-A10 Codex `rate_limits` is **not** parsed (out of scope).
- P6a-A11 Design follows S1: if S1 shows hooks carry `rate_limits`, the card states so and proposes dropping the wrapper; installer is not built until the orchestrator confirms.
- Screenshots (drawer status only; folder `docs/screenshots/<P6a-id>/`):

| # | File slug | Fixture | Viewport | Proves |
|---|---|---|---|---|
| 1 | `limits-source-observed` | L-1 file present | D | A9 "observed via statusLine, as of HH:MM" |
| 2 | `limits-source-observed` | L-1 | P | narrow |
| 3 | `limits-source-not-installed` | none | D | install call-to-action |
| 4 | `limits-source-refused` | existing non-command statusLine | D | A1 refusal reason shown |
| 5 | `limits-source-stale` | L-3 | D | A8 stale tag |

### P6b. Limits estimator, window tracker, calibration, Fable estimate, LIMITS panel (omh-coder)
- P6b-A1 `limits.ts` + `fable-estimate.ts` implement section 6.3-6.5; the golden example reproduces **3.4‰ / 1.6‰ / 7.6‰**, `confidence low`; invariant `p_lo <= p_pt <= p_hi` property-tested; basis 1/2/3/4 each tested; H1/H2 union tested.
- P6b-A2 `formatLimitPct` pins of 6.4 pass; the Fable bounds format independently.
- P6b-A3 Counted-provider filter: Copilot Fable calls do not create a Fable row (test).
- P6b-A4 Visibility: Fable row present **iff** Fable used in the weekly window; absent otherwise (both fixtures); interpretation noted in 1.1.
- P6b-A5 Estimate icon on Fable row; hover shows lower, upper, confidence, calibration basis, as in 6.3 (DOM text asserted).
- P6b-A6 Observed rows carry `obs`, no icon; estimates carry `~`/`>=`; plan `api` hides the panel; Pro shows no Fable bar.
- Screenshots (folder `docs/screenshots/<P6b-id>/`):

| # | File slug | Fixture | Viewport | Hover | Proves |
|---|---|---|---|---|---|
| 1 | `limits-observed-no-fable` | L-1 (5h 37%, 7d 4.2%, no Fable calls) | D | no | A4 no Fable row; A6 `obs` tags |
| 2 | `limits-observed-no-fable` | L-1 | P | no | A4 narrow |
| 3 | `limits-fable-used` | L-2 (Fable calls in window; golden numbers) | D | no | A4 row present, A5 icon, `3.4‰` shown |
| 4 | `limits-fable-used` | L-2 | P | no | narrow |
| 5 | `fable-tooltip` | L-2 Fable row | D | yes | A5 bounds `1.6‰`/`7.6‰`, confidence low, basis text |
| 6 | `fable-tooltip` | L-2 Fable row | P | tap | A5 touch |
| 7 | `limits-5h-tooltip` | L-1 5h row | D | yes | observed source, resets_at |
| 8 | `limits-estimate-only` | L-4 (no meter, calibrated budget) | D | no | A6 `~`/`>=`, no `obs` |
| 9 | `limits-uncalibrated` | L-4 without budget | D | no | "set limit" state |
| 10 | `limits-stale` | L-3 | D | no | stale tag |
| 11 | `limits-tiny-fable` | Fable 0.003% | D | no | `<0.1‰` rendering |
| 12 | `limits-hidden-api` | plan `api` | D | no | A6 panel hidden |

### R2. Review P6a/P6b (omh-reviewer)
- R2-A1 Verdict on settings.json edit safety (all of section 8), privacy of limit files, confidence labelling not overstating (Fable never shown without icon, observed never shown with it), no Codex code, no usage-endpoint code (`grep` evidence quoted).
- R2-A2 Reviewer opens at least screenshots P6b-3, P6b-5, P6a-4, states what they show, independently re-captures P6b-5 (hover) with the harness.
- R2-A3 Re-runs the chain commands and quotes the output.

### W1. Docs (omh-writer)
- W1-A1 README section: config file, precedence, billing kinds, Copilot caveats, local energy, limits and the Fable estimate, statusLine installer and reversal, privacy.
- W1-A2 `costs.schema.json` referenced; CHANGELOG entry; every number in the docs traced to a section of this plan.
- W1-A3 Screenshots reused from the harness (not hand-made), stored under `docs/screenshots/<W1-id>/`: `01-overview-desktop`, `02-overview-phone`, `03-cost-tooltip-copilot-hover`, `04-fable-tooltip-hover`, `05-settings-drawer-desktop`; all inspected and described in the comment.
- W1-A4 No claims about Copilot billed amounts; the list-equivalent wording is used verbatim.

### D1. Deploy (omh-builder or omh-coder; the only task that restarts services)
- D1-A1 Build from the branch HEAD named in the card; `pnpm run build:app` and the standard release checks pass (output quoted).
- D1-A2 Build identity: the deployed app exposes branch and commit (`build-branch` / `build-commit` meta tags in the page head and the same values in `/health` or the existing health route). `app/src/build-info.ts` exists and the server prints `build <branch> @ <commit>` [SRC]; D1 verifies the meta tags and `/health` against the commit, and **reports a gap if absent** rather than skipping.
- D1-A3 Rollback command documented and tested on a scratch port before the restart.
- D1-A4 Never merges into main without an explicit instruction from Webbugt (comment states "not merged").
- D1-A5 Post-deploy smoke: relay on 3001 and proxy on 3301 respond; no secrets in logs.
- Screenshots of the **deployed** instance with `AGENT_FLOW_ANONYMIZE_CONTENT=all` (folder `docs/screenshots/<D1-id>/`): `01-overlay-desktop`, `02-overlay-phone`, `03-cost-tooltip-hover-desktop`, `04-limits-panel-desktop` (whichever limits state is real; if none observed, the estimate-only state), `05-build-identity.png` or a text capture of the head meta tags and `/health` output. Any real-data frame must contain no prompt text, session names that identify people, or credentials; otherwise redact before attaching.

---------------------------------------------------------------------------

## 10. Fixtures (H0 deliverable, synthetic)

| ID | Content |
|---|---|
| F-A | Claude Code transcript: Sonnet 5.5, billing `api`, with cache reads |
| F-B | Claude Code subscription (Hermes `claude-subscription-directsdk-experimental` line style): Opus 5.5 with cache read + write |
| F-C | Haiku 5.5, one call at 90K prompt tokens and one at 120K |
| F-D | Fable 5.2 calls (counted provider) |
| F-E | Hermes lines `provider=copilot`: `claude-haiku-5.5` (no cache, no write), `gemini-3.8-flash` (with `cache=`), `gpt-6.1-sol` |
| F-F | Hermes lines `provider=ollama` with `latency=` and a call straddling 22:00 |
| F-G | Model `acme-xyz-9` (unknown) |
| F-H | Agent with no usage reported (context-size estimate path) |
| L-1 | `limits/claude.json`: five_hour 37%, seven_day 4.2%, fresh; no Fable calls in window |
| L-2 | as L-1 plus F-D calls and the golden pairs (180,190,195,200,205,210), u = 0.34 |
| L-3 | L-1 with a timestamp older than the stale threshold |
| L-4 | no limits file; budget either set (calibrated) or absent |
| C-default / C-eur / C-invalid / C-local-energy | cost config variants (no file; EUR with fx; two JSON-pointer errors; ollama profile + tariff) |

---------------------------------------------------------------------------

## 11. Risks, unknowns and blockers

### Blockers needing a human or another profile
- **B-0 (this card): the doc is written but NOT committed.** This profile has no terminal or git, so acceptance item "v2 doc committed" is unmet by me. A follow-up card for a terminal-capable profile commits `docs/PLAN-configurable-costs-v2.md` (card id in the completion comment).
- **B-1 (S1):** the S1 card is assigned to `omh-researcher`, which cannot run Claude Code or capture a live `statusLine` payload. Suggest reassigning S1 to `omh-coder` or `omh-builder`, or accepting a documentation-only S1 (not sufficient to unblock P6a, see P6a-A11). A live capture also needs a logged-in Claude subscription on this host; use an isolated `CLAUDE_CONFIG_DIR`.

### Unknowns (labelled, each with the task that resolves it)
| ID | Unknown | Resolved by |
|---|---|---|
| U-1 | Whether `statusLine`/hooks expose `rate_limits` today and any Fable key (today's re-fetch of the statusline page was truncated) | S1 |
| U-2 | Whether observed `seven_day` includes Fable usage (H1 vs H2) | S1 / anchors; both hypotheses applied until then |
| U-3 | Whether Copilot Claude implicit cache-write inference matches GitHub's bill; whether "threshold input tokens" counts cached tokens | P2/P4 reconcile on real data; `copilot-costs` ledger as the reference |
| U-4 | Whether `~/.vscode-server/.../session.db` `turn_usage` is ever populated and its format (0 rows in 3 samples) | out of chain; F-1 |
| U-5 | Relative weight of Fable versus other models for limit use | manual anchors; prior band `[0.5, 2]` until then |
| U-6 | Hermes cache TTL for 1h writes (already in `FUTURE.md`) | keep 5m assumption; `hermesCacheTtl` option |
| U-7 | Local-runtime `provider=` strings (none present on host) | first real local use; fixtures meanwhile |
| U-8 | Node global `WebSocket` availability for the CDP harness | H0-A1 |

### Risks (carried from v1, updated)
- Subscription limits are not published in tokens and change at Anthropic's discretion -> observed-first, estimates tagged, every estimate a lower bound.
- statusLine takeover breaks a user's status line -> section 8 + R2.
- Copilot figures read as bills -> kind `list-equivalent`, wording fixed in 6.1, W1-A4.
- Catalog drift and dated promos (section 3.3) -> `asOf`, `validUntil`, test on missing `source`.
- Tooltip hit-testing on canvas is new -> pure rectangle tests in P4-A2; DOM tooltip, not canvas text.
- Harness flakiness (force layout) -> `?shot=1` freeze, H0-A5.
- `rootDir` boundary regressions -> R1-A1, `build:extension`/`lint` in every task.
- Config-file attack surface (shared repos) -> v1 risk mitigations kept; P3-A4.

### Future work (not in this chain)
- F-1: read-only import of the `copilot-costs` ledger / official daily billing as the "billed" reference for Copilot, and VS Code `turn_usage` if it turns out populated.
- F-2: Codex (needs Q8 answered).
- F-3: measured power (S3).

---------------------------------------------------------------------------

## 12. Sources

Primary [DOC]:
- GitHub Copilot models and pricing: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing (fetched 2026-11-25; AI credits, 1 credit = $0.01; price tables; promo footnotes; code-review note).
- Anthropic API pricing: https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-11-23 for v1; P0 re-reads in full).
- Usage and length limits: https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work (v1, 2026-11-23).
- Plans: https://claude.com/pricing (v1, 2026-11-23).
- Status line: https://code.claude.com/docs/en/statusline (schema from v1, 2026-11-23; 2026-11-25 re-fetch returned only the intro).
- Costs and settings reference: https://code.claude.com/docs/en/costs, https://code.claude.com/docs/en/settings-reference#modelpricing (v1).

Third party [3P] (unchanged from v1): anthropics/claude-code issues #78232 and #88137; community statusline repos (search snippets only).

Host observations [OBS] (2026-11-25): `/home/idv/.hermes/profiles/sophia/logs/agent.log` (lines 5, 9, 14); `/home/idv/.copilot/logs/process-1795424706590-3632357.log`; `/home/idv/.copilot/session-state/`; `/home/idv/.vscode-server/data/agentSessionData/{088585c6-...,b086b88c-...,75ff402a-...}/session.db`; `/home/idv/.hermes/profiles/omh-researcher/cache/copilot_pricing_live.json` (the `copilot-costs` plugin's live-pricing cache; per-model `default`/`long_context` rates, `threshold`, `max_prompt_tokens`, `cache_write_1h`; first 80 lines read); `/home/idv/workspace/project-readmes/hermes-copilot-costs.README.md`; `/home/idv/workspace/reports/copilot-cost-diagnosis-2026-11-12.md`; `/home/idv/workspace/copilot_costs_daily_2026-11-06.csv`.

Repo evidence [SRC] (worktree, branch `feature/configurable-costs`): `web/lib/pricing.ts`, `web/lib/pricing.test.ts`, `web/lib/canvas-constants.ts`, `web/lib/session-detail.ts`, `web/components/agent-visualizer/canvas/draw-cost.ts`, `web/components/agent-visualizer/index.tsx`, `web/hooks/use-canvas-interaction.ts`, `extension/src/usage-ledger.ts`, `extension/src/protocol.ts`, `extension/src/constants.ts`, `extension/tsconfig.json`, `extension/package.json`, `scripts/hermes-logs.ts`, `scripts/hermes-logs.test.ts`, `scripts/relay.ts`, `app/src/server.ts`, root and `web/package.json`.
