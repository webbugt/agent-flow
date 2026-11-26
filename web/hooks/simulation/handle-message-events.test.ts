import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent } from '@/lib/agent-types'
import { handleContextUpdate, parseSpend } from './handle-message-events'
import type { MutableEventState } from './process-event'

const FLAT = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWrite5mTokens: 20, cacheWrite1hTokens: 0 }

test('parseSpend keeps provider, byBucket and call/latency counters (P2)', () => {
  const spend = parseSpend({
    ...FLAT, model: 'claude-sonnet-5.5', provider: 'copilot',
    byBucket: { le100000: { ...FLAT }, bogus: { ...FLAT }, gt272000: { inputTokens: 'x' } },
    calls: 3, timedCalls: 2, latencySeconds: 4.1,
  })
  assert.equal(spend?.provider, 'copilot')
  assert.equal(spend?.calls, 3)
  assert.equal(spend?.timedCalls, 2)
  assert.equal(spend?.latencySeconds, 4.1)
  assert.deepEqual(spend?.byBucket?.le100000, FLAT)
  // Unknown bucket keys are dropped; a bad value becomes 0 rather than NaN.
  assert.deepEqual(Object.keys(spend?.byBucket ?? {}).sort(), ['gt272000', 'le100000'])
  assert.equal(spend?.byBucket?.gt272000?.inputTokens, 0)
})

test('parseSpend without the P2 fields behaves as before (no provider/byBucket keys)', () => {
  const spend = parseSpend({ ...FLAT, model: 'claude-haiku-5-5' })
  assert.deepEqual(spend, { ...FLAT, model: 'claude-haiku-5-5' })
  assert.equal('provider' in (spend as object), false)
  assert.equal('byBucket' in (spend as object), false)
  assert.equal(parseSpend(null), undefined)
  assert.equal(parseSpend('x'), undefined)
})

test('parseSpend rejects non-string providers and negative counters', () => {
  const spend = parseSpend({ ...FLAT, provider: 42, calls: -1, latencySeconds: Number.NaN })
  assert.equal(spend && 'provider' in spend, false)
  assert.equal(spend?.calls, undefined)
  assert.equal(spend?.latencySeconds, undefined)
})

test('handleContextUpdate stores the provider on the agent spend', () => {
  const state: MutableEventState = {
    agents: new Map([['a', { name: 'a', tokensUsed: 0, tokensMax: 1000 } as Agent]]),
    toolCalls: new Map(), particles: [], edges: [], discoveries: [],
    fileAttention: new Map(), timelineEntries: new Map(), conversations: new Map(),
  }
  handleContextUpdate({ agent: 'a', tokens: 50, spend: { ...FLAT, provider: 'ollama', calls: 1 } }, state)
  assert.equal(state.agents.get('a')?.spend?.provider, 'ollama')
  assert.equal(state.agents.get('a')?.spend?.calls, 1)
})
