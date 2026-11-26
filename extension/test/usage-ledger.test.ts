import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addUsage, CLAUDE_CODE_PROVIDER, recordAssistantUsage, splitCacheWrites } from '../src/usage-ledger'
import type { WatchedSession } from '../src/protocol'

function fakeSession(): WatchedSession {
  return { spendByAgent: new Map(), seenUsageIds: new Set() } as unknown as WatchedSession
}

const usage = {
  input_tokens: 2,
  output_tokens: 8,
  cache_read_input_tokens: 11370,
  cache_creation_input_tokens: 10393,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10393 },
}

test('splitCacheWrites uses the TTL breakdown and treats unknown remainder as 5-minute', () => {
  assert.deepEqual(splitCacheWrites(usage), { fiveMin: 0, oneHour: 10393 })
  assert.deepEqual(splitCacheWrites({ cache_creation_input_tokens: 500 }), { fiveMin: 500, oneHour: 0 })
  assert.deepEqual(
    splitCacheWrites({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40 } }),
    { fiveMin: 100, oneHour: 0 },
  )
})

test('the same message id is counted once even when repeated per content block', () => {
  const s = fakeSession()
  const msg = { id: 'msg_1', model: 'claude-haiku-5-5', usage }
  assert.equal(recordAssistantUsage(s, 'orch', msg, 'uuid-a'), true)
  assert.equal(recordAssistantUsage(s, 'orch', msg, 'uuid-b'), false)
  const t = s.spendByAgent.get('orch')!
  assert.equal(t.inputTokens, 2)
  assert.equal(t.outputTokens, 8)
  assert.equal(t.cacheReadTokens, 11370)
  assert.equal(t.cacheWrite1hTokens, 10393)
  assert.equal(t.model, 'claude-haiku-5-5')
})

test('totals accumulate per agent and fall back to the line uuid without a message id', () => {
  const s = fakeSession()
  recordAssistantUsage(s, 'orch', { id: 'm1', usage: { output_tokens: 100 } })
  recordAssistantUsage(s, 'orch', { id: 'm2', usage: { output_tokens: 50 } })
  recordAssistantUsage(s, 'sub', { usage: { output_tokens: 7 } }, 'line-9')
  recordAssistantUsage(s, 'sub', { usage: { output_tokens: 7 } }, 'line-9') // duplicate
  assert.equal(s.spendByAgent.get('orch')!.outputTokens, 150)
  assert.equal(s.spendByAgent.get('sub')!.outputTokens, 7)
})

test('P2: the ledger row carries provider anthropic, a call count and a prompt-size bucket', () => {
  const s = fakeSession()
  recordAssistantUsage(s, 'orch', { id: 'm1', model: 'claude-opus-5-5', usage })
  const t = s.spendByAgent.get('orch')!
  assert.equal(t.provider, CLAUDE_CODE_PROVIDER)
  assert.equal(t.provider, 'anthropic')
  assert.equal(t.calls, 1)
  assert.equal(t.timedCalls, 0, 'transcripts report no latency')
  assert.equal(t.latencySeconds, 0)
  // prompt = 2 + 11370 + 10393 = 21,765 -> the lowest bucket
  assert.deepEqual(Object.keys(t.byBucket ?? {}), ['le100000'])
  assert.equal(t.byBucket!.le100000!.cacheWrite1hTokens, 10393)
})

test('P2: requests land in the bucket of their own prompt size; buckets sum to the flat totals', () => {
  const s = fakeSession()
  const big = (n: number) => ({ input_tokens: 1000, output_tokens: 7, cache_read_input_tokens: n - 1000 })
  recordAssistantUsage(s, 'orch', { id: 'a', usage: big(50_000) }) // le100000
  recordAssistantUsage(s, 'orch', { id: 'b', usage: big(150_000) }) // le200000
  recordAssistantUsage(s, 'orch', { id: 'c', usage: big(250_000) }) // le272000
  recordAssistantUsage(s, 'orch', { id: 'd', usage: big(900_000) }) // gt272000
  recordAssistantUsage(s, 'orch', { id: 'e', usage: big(100_000) }) // boundary is inclusive: le100000
  recordAssistantUsage(s, 'orch', { id: 'e', usage: big(100_000) }) // duplicate id: not counted again
  const t = s.spendByAgent.get('orch')!
  assert.equal(t.calls, 5)
  assert.deepEqual(Object.keys(t.byBucket!).sort(), ['gt272000', 'le100000', 'le200000', 'le272000'])
  assert.equal(t.byBucket!.le100000!.cacheReadTokens, 49_000 + 99_000)
  assert.equal(t.byBucket!.gt272000!.cacheReadTokens, 899_000)
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }
  for (const b of Object.values(t.byBucket!)) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += b![k]
  assert.deepEqual(sum, {
    inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cacheReadTokens,
    cacheWrite5mTokens: t.cacheWrite5mTokens, cacheWrite1hTokens: t.cacheWrite1hTokens,
  })
})

test('P2: addUsage is pure, keeps the latest model/provider and sums reported latency only', () => {
  const zero = { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }
  const a = addUsage(undefined, zero, { model: 'm1', provider: 'copilot', latencySeconds: 2 })
  const b = addUsage(a, zero, { latencySeconds: undefined })
  const c = addUsage(b, zero, { model: 'm2', provider: 'ollama', latencySeconds: -1 })
  assert.equal(a.calls, 1)
  assert.equal(b.calls, 2)
  assert.equal(b.provider, 'copilot', 'a call without provider keeps the previous one')
  assert.equal(b.model, 'm1')
  assert.equal(b.timedCalls, 1)
  assert.equal(c.provider, 'ollama')
  assert.equal(c.model, 'm2')
  assert.equal(c.timedCalls, 1, 'a negative latency is not counted')
  assert.equal(c.latencySeconds, 2)
  assert.equal(a.outputTokens, 1, 'earlier results are not mutated')
})

test('entries without usage or a key are skipped', () => {
  const s = fakeSession()
  assert.equal(recordAssistantUsage(s, 'orch', { id: 'm3' }), false)
  assert.equal(recordAssistantUsage(s, 'orch', { usage: { output_tokens: 1 } }), false)
  assert.equal(s.spendByAgent.size, 0)
})
