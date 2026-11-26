import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  CLOUD_DURATIONS, CLOUD_ENTER_MS, CLOUD_EXIT_MS, CLOUD_SCALE_MIN, NODE_DURATIONS, NODE_ENTER_MS, NODE_EXIT_MS, NODE_SCALE_MIN,
  PresenceTracker, STEADY, cloudScale, easeInOutQuad, easeOutCubic, easeOutCubicInverse, enterStamp, exitStamp, isAnimating,
  levelOf, scaleOf, type PresenceStamp,
} from './fleet-presence'

// No clock anywhere: every time below is a plain number handed to the function.
const T = 1_000_000

const near = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} != ${b}`)

test('the easings start at 0, end at 1 and only rise', () => {
  for (const f of [easeOutCubic, easeInOutQuad]) {
    assert.equal(f(0), 0)
    assert.equal(f(1), 1)
    let prev = -1
    for (let i = 0; i <= 100; i++) { const v = f(i / 100); assert.ok(v >= prev); prev = v }
    assert.equal(f(-5), 0, 'clamped below')
    assert.equal(f(5), 1, 'clamped above')
  }
  near(easeInOutQuad(0.5), 0.5)
})

test('easeOutCubicInverse undoes easeOutCubic', () => {
  for (const p of [0, 0.1, 0.37, 0.5, 0.9, 1]) near(easeOutCubicInverse(easeOutCubic(p)), p, 1e-9)
})

test('entry: level goes 0 -> 1 over the enter time, fast at first (ease out)', () => {
  const s = enterStamp(undefined, T, NODE_DURATIONS)
  assert.equal(s.dir, 'in')
  near(levelOf(s, T), 0)
  assert.ok((levelOf(s, T + NODE_ENTER_MS / 4) as number) > 0.5, 'a quarter of the way in, already past half')
  near(levelOf(s, T + NODE_ENTER_MS), 1)
  near(levelOf(s, T + 10 * NODE_ENTER_MS), 1, 1e-12)
  let prev = -1
  for (let ms = 0; ms <= NODE_ENTER_MS; ms += 10) {
    const v = levelOf(s, T + ms) as number
    assert.ok(v >= prev, `monotonic at ${ms} ms`)
    prev = v
  }
})

test('exit: level goes 1 -> 0 over the exit time, then null (the ghost is dropped)', () => {
  const s = exitStamp(undefined, T, NODE_DURATIONS)
  assert.equal(s.dir, 'out')
  near(levelOf(s, T), 1)
  near(levelOf(s, T + NODE_EXIT_MS / 2), 0.5)
  assert.ok((levelOf(s, T + NODE_EXIT_MS - 1) as number) < 0.01)
  assert.equal(levelOf(s, T + NODE_EXIT_MS), null)
  assert.equal(levelOf(s, T + 99 * NODE_EXIT_MS), null)
  let prev = 2
  for (let ms = 0; ms < NODE_EXIT_MS; ms += 10) {
    const v = levelOf(s, T + ms) as number
    assert.ok(v <= prev, `monotonic at ${ms} ms`)
    prev = v
  }
})

test('a steady thing is at level 1 at any time and is not animating', () => {
  assert.equal(levelOf(STEADY, 0), 1)
  assert.equal(levelOf(STEADY, T), 1)
  assert.equal(isAnimating(STEADY, T), false)
})

test('the result depends on elapsed time only, not on how often it is asked (frame-rate independent)', () => {
  const s = enterStamp(undefined, T, NODE_DURATIONS)
  const at = T + 123
  const direct = levelOf(s, at)
  // 60 fps and 10 fps style sampling of the same instant give the same value; earlier samples change nothing.
  for (let t = T; t < at; t += 16) levelOf(s, t)
  for (let t = T; t < at; t += 100) levelOf(s, t)
  assert.equal(levelOf(s, at), direct)
  // The curve sampled at two different rates agrees at the instants they share.
  for (let ms = 0; ms <= NODE_ENTER_MS; ms += 50) assert.equal(levelOf(s, T + ms), levelOf({ ...s }, T + ms))
})

test('a time before the start counts as the start (clock skew does not push the level out of 0..1)', () => {
  const a = enterStamp(undefined, T, NODE_DURATIONS)
  near(levelOf(a, T - 5_000), 0)
  const b = exitStamp(undefined, T, NODE_DURATIONS)
  near(levelOf(b, T - 5_000), 1)
})

test('scale: shrinks to the minimum at level 0 and is 1 at level 1; halos start much smaller than nodes', () => {
  near(scaleOf(0), NODE_SCALE_MIN)
  near(scaleOf(1), 1)
  near(scaleOf(0.5), (NODE_SCALE_MIN + 1) / 2)
  near(scaleOf(-1), NODE_SCALE_MIN)
  near(scaleOf(7), 1)
  near(cloudScale(0), CLOUD_SCALE_MIN)
  near(cloudScale(1), 1)
  assert.ok(CLOUD_SCALE_MIN < NODE_SCALE_MIN)
})

test('clouds take longer than nodes, in and out', () => {
  assert.ok(CLOUD_ENTER_MS > NODE_ENTER_MS)
  assert.ok(CLOUD_EXIT_MS > NODE_EXIT_MS)
  assert.equal(CLOUD_DURATIONS.enterMs, CLOUD_ENTER_MS)
})

test('leaving half way through the entry fades from where it is, with no jump; a barely-in node is gone quickly', () => {
  const entering = enterStamp(undefined, T, NODE_DURATIONS)
  const mid = T + NODE_ENTER_MS / 3
  const level = levelOf(entering, mid) as number
  const leaving = exitStamp(entering, mid, NODE_DURATIONS)
  near(levelOf(leaving, mid), level)
  assert.ok(leaving.duration < NODE_EXIT_MS, 'shorter than a full exit')
  assert.equal(levelOf(leaving, mid + leaving.duration), null)
})

test('coming back while leaving continues from the current level', () => {
  const leaving = exitStamp(undefined, T, NODE_DURATIONS)
  const mid = T + NODE_EXIT_MS / 2
  const level = levelOf(leaving, mid) as number
  const back = enterStamp(leaving, mid, NODE_DURATIONS)
  near(levelOf(back, mid), level, 1e-9)
  assert.ok((levelOf(back, mid + 40) as number) > level, 'rises from there')
  near(levelOf(back, mid + NODE_ENTER_MS), 1)
})

test('coming back after the exit is over, or never left, is a plain entry or steady', () => {
  const left = exitStamp(undefined, T, NODE_DURATIONS)
  const late = enterStamp(left, T + 5 * NODE_EXIT_MS, NODE_DURATIONS)
  near(levelOf(late, T + 5 * NODE_EXIT_MS), 0)
  assert.equal(enterStamp(STEADY, T, NODE_DURATIONS).dir, 'steady')
})

test('isAnimating: true during an entry and any exit, false once the entry is done', () => {
  const s = enterStamp(undefined, T, NODE_DURATIONS)
  assert.equal(isAnimating(s, T + 1), true)
  assert.equal(isAnimating(s, T + NODE_ENTER_MS), false)
  assert.equal(isAnimating(exitStamp(undefined, T, NODE_DURATIONS), T + 1), true)
})

// ─── Tracker ────────────────────────────────────────────────────────────────

const snap = (...ids: string[]) => new Map(ids.map(id => [id, `snapshot of ${id}`]))
const dirOf = (t: PresenceTracker<string>, id: string) => t.stamps.get(id)?.dir

test('the first update only records what exists: opening the map animates nothing', () => {
  const t = new PresenceTracker<string>()
  const ghosts = t.update(snap('a', 'b'), T)
  assert.equal(ghosts.size, 0)
  assert.equal(dirOf(t, 'a'), 'steady')
  assert.equal(dirOf(t, 'b'), 'steady')
  assert.equal(t.nextExpiry(), null)
})

test('a newcomer enters; an id that is gone becomes a ghost with its last snapshot, until the exit is over', () => {
  const t = new PresenceTracker<string>()
  t.update(snap('a', 'b'), T)
  const g1 = t.update(snap('a', 'c'), T + 1000)
  assert.equal(dirOf(t, 'c'), 'in')
  assert.equal(dirOf(t, 'a'), 'steady')
  assert.deepEqual([...g1], [['b', 'snapshot of b']])
  assert.equal(dirOf(t, 'b'), 'out')
  assert.equal(t.nextExpiry(), T + 1000 + NODE_EXIT_MS)
  // half way: still a ghost, with the same stamp (the exit does not restart on every update)
  const stampBefore = t.stamps.get('b')
  const g2 = t.update(snap('a', 'c'), T + 1000 + NODE_EXIT_MS / 2)
  assert.equal(g2.size, 1)
  assert.equal(t.stamps.get('b'), stampBefore)
  // over: dropped for good
  const g3 = t.update(snap('a', 'c'), T + 1000 + NODE_EXIT_MS)
  assert.equal(g3.size, 0)
  assert.equal(t.stamps.has('b'), false)
  assert.equal(t.nextExpiry(), null)
})

test('an entry that has finished becomes steady at the next update', () => {
  const t = new PresenceTracker<string>()
  t.update(snap('a'), T)
  t.update(snap('a', 'b'), T + 10)
  assert.equal(dirOf(t, 'b'), 'in')
  t.update(snap('a', 'b'), T + 10 + NODE_ENTER_MS + 1)
  assert.equal(dirOf(t, 'b'), 'steady')
})

test('update is idempotent for the same ids (React strict mode builds twice)', () => {
  const t = new PresenceTracker<string>()
  t.update(snap('a'), T)
  t.update(snap('a', 'b'), T + 10)
  const first = t.stamps.get('b')
  t.update(snap('a', 'b'), T + 10)
  t.update(snap('a', 'b'), T + 12)
  assert.equal(t.stamps.get('b'), first)
})

test('an id that comes back while it is a ghost enters again from its current level and is no longer a ghost', () => {
  const t = new PresenceTracker<string>()
  t.update(snap('a', 'b'), T)
  t.update(snap('a'), T + 100)
  const mid = T + 100 + NODE_EXIT_MS / 2
  const level = levelOf(t.stamps.get('b') as PresenceStamp, mid) as number
  const ghosts = t.update(snap('a', 'b'), mid)
  assert.equal(ghosts.size, 0)
  assert.equal(dirOf(t, 'b'), 'in')
  near(levelOf(t.stamps.get('b') as PresenceStamp, mid), level)
})

test('durations come from the id: clouds are slower than nodes', () => {
  const t = new PresenceTracker<string>(id => (id.startsWith('cloud:') ? CLOUD_DURATIONS : NODE_DURATIONS))
  t.update(snap('x'), T)
  t.update(snap('x', 'cloud:p', 'n'), T + 5)
  assert.equal(t.stamps.get('cloud:p')?.duration, CLOUD_ENTER_MS)
  assert.equal(t.stamps.get('n')?.duration, NODE_ENTER_MS)
  t.update(snap('x'), T + 6_000)
  assert.equal(t.stamps.get('cloud:p')?.duration, CLOUD_EXIT_MS)
  assert.equal(t.stamps.get('n')?.duration, NODE_EXIT_MS)
  assert.equal(t.nextExpiry(), T + 6_000 + NODE_EXIT_MS, 'the soonest end')
})
