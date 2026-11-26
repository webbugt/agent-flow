import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ageLabel, inspectResource, INSPECT_LIMIT } from './fleet-inspect'
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const MIN = 60_000

const board = (n: number): PublicKanbanBoardNode => ({
  id: 'kanban:agent-flow', type: 'kanban-board', slug: 'agent-flow', name: 'Agent Flow', description: '', archived: false,
  taskCounts: { running: 1 }, totalTasks: 5,
  recentEvents: Array.from({ length: n }, (_, i) => ({ id: i + 1, taskId: `t${i}`, taskTitle: `task ${i}`, assignee: i % 2 ? 'taxis' : 'omh-coder', kind: i % 3 ? 'claimed' : 'completed', runId: null, at: NOW - (n - i) * MIN })),
  lastEventAt: NOW - MIN,
} as PublicKanbanBoardNode)

const memory = (n: number): SupermemoryNamespaceNode => ({
  id: 'supermemory:omh_family', type: 'supermemory-namespace', containerTag: 'omh_family',
  counts: { store: n, search: 0, forget: 0 }, total: n, byProfile: {}, daily: [], lastEventAt: NOW - MIN, lastByProfile: {},
  recent: Array.from({ length: n }, (_, i) => ({ at: NOW - i * MIN, profile: i % 2 ? 'taxis' : 'sophia', action: (['store', 'search', 'forget'] as const)[i % 3] })),
})

test('Kanban inspector: time, profile, event kind, newest first, limited with a "more" count', () => {
  const r = inspectResource('kanban:agent-flow', [board(30)], [])!
  assert.equal(r.kind, 'kanban')
  assert.equal(r.title, 'Agent Flow')
  assert.equal(r.items.length, INSPECT_LIMIT)
  assert.equal(r.total, 30)
  assert.equal(r.more, 30 - INSPECT_LIMIT)
  const ats = r.items.map(i => i.at)
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a))
  assert.equal(r.items[0].at, NOW - MIN)
  assert.ok(r.items.every(i => i.profile && i.action))
})

test('Supermemory inspector: reads the per-event recent list, newest first', () => {
  const r = inspectResource('supermemory:omh_family', [], [memory(8)])!
  assert.equal(r.kind, 'supermemory')
  assert.equal(r.items.length, 8)
  assert.equal(r.more, 0)
  assert.deepEqual(r.items[0], { at: NOW, profile: 'sophia', action: 'store' })
  assert.deepEqual(r.items.map(i => i.action).slice(0, 3), ['store', 'search', 'forget'])
  const ats = r.items.map(i => i.at)
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a))
})

test('a custom limit is respected; unknown id gives null; empty list is fine', () => {
  assert.equal(inspectResource('kanban:agent-flow', [board(30)], [], 5)!.items.length, 5)
  assert.equal(inspectResource('kanban:nope', [board(3)], [memory(3)]), null)
  const empty = inspectResource('supermemory:omh_family', [], [memory(0)])!
  assert.deepEqual(empty.items, [])
  assert.equal(empty.more, 0)
})

test('ageLabel', () => {
  assert.equal(ageLabel(NOW - 12_000, NOW), '12s ago')
  assert.equal(ageLabel(NOW - 3 * MIN, NOW), '3 min ago')
  assert.equal(ageLabel(NOW - 2 * 3600_000, NOW), '2 h ago')
  assert.equal(ageLabel(NOW - 4 * 86_400_000, NOW), '4 d ago')
  assert.equal(ageLabel(NOW + 5000, NOW), '0s ago')
})
