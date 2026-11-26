import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { INITIAL_CAMERA_STATE, transition, type CameraEvent, type CameraState } from './camera-state'
import { shouldRefit, type FitBasis } from './fleet-camera'

const run = (start: CameraState, ...events: CameraEvent[]) => {
  let state = start
  const actions: string[] = []
  for (const e of events) {
    const r = transition(state, e)
    state = r.state
    actions.push(r.action)
  }
  return { state, actions }
}

const INTRO: CameraState = { mode: 'intro', userNavigated: false }

test('layout fit starts the intro; arriving settles it', () => {
  const a = run(INITIAL_CAMERA_STATE, { type: 'layout-fit' })
  assert.deepEqual(a.state, INTRO)
  assert.deepEqual(a.actions, ['animate'])
  const b = run(a.state, { type: 'arrived' })
  assert.deepEqual(b.state, { mode: 'settled', userNavigated: false })
})

test('intro -> interrupted -> user control, for every navigation input', () => {
  for (const kind of ['wheel', 'pinch', 'drag', 'zoom-button', 'press'] as const) {
    const r = run(INTRO, { type: 'input', kind })
    assert.deepEqual(r.state, { mode: 'user', userNavigated: true }, kind)
    assert.deepEqual(r.actions, ['stop'], `${kind} stops the animation at once`)
  }
})

test('the intro does not re-run after an interrupt, only an explicit fit starts it again', () => {
  const interrupted = run(INTRO, { type: 'input', kind: 'wheel' }).state
  const r = run(interrupted, { type: 'layout-fit' }, { type: 'layout-fit' }, { type: 'arrived' })
  assert.deepEqual(r.state, { mode: 'user', userNavigated: true })
  assert.deepEqual(r.actions, ['none', 'none', 'none'])
  const again = run(interrupted, { type: 'explicit-fit' })
  assert.deepEqual(again.state, INTRO)
  assert.deepEqual(again.actions, ['animate'])
})

test('a press on a settled camera (click on a node) does not take control', () => {
  const settled: CameraState = { mode: 'settled', userNavigated: false }
  const r = run(settled, { type: 'input', kind: 'press' })
  assert.deepEqual(r.state, settled)
  assert.deepEqual(r.actions, ['none'])
  // ...and a later real layout change still re-fits.
  assert.deepEqual(run(r.state, { type: 'layout-fit' }).state, INTRO)
})

test('navigation input on a settled camera takes control', () => {
  const r = run({ mode: 'settled', userNavigated: false }, { type: 'input', kind: 'drag' })
  assert.deepEqual(r.state, { mode: 'user', userNavigated: true })
})

test('fit button during the intro ends it at the destination; outside the intro it animates', () => {
  const during = run(INTRO, { type: 'explicit-fit' })
  assert.deepEqual(during.state, { mode: 'settled', userNavigated: false })
  assert.deepEqual(during.actions, ['snap'])
  const fromUser = run({ mode: 'user', userNavigated: true }, { type: 'explicit-fit' })
  assert.deepEqual(fromUser.state, INTRO)
  assert.deepEqual(fromUser.actions, ['animate'])
})

test('arrived outside the intro is ignored; reset hands the view back to auto-fit', () => {
  const user: CameraState = { mode: 'user', userNavigated: true }
  assert.deepEqual(run(user, { type: 'arrived' }).state, user)
  assert.deepEqual(run(user, { type: 'reset' }).state, { mode: 'settled', userNavigated: false })
})

test('state machine and shouldRefit agree: after an interrupt a layout change never re-fits', () => {
  const basis: FitBasis = { nodeCount: 8, width: 1200, height: 700 }
  const changed: FitBasis = { nodeCount: 12, width: 800, height: 700 }
  const s = run(INTRO, { type: 'input', kind: 'wheel' }).state
  assert.equal(shouldRefit(basis, changed, s.userNavigated), false)
  assert.equal(shouldRefit(basis, changed, INTRO.userNavigated), true)
})
