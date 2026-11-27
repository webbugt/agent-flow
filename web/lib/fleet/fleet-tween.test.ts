import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { TWEEN_EPSILON, TWEEN_MS, legDone, legPosition, positionsAt, retarget } from './fleet-tween'

const T = 1_000_000
const P = (x: number, y: number) => ({ x, y })

test('a leg starts where the node is drawn, ends exactly at the new place and eases (slow-fast-slow) in between', () => {
  const legs = retarget(null, new Map([['a', P(0, 0)]]), new Map([['a', P(400, -200)]]), T)
  const leg = legs.get('a')!
  assert.deepEqual(legPosition(leg, T), P(0, 0))
  assert.deepEqual(legPosition(leg, T + TWEEN_MS), P(400, -200), 'exactly the target, no endless tail')
  assert.deepEqual(legPosition(leg, T + TWEEN_MS * 10), P(400, -200))
  assert.deepEqual(legPosition(leg, T - 500), P(0, 0), 'a clock before the start counts as the start')
  const half = legPosition(leg, T + TWEEN_MS / 2)
  assert.ok(Math.abs(half.x - 200) < 1e-9 && Math.abs(half.y + 100) < 1e-9, 'half way at half the time')
  const quarter = legPosition(leg, T + TWEEN_MS / 4)
  assert.ok(quarter.x > 0 && quarter.x < 100, `eases in: ${quarter.x}`)
  let last = -1
  for (let t = 0; t <= TWEEN_MS; t += 10) {
    const x = legPosition(leg, T + t).x
    assert.ok(x >= last, 'never goes back')
    last = x
  }
  assert.equal(legDone(leg, T + TWEEN_MS - 1), false)
  assert.equal(legDone(leg, T + TWEEN_MS), true)
})

test('the tween lasts 400-500 ms', () => {
  assert.ok(TWEEN_MS >= 400 && TWEEN_MS <= 500)
})

test('a node that is new on the map has no leg, a node already there does not move, one that must move does', () => {
  const shown = new Map([['stay', P(10, 10)], ['move', P(0, 0)]])
  const targets = new Map([['stay', P(10, 10 + TWEEN_EPSILON / 2)], ['move', P(300, 0)], ['new', P(5, 5)]])
  const legs = retarget(null, shown, targets, T)
  assert.deepEqual([...legs.keys()], ['move'])
})

test('a node the user holds (dragged) gets no leg: a drag applies at once', () => {
  const legs = retarget(null, new Map([['a', P(0, 0)], ['b', P(0, 0)]]), new Map([['a', P(100, 0)], ['b', P(100, 0)]]), T, new Map([['a', P(100, 0)]]))
  assert.deepEqual([...legs.keys()], ['b'])
})

test('a running leg towards the same place is kept (an event rebuild does not restart it); a new place starts from where it is drawn', () => {
  const first = retarget(null, new Map([['a', P(0, 0)]]), new Map([['a', P(400, 0)]]), T)
  const midAt = T + 200
  const mid = legPosition(first.get('a')!, midAt)
  // Same target again, half way: the very same leg, not a new one starting from `mid`.
  const same = retarget(first, new Map([['a', mid]]), new Map([['a', P(400, 0)]]), midAt)
  assert.equal(same.get('a'), first.get('a'))
  // A different target: continues from where the node is drawn now, with a fresh clock.
  const other = retarget(first, new Map([['a', mid]]), new Map([['a', P(400, 300)]]), midAt)
  const leg = other.get('a')!
  assert.notEqual(leg, first.get('a'))
  assert.deepEqual(leg.from, mid)
  assert.equal(leg.since, midAt)
  // A finished leg towards the same place is not kept: the node is there, no leg.
  const done = retarget(first, new Map([['a', P(400, 0)]]), new Map([['a', P(400, 0)]]), T + TWEEN_MS + 1)
  assert.equal(done.size, 0)
})

test('positionsAt: positions of every node with a leg; settled once all are over; no legs is settled', () => {
  const legs = retarget(null, new Map([['a', P(0, 0)], ['b', P(0, 0)]]), new Map([['a', P(100, 0)], ['b', P(0, 50)]]), T)
  const start = positionsAt(legs, T)
  assert.equal(start.settled, false)
  assert.deepEqual([...start.positions.keys()].sort(), ['a', 'b'])
  assert.deepEqual(start.positions.get('a'), P(0, 0))
  const end = positionsAt(legs, T + TWEEN_MS)
  assert.equal(end.settled, true)
  assert.deepEqual(end.positions.get('b'), P(0, 50))
  assert.deepEqual(positionsAt(null, T), { positions: new Map(), settled: true })
})

test('pure: the inputs are not changed, the same inputs give the same legs', () => {
  const shown = new Map([['a', P(0, 0)]])
  const targets = new Map([['a', P(9, 9)]])
  const a = retarget(null, shown, targets, T)
  const b = retarget(null, shown, targets, T)
  assert.deepEqual([...a], [...b])
  assert.deepEqual(shown.get('a'), P(0, 0))
  assert.deepEqual(targets.get('a'), P(9, 9))
})
