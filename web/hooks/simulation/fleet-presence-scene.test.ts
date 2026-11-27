import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emptyContextBreakdown, type Agent, type Edge, type ToolCallNode } from '@/lib/agent-types'
import type { CloudView } from '@/lib/fleet/fleet-cloud-geometry'
import { NODE_ENTER_MS, NODE_EXIT_MS, CLOUD_EXIT_MS, NODE_SCALE_MIN } from '@/lib/fleet/fleet-presence'
import { animatedView, ghostIdsOf, newFleetPresenceTracker, solidAgents, solidToolCalls, withGhosts } from './fleet-presence-scene'
import { createEmptyState, type SimulationState } from './types'

const T = 5_000_000

function agent(id: string, x: number, y: number, over: Partial<Agent> = {}): Agent {
  return {
    id, name: id, state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 1, contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, timeAlive: 0, x, y, vx: 0, vy: 0, pinned: true, isMain: false, task: '', spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [], ...over,
  }
}
const tool = (id: string, agentId: string, x: number, y: number): ToolCallNode => ({
  id, agentId, toolName: 'Read', state: 'complete', args: '', x, y, startTime: 0, opacity: 1,
})
const cloud = (id: string, ...members: string[]): CloudView => ({
  id, label: id, color: '#fff', status: 'idle', members: members.map(m => ({ id: m, pad: 70 })),
})

interface Spec { agents?: Agent[]; tools?: ToolCallNode[]; edges?: Edge[]; clouds?: CloudView[] }
function scene(s: Spec): SimulationState {
  return createEmptyState({
    agents: new Map((s.agents ?? []).map(a => [a.id, a])),
    toolCalls: new Map((s.tools ?? []).map(t => [t.id, t])),
    edges: s.edges ?? [],
    clouds: s.clouds ?? [],
    keepFinished: true,
  })
}
const resourceEdge = (id: string, from: string, to: string): Edge => ({ id, from, to, type: 'resource', opacity: 1, fromCloud: true, lastUsedAt: T })

/** Two sessions in cloud "p", plus a board linked to it. */
const full = (): Spec => ({
  agents: [agent('s1', 0, 0), agent('s2', 100, 0), agent('board', 300, 0, { resourceKind: 'kanban' })],
  tools: [tool('s1::t1', 's1', 40, 0)],
  edges: [{ id: 'e-tool', from: 's1', to: 's1::t1', type: 'tool', opacity: 1 }, resourceEdge('cloud:p>board', 'cloud:p', 'board')],
  clouds: [cloud('cloud:p', 's1', 's2')],
})

test('the first scene is steady: no stamps in transition, the view is the scene itself', () => {
  const tracker = newFleetPresenceTracker()
  const state = withGhosts(scene(full()), tracker, T)
  assert.ok(state.presence)
  assert.equal(state.agents.size, 3)
  const v = animatedView(state, T)
  assert.equal(v.animating, false)
  assert.equal(v.agents, state.agents, 'no copy per frame while nothing animates')
})

test('a new session node enters: opacity and scale grow from low to the scene values; nothing else changes', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene(full()), tracker, T)
  const grown = full()
  grown.agents!.push(agent('s3', 200, 0, { opacity: 0.5 }))
  grown.clouds = [cloud('cloud:p', 's1', 's2', 's3')]
  const state = withGhosts(scene(grown), tracker, T + 1000)

  const at0 = animatedView(state, T + 1000)
  assert.equal(at0.animating, true)
  assert.equal(at0.agents.get('s3')!.opacity, 0)
  assert.equal(at0.agents.get('s3')!.scale, NODE_SCALE_MIN)
  assert.equal(at0.agents.get('s1')!.opacity, 1, 'the others are untouched')

  const mid = animatedView(state, T + 1000 + NODE_ENTER_MS / 4).agents.get('s3')!
  assert.ok(mid.opacity > 0 && mid.opacity < 0.5, `scene opacity is the ceiling: ${mid.opacity}`)
  assert.ok(mid.scale > NODE_SCALE_MIN && mid.scale < 1)

  const done = animatedView(state, T + 1000 + NODE_ENTER_MS)
  assert.equal(done.animating, false)
  assert.equal(done.agents.get('s3')!.opacity, 0.5)
  assert.equal(done.agents.get('s3')!.scale, 1)
  // The scene itself keeps the final positions from the first frame (the camera fits to them).
  assert.equal(state.agents.get('s3')!.x, 200)
  assert.equal(state.agents.get('s3')!.opacity, 0.5)
})

test('satellites grow out of their node while it enters, and the link to them fades with it', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene({ agents: [agent('s0', -500, 0)], clouds: [cloud('cloud:q', 's0')] }), tracker, T)
  const state = withGhosts(scene(full()), tracker, T + 1000)
  const v = animatedView(state, T + 1000)
  const t = v.toolCalls.get('s1::t1')!
  assert.equal(t.opacity, 0)
  // At level 0 the satellite sits at (almost) its node: owner at x=0, final offset 40, scaled by the minimum.
  assert.ok(Math.abs(t.x - 40 * NODE_SCALE_MIN) < 1e-9)
  assert.equal(v.edges.find(e => e.id === 'e-tool'), undefined, 'a link with an invisible end is not drawn')
  const later = animatedView(state, T + 1000 + NODE_ENTER_MS / 2)
  const link = later.edges.find(e => e.id === 'e-tool')!
  assert.ok(link.opacity > 0 && link.opacity < 1)
})

test('a new cloud grows from its centre (level < 1) while its members enter', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene({ agents: [agent('s0', -500, 0)], clouds: [cloud('cloud:q', 's0')] }), tracker, T)
  const state = withGhosts(scene({ agents: [agent('s0', -500, 0), agent('n1', 0, 0)], clouds: [cloud('cloud:q', 's0'), cloud('cloud:p', 'n1')] }), tracker, T + 10)
  const v = animatedView(state, T + 10 + 100)
  const level = v.fade.get('cloud:p')!
  assert.ok(level > 0 && level < 1)
  assert.equal(v.fade.has('cloud:q'), false, 'the old cloud is steady')
  assert.equal(v.clouds.length, 2)
})

test('a node that left stays as a ghost for the exit time, then is dropped; the link to it goes with it', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene(full()), tracker, T)
  const without = full()
  without.agents = without.agents!.filter(a => a.id !== 'board')
  without.edges = without.edges!.filter(e => e.id !== 'cloud:p>board')
  const t1 = T + 2000
  const state = withGhosts(scene(without), tracker, t1)

  assert.ok(state.agents.has('board'), 'the ghost is in the frame')
  assert.ok(state.edges.some(e => e.id === 'cloud:p>board'), 'and its link')
  assert.equal(state.agents.get('board')!.x, 300, 'at the place it had')

  const half = animatedView(state, t1 + NODE_EXIT_MS / 2)
  assert.equal(half.agents.get('board')!.opacity, 0.5)
  assert.ok(half.agents.get('board')!.scale < 1 && half.agents.get('board')!.scale > NODE_SCALE_MIN)
  assert.equal(half.edges.find(e => e.id === 'cloud:p>board')!.opacity, 0.5)

  const over = animatedView(state, t1 + NODE_EXIT_MS)
  assert.equal(over.agents.has('board'), false, 'after the exit time the ghost is not drawn even before the next rebuild')
  assert.equal(over.edges.some(e => e.id === 'cloud:p>board'), false)

  // The next scene build removes it for good.
  const later = withGhosts(scene(without), tracker, t1 + NODE_EXIT_MS + 50)
  assert.equal(later.agents.has('board'), false)
  assert.equal(later.presence!.has('board'), false)
})

test('a session node that leaves keeps its satellites and its place in the cloud until its ghost is gone', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene(full()), tracker, T)
  const without = full()
  without.agents = without.agents!.filter(a => a.id !== 's1')
  without.tools = []
  without.edges = without.edges!.filter(e => e.id !== 'e-tool')
  without.clouds = [cloud('cloud:p', 's2')]
  const t1 = T + 3000
  const state = withGhosts(scene(without), tracker, t1)

  assert.ok(state.agents.has('s1'))
  assert.ok(state.toolCalls.has('s1::t1'))
  assert.ok(state.edges.some(e => e.id === 'e-tool'))
  const members = state.clouds!.find(c => c.id === 'cloud:p')!.members.map(m => m.id)
  assert.deepEqual(members.sort(), ['s1', 's2'], 'the halo does not jump when the node starts to leave')
  assert.equal(without.clouds[0].members.length, 1, 'the input scene is not mutated')

  const half = animatedView(state, t1 + NODE_EXIT_MS / 2)
  assert.equal(half.agents.get('s1')!.opacity, 0.5)
  assert.equal(half.toolCalls.get('s1::t1')!.opacity, 0.5)
  assert.equal(half.fade.has('cloud:p'), false, 'the cloud still has a member: it does not fade')
  // gone: out of the cloud's geometry as well
  const over = animatedView(state, t1 + NODE_EXIT_MS)
  assert.equal(over.agents.has('s1'), false)
  assert.equal(over.toolCalls.has('s1::t1'), false)
})

test('a cloud fades when its last member leaves: the cloud and the member are ghosts together', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene({ agents: [agent('a', 0, 0), agent('b', 500, 0)], clouds: [cloud('cloud:p', 'a'), cloud('cloud:q', 'b')] }), tracker, T)
  const t1 = T + 1000
  const state = withGhosts(scene({ agents: [agent('b', 500, 0)], clouds: [cloud('cloud:q', 'b')] }), tracker, t1)
  assert.deepEqual(state.clouds!.map(c => c.id).sort(), ['cloud:p', 'cloud:q'])
  assert.deepEqual(state.clouds!.find(c => c.id === 'cloud:p')!.members.map(m => m.id), ['a'])

  const early = animatedView(state, t1 + NODE_EXIT_MS)
  assert.equal(early.agents.has('a'), false, 'the member is over first')
  assert.ok(early.clouds.some(c => c.id === 'cloud:p'), 'the cloud is still fading (it takes longer)')
  assert.ok(early.fade.get('cloud:p')! > 0)

  const over = animatedView(state, t1 + CLOUD_EXIT_MS)
  assert.equal(over.clouds.some(c => c.id === 'cloud:p'), false)
  const later = withGhosts(scene({ agents: [agent('b', 500, 0)], clouds: [cloud('cloud:q', 'b')] }), tracker, t1 + CLOUD_EXIT_MS + 50)
  assert.deepEqual(later.clouds!.map(c => c.id), ['cloud:q'])
})

test('a node that comes back while it is a ghost is not duplicated and does not pop', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene(full()), tracker, T)
  const without = full()
  without.agents = without.agents!.filter(a => a.id !== 's2')
  without.clouds = [cloud('cloud:p', 's1')]
  withGhosts(scene(without), tracker, T + 1000)
  const mid = T + 1000 + NODE_EXIT_MS / 2
  const back = withGhosts(scene(full()), tracker, mid)
  assert.equal([...back.agents.keys()].filter(k => k === 's2').length, 1)
  assert.equal(back.clouds!.find(c => c.id === 'cloud:p')!.members.filter(m => m.id === 's2').length, 1)
  const v = animatedView(back, mid)
  assert.ok(Math.abs(v.agents.get('s2')!.opacity - 0.5) < 1e-9, `continues from the level it had: ${v.agents.get('s2')!.opacity}`)
})

test('a link whose other end is gone for good is not kept', () => {
  const tracker = newFleetPresenceTracker()
  const s = full()
  withGhosts(scene(s), tracker, T)
  // The whole cloud and its sessions vanish; the board stays but its link must not dangle once the cloud's ghost is over.
  const rest = () => scene({ agents: [agent('board', 300, 0, { resourceKind: 'kanban' })] })
  const during = withGhosts(rest(), tracker, T + 1000)
  assert.ok(during.edges.some(e => e.id === 'cloud:p>board'), 'while the cloud is a ghost the link is kept')
  const later = withGhosts(rest(), tracker, T + 60_000)
  assert.equal(later.edges.length, 0)
})

test('the frame is a new state: the input scene is not mutated', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene(full()), tracker, T)
  const without = scene({ agents: [agent('s1', 0, 0)], clouds: [cloud('cloud:p', 's1')] })
  const sizeBefore = without.agents.size
  const state = withGhosts(without, tracker, T + 10)
  assert.equal(without.agents.size, sizeBefore)
  assert.ok(state.agents.size > sizeBefore)
})

test('ghostIdsOf / solidAgents / solidToolCalls: what is on its way out is drawn but cannot be hit', () => {
  const tracker = newFleetPresenceTracker()
  withGhosts(scene(full()), tracker, T)
  const left = full()
  left.agents = left.agents!.filter(a => a.id !== 's1')
  left.tools = []
  left.edges = left.edges!.filter(e => e.id !== 'e-tool')
  left.clouds = [cloud('cloud:p', 's2')]
  const state = withGhosts(scene(left), tracker, T + 100)
  assert.ok(state.agents.has('s1') && state.toolCalls.has('s1::t1'), 'drawn as a ghost')

  const ghosts = ghostIdsOf(state)
  assert.deepEqual([...ghosts], ['s1'])
  const agents = solidAgents(state.agents, ghosts)
  assert.equal(agents.has('s1'), false, 'no hover, click or drag on a ghost')
  assert.equal(agents.has('s2'), true)
  assert.equal(solidToolCalls(state.toolCalls, ghosts).has('s1::t1'), false, 'nor on its satellites')
  assert.equal(state.agents.has('s1'), true, 'the frame itself is not changed')
  // No ghosts: the very same maps, nothing is copied per mouse move.
  const steady = withGhosts(scene(full()), newFleetPresenceTracker(), T)
  assert.equal(ghostIdsOf(steady).size, 0)
  assert.equal(solidAgents(steady.agents, ghostIdsOf(steady)), steady.agents)
  // Entering things are hit-testable (only ghosts are not).
  const grown = full()
  grown.agents!.push(agent('s3', 200, 0))
  const t2 = newFleetPresenceTracker()
  withGhosts(scene(full()), t2, T)
  assert.equal(ghostIdsOf(withGhosts(scene(grown), t2, T + 10)).size, 0)
})
