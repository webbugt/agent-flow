import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { emptyContextBreakdown, type Agent, type ToolCallNode } from '@/lib/agent-types'
import { TWEEN_MS, retarget } from '@/lib/fleet/fleet-tween'
import { newFleetPresenceTracker, withGhosts } from './fleet-presence-scene'
import { positionsOf, tweenedFrame } from './fleet-tween-scene'
import { createEmptyState, type SimulationState } from './types'

const T = 7_000_000

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
function frame(agents: Agent[], tools: ToolCallNode[] = []): SimulationState {
  return createEmptyState({
    agents: new Map(agents.map(a => [a.id, a])), toolCalls: new Map(tools.map(t => [t.id, t])), keepFinished: true,
  })
}

test('a rebuild moves a surviving node: the frame at the start is the old place, at TWEEN_MS the new place, in between a place on the way', () => {
  const before = frame([agent('s1', 0, 0), agent('s2', 200, 0)])
  const after = frame([agent('s1', 0, 0), agent('s2', 500, 100)])
  const legs = retarget(null, positionsOf(before), positionsOf(after), T)

  const start = tweenedFrame(after, legs, T)
  assert.equal(start.settled, false)
  assert.deepEqual([start.frame.agents.get('s2')!.x, start.frame.agents.get('s2')!.y], [200, 0], 'no jump on the first frame')
  const mid = tweenedFrame(after, legs, T + TWEEN_MS / 2).frame.agents.get('s2')!
  assert.deepEqual([mid.x, mid.y], [350, 50])
  const end = tweenedFrame(after, legs, T + TWEEN_MS)
  assert.equal(end.settled, true)
  assert.equal(end.frame.agents.get('s2')!.x, 500)
  assert.equal(end.frame, after, 'at rest the scene frame itself is drawn (no copy per frame)')
  assert.equal(start.frame.agents.get('s1'), after.agents.get('s1'), 'a node that does not move is not copied')
  assert.equal(after.agents.get('s2')!.x, 500, 'the scene frame is not changed')
})

test('satellites keep their offset from their node while it moves', () => {
  const before = frame([agent('s1', 0, 0)], [tool('s1::t', 's1', 40, -30)])
  const after = frame([agent('s1', 300, 0)], [tool('s1::t', 's1', 340, -30)])
  const legs = retarget(null, positionsOf(before), positionsOf(after), T)
  for (const dt of [0, 100, 225, 400, TWEEN_MS]) {
    const f = tweenedFrame(after, legs, T + dt).frame
    const a = f.agents.get('s1')!
    const t = f.toolCalls.get('s1::t')!
    assert.ok(Math.abs(t.x - a.x - 40) < 1e-9 && Math.abs(t.y - a.y + 30) < 1e-9, `offset kept at +${dt}`)
  }
  assert.equal(tweenedFrame(after, legs, T).frame.toolCalls.get('s1::t')!.x, 40)
})

test('a node that is new appears at its place (no leg); a dragged node is where it was dropped, with its satellites', () => {
  const before = frame([agent('s1', 0, 0), agent('s2', 100, 0)], [tool('s2::t', 's2', 130, 0)])
  const after = frame([agent('s1', 50, 0), agent('s2', 400, 0), agent('s3', 900, 900)], [tool('s2::t', 's2', 430, 0)])
  const hold = new Map([['s2', { x: 123, y: 456 }]])
  const legs = retarget(null, positionsOf(before), positionsOf(after), T, hold)
  assert.deepEqual([...legs.keys()], ['s1'], 'no leg for the dragged and the new node')
  const f = tweenedFrame(after, legs, T + 100, hold).frame
  assert.deepEqual([f.agents.get('s3')!.x, f.agents.get('s3')!.y], [900, 900])
  assert.deepEqual([f.agents.get('s2')!.x, f.agents.get('s2')!.y], [123, 456], 'a drag applies at once')
  const t = f.toolCalls.get('s2::t')!
  assert.deepEqual([t.x - 123, t.y - 456], [30, 0], 'its satellite follows the drop')
  assert.ok(f.agents.get('s1')!.x > 0 && f.agents.get('s1')!.x < 50, 's1 is on its way')
  // Even at rest (no legs) a held node that differs from the scene frame is drawn where it was dropped.
  assert.equal(tweenedFrame(after, null, T, hold).frame.agents.get('s2')!.x, 123)
})

test('ghost of a node in a cloud that moved: it moves with the centre of its cloud, with its satellites', () => {
  const cloud = (...ids: string[]) => ({ id: 'cloud:p', label: 'p', color: '#fff', status: 'idle' as const, members: ids.map(id => ({ id, pad: 70 })) })
  const live = (dx: number, ids: string[]) => {
    const s = frame(ids.map((id, i) => agent(id, dx + i * 150, 0)), ids.map(id => tool(`${id}::t`, id, 0, 0)).map(t => ({ ...t, x: dx + 20, y: 20 })))
    return { ...s, clouds: [cloud(...ids)] }
  }
  const tracker = newFleetPresenceTracker()
  withGhosts(live(0, ['a', 'b']), tracker, T, new Map([['cloud:p', { x: 75, y: 0 }]]))
  // b leaves; the cloud's centre moves 500 right and 40 down (the grid shifted).
  const next = live(500, ['a'])
  const f = withGhosts(next, tracker, T + 10, new Map([['cloud:p', { x: 575, y: 40 }]]))
  const ghost = f.agents.get('b')!
  assert.deepEqual([ghost.x, ghost.y], [150 + 500, 0 + 40], 'old place plus the centre delta')
  assert.equal(f.toolCalls.get('b::t')!.x, 20 + 500, 'its satellite moves along')
  assert.equal(f.toolCalls.get('b::t')!.y, 20 + 40)
  assert.equal(f.agents.get('a')!.x, 500, 'the live node is untouched')
  // A cloud that did not move: the ghost stays where it was (same object, nothing to copy).
  const t2 = newFleetPresenceTracker()
  withGhosts(live(0, ['a', 'b']), t2, T, new Map([['cloud:p', { x: 75, y: 0 }]]))
  const still = withGhosts(live(0, ['a']), t2, T + 10, new Map([['cloud:p', { x: 75, y: 0 }]]))
  assert.deepEqual([still.agents.get('b')!.x, still.agents.get('b')!.y], [150, 0])
})

test('a resource that leaves while it glides keeps gliding to its last place: no jump back, no restart', () => {
  // Frame 1: the board is at 0; frame 2: the scene moves it to 400 and the board starts to glide.
  const f1 = frame([agent('kanban:b', 0, 0, { resourceKind: 'kanban' })])
  const f2 = frame([agent('kanban:b', 400, 0, { resourceKind: 'kanban' })])
  const tracker = newFleetPresenceTracker()
  withGhosts(f1, tracker, T - 5000)
  const live2 = withGhosts(f2, tracker, T)
  let legs = retarget(null, positionsOf(f1), positionsOf(live2), T)
  const midAt = T + 200
  const shownMid = tweenedFrame(live2, legs, midAt).frame
  const midX = shownMid.agents.get('kanban:b')!.x
  assert.ok(midX > 0 && midX < 400)
  // The board leaves at midAt: the ghost is snapshotted at its scene target (400), but the tween owns it.
  const gone = withGhosts(frame([]), tracker, midAt)
  assert.ok(gone.agents.has('kanban:b'), 'a ghost')
  legs = retarget(legs, positionsOf(shownMid), positionsOf(gone), midAt)
  assert.equal(legs.get('kanban:b')!.since, T, 'the same leg continues')
  const next = tweenedFrame(gone, legs, midAt + 16).frame.agents.get('kanban:b')!.x
  assert.ok(next >= midX && next < 400, `continues from ${midX}, not back to 0 or a jump to 400: ${next}`)
})
