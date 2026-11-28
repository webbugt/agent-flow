import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CURSOR_HIDE_DELAY_MS, createCursorHider } from './cursor-hide'

/** A fake clock: timers run when `advance` passes their time. */
function harness() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const calls: boolean[] = []
  const hider = createCursorHider({
    onHiddenChange: h => { calls.push(h) },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimer: h => { timers.delete(h as number) },
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].fn()
    }
    now = end
  }
  return { hider, advance, calls, pending: () => timers.size }
}

test('delay is 500 ms', () => assert.equal(CURSOR_HIDE_DELAY_MS, 500))

test('start hides the cursor', () => {
  const h = harness()
  h.hider.start()
  assert.deepEqual(h.calls, [true])
})

test('a pointer move shows the cursor, 500 ms of stillness hides it again', () => {
  const h = harness()
  h.hider.start()
  h.hider.move(10, 10)
  assert.deepEqual(h.calls, [true, false])
  h.advance(499)
  assert.deepEqual(h.calls, [true, false], 'still shown at 499 ms')
  h.advance(1)
  assert.deepEqual(h.calls, [true, false, true], 'hidden at 500 ms')
})

test('continued movement keeps it shown; the timer restarts on every move', () => {
  const h = harness()
  h.hider.start()
  h.hider.move(1, 1)
  h.advance(400)
  h.hider.move(2, 2)
  h.advance(400)
  assert.deepEqual(h.calls, [true, false], '800 ms after the first move, 400 after the last: still shown')
  assert.equal(h.pending(), 1, 'one timer, not one per move')
  h.advance(100)
  assert.deepEqual(h.calls, [true, false, true])
})

test('a repeat of the same position is not a movement (synthetic move after a layout change)', () => {
  const h = harness()
  h.hider.start()
  h.hider.move(5, 5)
  h.advance(500)
  assert.deepEqual(h.calls, [true, false, true])
  h.hider.move(5, 5)
  assert.deepEqual(h.calls, [true, false, true], 'stays hidden')
  h.hider.move(6, 5)
  assert.deepEqual(h.calls, [true, false, true, false])
})

test('stop clears the timer and ignores later moves (screensaver off / unmount)', () => {
  const h = harness()
  h.hider.start()
  h.hider.move(1, 1)
  assert.equal(h.pending(), 1)
  h.hider.stop()
  assert.equal(h.pending(), 0, 'timer cleaned up')
  h.hider.move(9, 9)
  h.advance(2000)
  assert.deepEqual(h.calls, [true, false], 'no callback after stop')
})

test('start again after stop hides at once and does not remember the old position', () => {
  const h = harness()
  h.hider.start()
  h.hider.move(1, 1)
  h.hider.stop()
  h.hider.start()
  assert.deepEqual(h.calls, [true, false, true])
  h.hider.move(1, 1)
  assert.deepEqual(h.calls, [true, false, true, false], 'the same spot counts as a move in a new run')
})
