import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emptyContextBreakdown, type Agent, type ToolCallNode } from '@/lib/agent-types'
import { createEmptyState } from '@/hooks/simulation/types'
import { ANCHOR_DIM_ALPHA, hoverAlpha } from './anchor-mode'
import { composeSingleFrame, layoutSingleAnchor, rootOf, SINGLE_CLOUD_ID, type SingleAnchorBlock } from './single-anchor'

const NOW = 1_000_000

const agent = (id: string, x: number, y: number, over: Partial<Agent> = {}): Agent => ({
  id, name: id, state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 1, contextBreakdown: emptyContextBreakdown(),
  toolCalls: 0, timeAlive: 0, x, y, vx: 0, vy: 0, pinned: false, isMain: false, task: '', spawnTime: 0, opacity: 1, scale: 1,
  messageBubbles: [], ...over,
})

const block = (id: string, kind: SingleAnchorBlock['kind'], label = id.split(':')[1]): SingleAnchorBlock => ({ id, kind, label, sublabel: '1 call', alpha: 1 })
const blocks = [block('kanban:alpha', 'kanban'), block('memory:alpha', 'memory'), block('bash:git', 'bash'), block('bash:pnpm', 'bash')]

// git and pnpm were used in turns, alpha board and its memory in turns; the two pairs 10 minutes apart. Newest use: pnpm.
const events = [
  { resource: 'kanban:alpha', at: NOW - 900_000 }, { resource: 'memory:alpha', at: NOW - 895_000 },
  { resource: 'kanban:alpha', at: NOW - 890_000 }, { resource: 'memory:alpha', at: NOW - 885_000 },
  { resource: 'bash:git', at: NOW - 20_000 }, { resource: 'bash:pnpm', at: NOW - 10_000 },
  { resource: 'bash:git', at: NOW - 8_000 }, { resource: 'bash:pnpm', at: NOW - 5_000 },
]
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

test('layoutSingleAnchor: resources used close in time sit closer than resources used far apart', () => {
  const l = layoutSingleAnchor(blocks, events, 90, NOW)
  const d = (a: string, b: string) => dist(l.anchors.get(a)!, l.anchors.get(b)!)
  assert.ok(d('bash:git', 'bash:pnpm') < d('bash:git', 'kanban:alpha'))
  assert.ok(d('kanban:alpha', 'memory:alpha') < d('kanban:alpha', 'bash:pnpm'))
})

test('layoutSingleAnchor: the tree goes beside the resource of the newest use, and not on top of it', () => {
  const l = layoutSingleAnchor(blocks, events, 90, NOW)
  assert.equal(l.at, 'bash:pnpm')
  const a = l.anchors.get('bash:pnpm')!
  assert.ok(dist(l.rootAt, a) >= 46 + 90, 'clear of the anchor')
  assert.ok(dist(l.rootAt, a) < dist(l.rootAt, l.anchors.get('kanban:alpha')!), 'nearest to its own resource')
})

test('layoutSingleAnchor: it moves when the use changes (drift target changes)', () => {
  const before = layoutSingleAnchor(blocks, events, 90, NOW)
  const later = [...events, { resource: 'kanban:alpha', at: NOW + 5_000 }]
  const after = layoutSingleAnchor(blocks, later, 90, NOW + 6_000)
  assert.equal(after.at, 'kanban:alpha')
  assert.notDeepEqual(before.rootAt, after.rootAt)
})

test('layoutSingleAnchor: no resources used: the tree stays on the map without an anchor', () => {
  const l = layoutSingleAnchor([], [], 90, NOW)
  assert.equal(l.at, null)
  assert.equal(l.anchors.size, 0)
  assert.ok(Number.isFinite(l.rootAt.x) && Number.isFinite(l.rootAt.y))
})

function source() {
  const main = agent('main', 10, 20, { isMain: true })
  const sub = agent('sub', 90, 20, { parentId: 'main' })
  const tc: ToolCallNode = { id: 'tc1', agentId: 'main', tool: 'Bash', x: 30, y: 60 } as unknown as ToolCallNode
  return createEmptyState({
    agents: new Map([['main', main], ['sub', sub]]), toolCalls: new Map([['tc1', tc]]),
    edges: [{ id: 'e1', from: 'main', to: 'sub', type: 'parent-child', opacity: 1 } as never],
  })
}

test('rootOf: the main agent', () => {
  assert.equal(rootOf(source().agents)!.id, 'main')
  assert.equal(rootOf(new Map()), null)
})

test('composeSingleFrame: the whole tree moves with its root, tinted; resources are added as anchor nodes', () => {
  const layout = layoutSingleAnchor(blocks, events, 90, NOW)
  const frame = composeSingleFrame({ source: source(), blocks, layout, rootAt: { x: 500, y: -300 }, tint: '#ff00aa', profile: 'taxis' })
  const main = frame.agents.get('main')!
  const sub = frame.agents.get('sub')!
  assert.deepEqual([main.x, main.y], [500, -300])
  assert.deepEqual([sub.x - main.x, sub.y - main.y], [80, 0], 'the offsets inside the tree are kept')
  assert.deepEqual([frame.toolCalls.get('tc1')!.x, frame.toolCalls.get('tc1')!.y], [520, -260])
  assert.equal(main.tint, '#ff00aa')
  assert.equal(sub.tint, '#ff00aa')
  for (const b of blocks) {
    const n = frame.agents.get(b.id)!
    assert.ok(n.resourceKind, `${b.id} is a resource node`)
    assert.equal(n.tint, undefined)
    assert.deepEqual([n.x, n.y], [layout.anchors.get(b.id)!.x, layout.anchors.get(b.id)!.y])
  }
  assert.equal(frame.agents.get('memory:alpha')!.resourceKind, 'supermemory')
})

test('composeSingleFrame: no halo (anchor cloud), one link per used resource leaving the main agent', () => {
  const layout = layoutSingleAnchor(blocks, events, 90, NOW)
  const frame = composeSingleFrame({ source: source(), blocks, layout, rootAt: layout.rootAt, tint: '#123456', profile: 'taxis' })
  assert.equal(frame.clouds!.length, 1)
  assert.equal(frame.clouds![0].id, SINGLE_CLOUD_ID)
  assert.equal(frame.clouds![0].anchor, true)
  const links = frame.edges.filter(e => e.fromCloud)
  assert.equal(links.length, 4)
  for (const l of links) assert.deepEqual(l.sourceIds, ['main'])
  assert.equal(links.find(l => l.to === 'kanban:alpha')!.color, '#ffbb44')
  assert.equal(links.find(l => l.to === 'memory:alpha')!.color, '#cc88ff')
  assert.equal(links.find(l => l.to === 'bash:git')!.color, '#55dd99')
})

test('composeSingleFrame: hover keeps the used resources and the parent/child at 100%, the rest at 80%', () => {
  const extra = [...blocks, block('subsystem:cron', 'subsystem')]
  const layout = layoutSingleAnchor(extra, events, 90, NOW)
  const frame = composeSingleFrame({ source: source(), blocks: extra, layout, rootAt: layout.rootAt, tint: '#123456', profile: 'taxis' })
  const rel = frame.relations!
  const onMain = rel.get('main')!
  assert.equal(hoverAlpha('bash:git', 'main', onMain), 1, 'a resource it used')
  assert.equal(hoverAlpha('sub', 'main', onMain), 1, 'its sub-agent')
  assert.equal(hoverAlpha('subsystem:cron', 'main', onMain), ANCHOR_DIM_ALPHA, 'a resource it never used (listed, unused)')
  const onGit = rel.get('bash:git')!
  assert.equal(hoverAlpha('bash:pnpm', 'bash:git', onGit), 1, 'used together with git')
  assert.equal(hoverAlpha('kanban:alpha', 'bash:git', onGit), ANCHOR_DIM_ALPHA)
})

test('composeSingleFrame: a state without agents is returned as it is', () => {
  const empty = createEmptyState({})
  const frame = composeSingleFrame({ source: empty, blocks, layout: layoutSingleAnchor(blocks, events, 90, NOW), rootAt: { x: 0, y: 0 }, tint: '#000000', profile: 'x' })
  assert.equal(frame, empty)
})
