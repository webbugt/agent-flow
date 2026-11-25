import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spendUsd, priceForModel } from './pricing'
import type { SpendTotals } from './agent-types'

const zero: SpendTotals = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('priceForModel matches catalog models, family members and falls back to Sonnet 5.5', () => {
  assert.deepEqual(priceForModel('claude-opus-4-7'), { input: 5, output: 25 })
  // Corrected in the catalog refresh (2026-11-25): was 1 / 5. Haiku 5.5 is 0.10 / 0.50 up to 100K prompt tokens.
  assert.deepEqual(priceForModel('claude-haiku-5-5'), { input: 0.1, output: 0.5 })
  assert.deepEqual(priceForModel('claude-haiku-5-5', { promptTokens: 100_000 }), { input: 0.1, output: 0.5 })
  assert.deepEqual(priceForModel('claude-haiku-5-5', { promptTokens: 100_001 }), { input: 0.5, output: 2.5 })
  // Corrected deliberately: an unknown model used to fall back to the Sonnet 4-era 3 / 15; the fallback is now the
  // newest Sonnet-class list price (Sonnet 5.5, 2 / 10). A test-only id keeps this independent of catalog growth.
  assert.deepEqual(priceForModel('acme-xyz-9'), { input: 2, output: 10 })
  assert.deepEqual(priceForModel(undefined), { input: 2, output: 10 })
  // gpt-5.3-codex is a Copilot sheet row now (1.75 / 14), no longer a fallback.
  assert.deepEqual(priceForModel('gpt-5.3-codex'), { input: 1.75, output: 14 })
})

test('Opus 5 vs 5.5, Fable 5 / 5.1 / 5.2 and Sonnet 5 vs 5.5 are priced separately', () => {
  assert.deepEqual(priceForModel('claude-opus-5'), { input: 5, output: 25 })
  assert.deepEqual(priceForModel('claude-opus-5-5'), { input: 4, output: 20 })
  assert.deepEqual(priceForModel('claude-fable-5'), { input: 10, output: 50 })
  assert.deepEqual(priceForModel('claude-fable-5-1'), { input: 10, output: 50 })
  assert.deepEqual(priceForModel('claude-fable-5-2'), { input: 8, output: 40 })
  assert.deepEqual(priceForModel('claude-sonnet-5'), { input: 2, output: 10 })
  assert.deepEqual(priceForModel('claude-sonnet-4-6'), { input: 3, output: 15 })
})

test('"." and "-" in model ids are the same model; date stamps and [1m] are ignored', () => {
  for (const id of ['claude-haiku-5.5', 'claude-haiku-5-5', 'Claude Haiku 5.5', 'CLAUDE-HAIKU-5-5', 'claude-haiku-5-5[1m]']) {
    assert.deepEqual(priceForModel(id), { input: 0.1, output: 0.5 }, id)
  }
  assert.deepEqual(priceForModel('claude-opus-4-1-20250805'), { input: 15, output: 75 })
  assert.deepEqual(priceForModel('anthropic/claude-sonnet-5.5'), { input: 2, output: 10 })
})

test('an unlisted version of a known family is priced like the newest model of that family', () => {
  assert.deepEqual(priceForModel('claude-opus-6-0'), { input: 4, output: 20 })
  assert.deepEqual(priceForModel('claude-fable-6'), { input: 8, output: 40 })
})

test('spendUsd prices input, output and each cache bucket separately', () => {
  const spend: SpendTotals = {
    ...zero,
    model: 'claude-sonnet-4-6',
    inputTokens: 1_000_000,       // $3
    outputTokens: 1_000_000,      // $15
    cacheReadTokens: 1_000_000,   // $0.30
    cacheWrite5mTokens: 1_000_000, // $3.75
    cacheWrite1hTokens: 1_000_000, // $6
  }
  near(spendUsd(spend), 28.05)
})

test('spendUsd applies the per-model cache-read multiplier (0.1x / 0.05x / 0.025x)', () => {
  const reads = (model: string) => spendUsd({ ...zero, model, cacheReadTokens: 1_000_000 })
  near(reads('claude-sonnet-4-6'), 0.3)    // 0.1x of 3
  near(reads('claude-fable-5'), 1)         // 0.1x of 10 (Fable 5 kept 0.1x)
  near(reads('claude-opus-5-5'), 0.2)      // 0.05x of 4
  near(reads('claude-sonnet-5-5'), 0.1)    // 0.05x of 2
  near(reads('claude-fable-5-1'), 0.25)    // 0.025x of 10
  near(reads('claude-fable-5-2'), 0.2)     // 0.025x of 8
})

test('cache writes: Anthropic 5m 1.25x and 1h 2x; models without a write price bill written tokens as input', () => {
  const w5 = (model: string) => spendUsd({ ...zero, model, cacheWrite5mTokens: 1_000_000 })
  const w1 = (model: string) => spendUsd({ ...zero, model, cacheWrite1hTokens: 1_000_000 })
  near(w5('claude-opus-5-5'), 5)
  near(w1('claude-opus-5-5'), 8)
  near(w5('claude-fable-5-2'), 10)
  near(w1('claude-fable-5-2'), 16)
  // Gemini 3.8 Flash lists no cache write: written tokens bill at the 0.75 input rate; 1h falls back to the same.
  near(w5('gemini-3.8-flash'), 0.75)
  near(w1('gemini-3.8-flash'), 0.75)
  // Copilot lists no 1h write for Claude models; with the copilot sheet preferred it falls back to the 5m write.
  near(spendUsd({ ...zero, model: 'claude-opus-5-5', cacheWrite1hTokens: 1_000_000 }, undefined, { section: 'copilot' }), 5)
})

test('Haiku 5.5 long-prompt tier applies only when the request prompt size is given', () => {
  const haiku: SpendTotals = { ...zero, model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }
  near(spendUsd(haiku), 0.1 + 0.5 + 0.01)
  near(spendUsd(haiku, undefined, { promptTokens: 120_000 }), 0.5 + 2.5 + 0.05)
})

test('spendUsd is zero with no usage and uses the stored model over the fallback', () => {
  assert.equal(spendUsd(zero, 'claude-opus-4-7'), 0)
  const haiku: SpendTotals = { ...zero, model: 'claude-haiku-5-5', outputTokens: 1_000_000 }
  assert.equal(spendUsd(haiku, 'claude-opus-4-7'), 0.5)
  const opus: SpendTotals = { ...zero, outputTokens: 1_000_000 }
  assert.equal(spendUsd(opus, 'claude-opus-4-7'), 25)
})
