import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  APP_STATE_KEY, DEFAULT_APP_STATE, loadAppState, parseAppState, pickInitialSession, saveAppState, serializeAppState, type AppState,
} from './app-state'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

test('the key is the versioned one', () => assert.equal(APP_STATE_KEY, 'agent-flow:app-state:v1'))

test('defaults: nothing stored, null, empty, garbage, a non-object', () => {
  assert.deepEqual(loadAppState(memStorage()), DEFAULT_APP_STATE)
  assert.deepEqual(loadAppState(null), DEFAULT_APP_STATE)
  assert.deepEqual(parseAppState(''), DEFAULT_APP_STATE)
  assert.deepEqual(parseAppState('not json'), DEFAULT_APP_STATE)
  assert.deepEqual(parseAppState('[1,2]'), DEFAULT_APP_STATE)
  assert.deepEqual(parseAppState('"x"'), DEFAULT_APP_STATE)
  assert.deepEqual(parseAppState('null'), DEFAULT_APP_STATE)
})

test('limits panel starts collapsed and the hex grid on, like before', () => {
  assert.equal(DEFAULT_APP_STATE.limitsCollapsed, true)
  assert.equal(DEFAULT_APP_STATE.showHexGrid, true)
  assert.equal(DEFAULT_APP_STATE.showFleet, false)
})

test('save then load round-trips every field', () => {
  const s = memStorage()
  const state: AppState = {
    showFleet: true, showTimeline: true, showStats: true, showHexGrid: false, showCostOverlay: false,
    showFileAttention: false, showTranscript: true, limitsCollapsed: false, selectedSessionId: 'hermes-sophia',
  }
  assert.equal(saveAppState(s, state), true)
  assert.ok(s.m.has(APP_STATE_KEY))
  assert.equal(s.m.size, 1, 'one key only')
  assert.deepEqual(loadAppState(s), state)
})

test('strict per field: a wrong type falls back to that field\'s default, the other fields survive', () => {
  const raw = JSON.stringify({ showFleet: 'yes', showTimeline: true, showStats: 1, showHexGrid: null, limitsCollapsed: false, selectedSessionId: 42 })
  assert.deepEqual(parseAppState(raw), { ...DEFAULT_APP_STATE, showTimeline: true, limitsCollapsed: false })
})

test('missing fields take their defaults; unknown fields are ignored', () => {
  assert.deepEqual(parseAppState('{"showFleet":true,"future":"x"}'), { ...DEFAULT_APP_STATE, showFleet: true })
})

test('selectedSessionId: only a non-empty string of sane length', () => {
  assert.equal(parseAppState('{"selectedSessionId":"a"}').selectedSessionId, 'a')
  assert.equal(parseAppState('{"selectedSessionId":""}').selectedSessionId, null)
  assert.equal(parseAppState('{"selectedSessionId":null}').selectedSessionId, null)
  assert.equal(parseAppState(JSON.stringify({ selectedSessionId: 'x'.repeat(201) })).selectedSessionId, null)
})

test('two exclusive right-hand panels stored open: only the first stays open', () => {
  const p = parseAppState('{"showFileAttention":true,"showTranscript":true,"showCostOverlay":true}')
  assert.equal(p.showFileAttention, true)
  assert.equal(p.showTranscript, false)
  assert.equal(p.showCostOverlay, false)
  const q = parseAppState('{"showTranscript":true,"showCostOverlay":true}')
  assert.equal(q.showTranscript, true)
  assert.equal(q.showCostOverlay, false)
})

test('the stored object holds nothing but the known fields (no transient state can leak in)', () => {
  const extra = { ...DEFAULT_APP_STATE, hovered: 'node-1', camera: { x: 1 } } as unknown as AppState
  const keys = Object.keys(JSON.parse(serializeAppState(extra))).sort()
  assert.deepEqual(keys, Object.keys(DEFAULT_APP_STATE).sort())
})

test('serialize is stable, so it works as a change key', () => {
  assert.equal(serializeAppState(DEFAULT_APP_STATE), serializeAppState({ ...DEFAULT_APP_STATE }))
  assert.notEqual(serializeAppState(DEFAULT_APP_STATE), serializeAppState({ ...DEFAULT_APP_STATE, showFleet: true }))
})

test('broken storage does not throw: load gives the defaults, save reports failure', () => {
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  assert.deepEqual(loadAppState(broken), DEFAULT_APP_STATE)
  assert.equal(saveAppState(broken, DEFAULT_APP_STATE), false)
  assert.equal(saveAppState(null, DEFAULT_APP_STATE), false)
})

test('a defaults object is never shared: changing a loaded state does not change the defaults', () => {
  const a = loadAppState(null)
  a.showFleet = true
  assert.equal(DEFAULT_APP_STATE.showFleet, false)
  assert.equal(loadAppState(memStorage()).showFleet, false)
})

// --- which tab opens ------------------------------------------------------------------------------

const sess = (id: string, status: string, last: number, idle?: boolean) => ({ id, status, lastActivityTime: last, ...(idle ? { idle } : {}) })

test('pickInitialSession: the tab the user left comes back when it is still listed', () => {
  const list = [sess('a', 'active', 100), sess('b', 'completed', 10)]
  assert.equal(pickInitialSession(list, 'b'), 'b')
})

test('pickInitialSession: a saved tab that is gone, or idle (fleet-only), falls back to the old rule', () => {
  const list = [sess('a', 'completed', 100), sess('b', 'active', 10), sess('c', 'active', 50, true)]
  assert.equal(pickInitialSession(list, 'zzz'), 'b', 'gone: the active one')
  assert.equal(pickInitialSession(list, 'c'), 'b', 'idle: never auto-selected')
  assert.equal(pickInitialSession(list, null), 'b')
})

test('pickInitialSession: no active session -> the most recently active; nothing selectable -> null', () => {
  assert.equal(pickInitialSession([sess('a', 'completed', 1), sess('b', 'completed', 9)], null), 'b')
  assert.equal(pickInitialSession([sess('a', 'completed', 1, true)], 'a'), null)
  assert.equal(pickInitialSession([], 'a'), null)
})
