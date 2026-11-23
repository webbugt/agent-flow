import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spendUsd, priceForModel } from './pricing'
import type { SpendTotals } from './agent-types'

const zero: SpendTotals = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
}

test('priceForModel matches Claude families and falls back to Sonnet', () => {
  assert.deepEqual(priceForModel('claude-opus-4-7'), { input: 5, output: 25 })
  assert.deepEqual(priceForModel('claude-haiku-5-5'), { input: 1, output: 5 })
  assert.deepEqual(priceForModel('gpt-5.3-codex'), { input: 3, output: 15 })
  assert.deepEqual(priceForModel(undefined), { input: 3, output: 15 })
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
  assert.ok(Math.abs(spendUsd(spend) - 28.05) < 1e-9)
})

test('spendUsd is zero with no usage and uses the stored model over the fallback', () => {
  assert.equal(spendUsd(zero, 'claude-opus-4-7'), 0)
  const haiku: SpendTotals = { ...zero, model: 'claude-haiku-5-5', outputTokens: 1_000_000 }
  assert.equal(spendUsd(haiku, 'claude-opus-4-7'), 5)
})
