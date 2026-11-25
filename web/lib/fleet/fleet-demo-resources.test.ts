import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildFleetGraph } from './fleet-graph'
import { createFleetFixture } from './fleet-model'
import { addDemoEvent, addDemoNodes, createDemoResources } from './fleet-demo-resources'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)

test('demo resources: deterministic, linked and unlinked boards/namespaces, links start inside the linger window', () => {
  assert.deepEqual(createDemoResources(NOW), createDemoResources(NOW))
  const src = createDemoResources(NOW)
  const g = buildFleetGraph({ instances: createFleetFixture(NOW), kanban: src.kanban, supermemory: src.supermemory, selection: { isSelected: () => true }, now: NOW })
  assert.equal(g.clouds.length, 3)
  assert.ok(g.edges.length >= 4)
  assert.ok(g.edges.some(e => NOW - e.lastUsedAt < 90_000), 'some link is fresh')
  assert.ok(g.nodes.some(n => n.id === 'kanban:backlog') && !g.edges.some(e => e.to === 'kanban:backlog'), 'an unlinked board goes to the rim')
})

test('addDemoEvent adds one new event, keeps counts consistent and does not mutate its input', () => {
  const src = createDemoResources(NOW)
  const before = JSON.stringify(src)
  const k = addDemoEvent(src, 'kanban', NOW + 1000, 0)
  assert.equal(JSON.stringify(src), before)
  const b = k.kanban.find(x => x.slug === 'agent-flow')!
  assert.equal(b.recentEvents[0].at, NOW + 1000)
  assert.equal(b.recentEvents.length, src.kanban[0].recentEvents.length + 1)
  const m = addDemoEvent(src, 'memory', NOW + 2000, 1).supermemory.find(x => x.containerTag === 'omh_family')!
  assert.equal(m.recent[0].at, NOW + 2000)
  assert.equal(m.total, m.counts.store + m.counts.search + m.counts.forget)
  assert.equal(m.recent.length, m.total)
})

test('addDemoNodes: a poll with new nodes raises the node count with new ids and does not mutate its input', () => {
  const src = createDemoResources(NOW)
  const before = JSON.stringify(src)
  const next = addDemoNodes(src, NOW + 1000, 7)
  assert.equal(JSON.stringify(src), before)
  const nodes = (s: typeof src) => buildFleetGraph({ instances: createFleetFixture(NOW), kanban: s.kanban, supermemory: s.supermemory, selection: { isSelected: () => true }, now: NOW + 1000 }).nodes
  const a = nodes(src), b = nodes(next)
  assert.equal(b.length, a.length + 2)
  const ids = new Set(a.map(n => n.id))
  assert.equal(b.filter(n => !ids.has(n.id)).length, 2)
})
