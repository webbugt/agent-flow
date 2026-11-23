import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordAssistantUsage, splitCacheWrites } from '../src/usage-ledger'
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

test('entries without usage or a key are skipped', () => {
  const s = fakeSession()
  assert.equal(recordAssistantUsage(s, 'orch', { id: 'm3' }), false)
  assert.equal(recordAssistantUsage(s, 'orch', { usage: { output_tokens: 1 } }), false)
  assert.equal(s.spendByAgent.size, 0)
})
