import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent, Edge } from '@/lib/agent-types'
import { NODE } from '@/lib/agent-types'
import type { CloudGeometry } from '@/lib/fleet/fleet-cloud-geometry'
import { fleetLinkEnds } from '@/components/agent-visualizer/canvas/draw-fleet'

const node = (id: string, x: number, y: number, over: Partial<Agent> = {}): Agent => ({
  id, name: id, state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 1, toolCalls: 0, timeAlive: 0,
  x, y, vx: 0, vy: 0, pinned: true, isMain: false, opacity: 1, scale: 1, messageBubbles: [], ...over,
} as Agent)

const cloud: CloudGeometry = { x: 0, y: 0, r: 200 }
const clouds = new Map([['cloud:a', cloud]])
const edge = { id: 'cloud:a>kanban:k', from: 'cloud:a', to: 'kanban:k', type: 'resource', fromCloud: true } as Edge
const agents = new Map<string, Agent>([
  ['s::near', node('s::near', 100, 0)],
  ['s::far', node('s::far', -120, 60)],
  ['kanban:k', node('kanban:k', 600, 0, { resourceKind: 'kanban' })],
])

test('fleetLinkEnds: the link leaves the cloud rim, towards the resource (what the drawn line uses)', () => {
  const ends = fleetLinkEnds(edge, agents, clouds)!
  assert.deepEqual([ends.fromX, ends.fromY, ends.toX, ends.toY], [200, 0, 600, 0])
})

test('fleetLinkEnds: with a source session the pulse leaves THAT node, not the cloud', () => {
  const near = fleetLinkEnds(edge, agents, clouds, 's::near')!
  assert.ok(Math.abs(near.fromX - (100 + NODE.radiusSub)) < 1e-6 && near.fromY === 0, 'at the edge of the node, towards the resource')
  assert.deepEqual([near.toX, near.toY], [600, 0])
  const far = fleetLinkEnds(edge, agents, clouds, 's::far')!
  // The two sources give different origins: the pulses of two sessions do not start at the same place.
  assert.ok(Math.hypot(far.fromX - near.fromX, far.fromY - near.fromY) > 100)
  // It starts at the node: within a node radius of its centre, and nowhere near the cloud rim.
  assert.ok(Math.hypot(far.fromX - -120, far.fromY - 60) <= NODE.radiusSub + 1e-6)
  assert.ok(Math.hypot(far.fromX, far.fromY) < cloud.r)
})

test('fleetLinkEnds: an unknown, hidden or resource source falls back to the cloud rim; a missing target gives no ends', () => {
  const rim = fleetLinkEnds(edge, agents, clouds)!
  assert.deepEqual(fleetLinkEnds(edge, agents, clouds, 's::gone'), rim, 'the session node is not on the map')
  const hidden = new Map(agents).set('s::near', node('s::near', 100, 0, { opacity: 0 }))
  assert.deepEqual(fleetLinkEnds(edge, hidden, clouds, 's::near'), rim, 'faded out')
  assert.deepEqual(fleetLinkEnds(edge, agents, clouds, 'kanban:k'), rim, 'a resource is never a source')
  assert.equal(fleetLinkEnds({ ...edge, to: 'kanban:none' } as Edge, agents, clouds, 's::near'), null)
  assert.equal(fleetLinkEnds({ ...edge, from: 'cloud:none' } as Edge, agents, clouds, 's::near'), null)
})

test('fleetLinkEnds: a source sitting on the resource gives no origin of its own (falls back, never NaN)', () => {
  const onTop = new Map(agents).set('s::near', node('s::near', 600, 0))
  const ends = fleetLinkEnds(edge, onTop, clouds, 's::near')!
  assert.ok([ends.fromX, ends.fromY, ends.toX, ends.toY].every(Number.isFinite))
})
