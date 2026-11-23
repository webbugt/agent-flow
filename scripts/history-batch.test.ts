import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { AgentEvent } from '../extension/src/protocol'
import { buildHistoryBatch } from './history-batch'

test('history batch keeps each event time instead of zeroing it', () => {
  const buffered = [0, 12.5, 40, 300].map(time => ({ time, type: 'tool_call_start', payload: { tool: 'Bash' }, sessionId: 's1' })) as AgentEvent[]
  const batch = buildHistoryBatch(buffered)
  assert.equal(batch.type, 'agent-event-batch')
  assert.deepEqual(batch.events.map(e => e.time), [0, 12.5, 40, 300])
  assert.ok(new Set(batch.events.map(e => e.time)).size > 1, 'times must not collapse to one instant')
})

test('history batch is a copy: later buffer edits do not leak into a sent batch', () => {
  const buffered = [{ time: 5, type: 'message', payload: {}, sessionId: 's1' }] as AgentEvent[]
  const batch = buildHistoryBatch(buffered)
  buffered[0].time = 99
  assert.equal(batch.events[0].time, 5)
})
