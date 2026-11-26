# Price catalog sources and verification log

Code: `web/lib/costs/catalog/anthropic.ts`, `web/lib/costs/catalog/copilot.ts` (lookup in `catalog/index.ts`,
checks in `web/lib/costs/catalog.test.ts`). All prices are USD per 1M tokens. Every row carries `source` and
`asOf`; a test fails if either is missing. Task: t_00f2f4ac (plan task P0).

## Verification

| Sheet | Live page | Verified | How |
|---|---|---|---|
| `anthropic` | https://platform.claude.com/docs/en/about-claude/pricing | **2026-11-25** | Page rendered in a real browser (Chrome via the browser tool) and its full text read (`document.body.innerText`, 1,164 lines): Model pricing, Prompt caching (incl. the per-model cache-hit table), Long context pricing, Fast mode pricing, Batch processing. Cross-checked with a second fetch (`web_extract`); numbers agree. |
| `copilot` | https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing | **2026-11-25** | Page fetched in full with `web_extract` (every table, all five footnotes, code-review section). No snippets used. |

Discrepancy to know about: the `web_extract` snapshot of the Anthropic page printed a footnote marker "3" on the Sonnet 5
input and output cells whose text was cut off; the rendered page in the browser shows no footnote there, and both fetches agree
on Sonnet 5 = $2 / $10 / write $2.50 / $4 / read $0.20. Treated as rendering noise; the numbers did not differ.

## Anthropic sheet

Cache multipliers are **per model** (page section "What a cache hit costs depends on the model"):

| Models | Cache hit multiplier | 5m write | 1h write |
|---|---|---|---|
| Fable 5.2, Mythos 5.2 | 0.025x ($0.20) | 1.25x | 2x |
| Fable 5.1, Mythos 5.1 | 0.025x ($0.25) | 1.25x | 2x |
| Opus 5.5 | 0.05x ($0.20) | 1.25x | 2x |
| Sonnet 5.5 | 0.05x ($0.10) | 1.25x | 2x |
| everything else (Fable 5, Mythos 5, Opus 5 and older, Sonnet 5 and older, Haiku 5.5, Haiku 4.5) | 0.1x | 1.25x | 2x |

Old code assumed 0.1x everywhere, which overstated cache reads 2x on Opus 5.5 / Sonnet 5.5 and 4x on Fable 5.1/5.2.

| Model | Input | Output | 5m write | 1h write | Cache hit |
|---|---|---|---|---|---|
| Claude Fable 5.2 | 8 | 40 | 10 | 16 | 0.20 |
| Claude Mythos 5.2 (limited availability) | 8 | 40 | 10 | 16 | 0.20 |
| Claude Fable 5.1 | 10 | 50 | 12.50 | 20 | 0.25 |
| Claude Mythos 5.1 (limited availability) | 10 | 50 | 12.50 | 20 | 0.25 |
| Claude Fable 5 | 10 | 50 | 12.50 | 20 | 1 |
| Claude Mythos 5 (limited availability) | 10 | 50 | 12.50 | 20 | 1 |
| Claude Opus 5.5 | 4 | 20 | 5 | 8 | 0.20 |
| Claude Opus 5 | 5 | 25 | 6.25 | 10 | 0.50 |
| Claude Opus 4.8 / 4.7 / 4.6 / 4.5 | 5 | 25 | 6.25 | 10 | 0.50 |
| Claude Opus 4.1, Opus 4 (retired except Google Cloud/Bedrock) | 15 | 75 | 18.75 | 30 | 1.50 |
| Claude Sonnet 5.5 | 2 | 10 | 2.50 | 4 | 0.10 |
| Claude Sonnet 5 | 2 | 10 | 2.50 | 4 | 0.20 |
| Claude Sonnet 4.6 / 4.5 / 4 | 3 | 15 | 3.75 | 6 | 0.30 |
| Claude Haiku 5.5, prompt <= 100,000 tokens | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| Claude Haiku 5.5, prompt > 100,000 tokens | 0.50 | 2.50 | 0.625 | 1 | 0.05 |
| Claude Haiku 4.5 | 1 | 5 | 1.25 | 2 | 0.10 |

Haiku 5.5 is the only tiered Anthropic model. The page: the prompt length "counts all of its input tokens, including cache reads
and cache writes", and "each request is priced on its own". Claude 4.6 and later (except Haiku 5.5) include the full 1M context at standard pricing.

Fast mode (rows `*-fast`, reachable only by an explicit `-fast` id because usage logs do not change the model id):
Fable 5.2 and Mythos 5.2 $16 / $80, Opus 5.5 $8 / $40, Opus 5 and Opus 4.8 $10 / $50. Input and output are listed; the cache
rates apply the stated multipliers on top ("Prompt caching multipliers apply on top of fast mode pricing"), so those three
fields are flagged `unverified: derived` in the catalog. The Copilot sheet's Opus 4.8 fast row ($10 / $1 / $12.50 / $50) matches the derivation.

Not in the catalog (stackable modifiers, listed on the page, to be handled as config): Batch API -50% (listed per model, exactly half),
US-only data residency x1.1 (Claude 4.6+), Bedrock/Vertex regional premium +10%, web search $10 per 1,000, code execution $0.05/h beyond 1,550 free h,
Managed Agents $0.08 per session-hour.

## Copilot sheet

1 AI credit = $0.01. Rates are list-equivalent: plan allowances are not subtracted. 35 rows (OpenAI 11, Anthropic 12, Google 5, Microsoft 3, xAI 3, Moonshot 1; tiers are inside a row):
OpenAI GPT-5.3-Codex, GPT-5.4 nano, GPT-5.6 Luna/Sol, GPT-6 Astra/Luna/Sol, GPT-6.1 Sol/Terra, GPT-6.2 Astra/Sol; Anthropic Haiku 4.5, Haiku 5.5,
Sonnet 4, 4.6, 5, 5.5, Opus 4.8, Opus 4.8 fast (preview), Opus 5.5, Fable 5, 5.1, 5.2; Google Gemini 3.8 Flash, 4 Argon, 4 Carbon, 4 Hydrogen, 4 Neon;
Microsoft MAI-Code-1.1-Flash, MAI Code 2, MAI Code 2 Flash; xAI Grok 4.5, 4.6, 4.7; Moonshot Kimi K3. Exact figures: `catalog/copilot.ts`
(a test counts the rows against the page). Tier thresholds: Haiku 5.5 100K; GPT-5.6 Luna and Grok 4.5-4.7 200K; every other tiered GPT 272K.
"Cache write: Not applicable" (GPT-5.3-Codex, GPT-5.4 nano, all Gemini, Microsoft, xAI, Kimi) is stored as `null`: written tokens bill as plain input.
Copilot lists no 1-hour write for any model (`null`: falls back to the 5m write).

Dated prices (encoded as `validUntil` UTC midnight, exclusive, plus `afterRate`; resolved by event time):

| Model | Promo price | Change | After |
|---|---|---|---|
| Gemini 4 Carbon | $2 / $0.10 / $10 | **2026-12-01** | $4 / $0.20 / $20 (footnote 3) |
| Gemini 4 Argon | $2 / $0.10 / $10 | 2026-12-01 | **not published** (flagged `afterPromoRate`, promo rate kept and marked) |
| Gemini 3.8 Flash | $0.75 / $0.075 / $3.75 | "through December 31, 2026" = `validUntil` 2027-01-01 | **not published** (flagged) |
| MAI Code 2 | $0.50 / $0.025 / $2.50 | 2027-05-17 | $1 / $0.05 / $5 |
| MAI Code 2 Flash | $0.05 / $0.005 / $0.25 | 2027-05-17 | $0.10 / $0.01 / $0.50 |

Not priced (documented): GPT Image 2.5 Flare (image generation, text/image units); code completions and next-edit suggestions (not billed in AI credits);
Copilot code review (per-review estimates, undisclosed model); the empty "Fine-tuned (GitHub)" table; legacy request-based multipliers for annual plans.

## Unverified / not confirmed on the live page

| Item | Status |
|---|---|
| Copilot tiered rows: do cached tokens count toward the "input tokens" threshold? | Not stated on the Copilot page; flagged `thresholdCountsCache` on every tiered Copilot row. Anthropic's page says its own Haiku 5.5 threshold counts cache reads and writes; same convention is used. |
| Gemini 4 Argon and Gemini 3.8 Flash price after the promo | Not published; the promo rate stays and the resolver reports `promoExpiredNoRate`. |
| Fast-mode cache rates (5 Anthropic `*-fast` rows) | Derived from the stated multipliers, flagged. |
| Timezone of the promo cut-over dates | Vendor gives dates only; UTC midnight is assumed. |
| Implicit cache-write on Copilot Claude models (plan section 3.3) | Out of P0 scope (P1/P2); still unverified against GitHub's bill. |

## Behaviour changes in `spendUsd` / estimate path (and what is NOT fixed here)

- Model resolution: exact catalog id (`.` == `-`, date stamps and `[1m]` ignored) -> newest model of the same Claude family (`match: family`) -> Sonnet 5.5 rate
  (`match: fallback`). The fallback was Sonnet 4-era $3 / $15; it is now $2 / $10 (the newest Sonnet-class list price). Models with their own
  Copilot row (gpt-5.3-codex, gemini-3.8-flash, gpt-6.1-sol ...) are priced from it instead of the fallback.
- The context-size estimate rate (`modelCostRate` in `draw-cost.ts`) now comes from the catalog too; the duplicated rate tables in
  `canvas-constants.ts` (`CLAUDE_FAMILIES.rate`, `MODEL_FAMILY_COST`, `COST_RATE`) are gone.
- Known, not fixed here: (1) `SpendTotals` is cumulative with one `model`, so the Haiku 5.5 / GPT / Grok long-prompt tiers cannot apply until per-request buckets exist (P2),
  and an agent that switched models is priced at the latest model (visible in fixture F-E); (2) local models (fixture F-F, `provider=ollama`) are still priced at the
  fallback in the overlay, which P1/P4 replaces with "unpriced / energy".

## Before / after (cost overlay, desktop 1440x900, fixture sessions of the H0 harness)

Screenshots in `docs/screenshots/t_00f2f4ac/before` (code at 972fb27) and `.../after` (this change). Pills: Sub Demo (Hermes, Opus 5.5) $0.204 -> $0.143;
Copilot Demo (Hermes, last model gpt-6.1-sol) $0.135 -> $0.088; Fixture F-A (estimate) ~$0.030 -> ~$0.020; F-D (estimate) ~$0.101 -> ~$0.081;
F-C (estimate, Haiku 5.5) ~$0.010 -> ~$0.0010. The table with token counts and reasons is the header comment of `web/lib/pricing.ts`.
