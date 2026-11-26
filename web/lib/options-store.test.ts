import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createOptionsStore } from './options-store'
import { OPTIONS_KEY, defaultOptions, parseOptions } from './fleet/options-registry'
import { LEGACY_KEYS } from './fleet/options-migration'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    m,
  }
}

test('first read loads the stored options and migrates old keys; the first read of an empty browser is the defaults', () => {
  const s = memStorage({ [LEGACY_KEYS.sound]: 'on' })
  const store = createOptionsStore(() => s)
  assert.equal(store.get().soundOn, true)
  assert.equal(store.get(), store.get(), 'same object until something changes')
  const fresh = createOptionsStore(() => memStorage())
  assert.deepEqual(fresh.get(), { ...defaultOptions(), legacyMigrated: true })
})

test('an update is applied at once, saved under the one key, and announced', () => {
  const s = memStorage()
  const store = createOptionsStore(() => s)
  let calls = 0
  const off = store.subscribe(() => { calls++ })
  const v0 = store.version()
  const r = store.update({ lingerSeconds: { bash: 0 }, show: { fleet: { memory: false } } })
  assert.equal(r.ok, true)
  assert.equal(store.get().lingerSeconds.bash, 0)
  assert.equal(store.get().show.fleet.memory, false)
  assert.equal(calls, 1)
  assert.equal(store.version(), v0 + 1)
  assert.equal(parseOptions(s.m.get(OPTIONS_KEY)).lingerSeconds.bash, 0, 'what is stored equals what is live')
  // only the registry key is ever written (the old keys were only read)
  assert.deepEqual([...s.m.keys()], [OPTIONS_KEY])
  off()
  store.update({ fadeSeconds: 3 })
  assert.equal(calls, 1, 'unsubscribed')
})

test('a bad patch changes nothing: no write, no announcement', () => {
  const s = memStorage()
  const store = createOptionsStore(() => s)
  const before = store.get()
  const stored = s.m.get(OPTIONS_KEY)
  let calls = 0
  store.subscribe(() => { calls++ })
  const r = store.update({ lingerSeconds: { bash: 5, kanban: -1 } })
  assert.equal(r.ok, false)
  assert.equal(store.get(), before)
  assert.equal(s.m.get(OPTIONS_KEY), stored)
  assert.equal(calls, 0)
})

test('reset goes back to the defaults but keeps the migration marker, so old keys are not copied in again', () => {
  const s = memStorage({ [LEGACY_KEYS.sound]: 'on' })
  const store = createOptionsStore(() => s)
  store.update({ lingerSeconds: { bash: 99 } })
  store.reset()
  assert.deepEqual(store.get(), { ...defaultOptions(), legacyMigrated: true })
  const reopened = createOptionsStore(() => s)
  assert.equal(reopened.get().soundOn, false, 'the old sound key is not applied again')
  assert.equal(reopened.get().lingerSeconds.bash, 20)
})

test('another tab: reload picks up what it saved and announces it', () => {
  const s = memStorage()
  const a = createOptionsStore(() => s)
  const b = createOptionsStore(() => s)
  a.get(); b.get()
  let calls = 0
  b.subscribe(() => { calls++ })
  a.update({ soundOn: true, fleetDeselected: ['x'] })
  assert.equal(b.get().soundOn, false, 'b has not heard yet')
  b.reload()
  assert.equal(b.get().soundOn, true)
  assert.deepEqual(b.get().fleetDeselected, ['x'])
  assert.equal(calls, 1)
})

test('no storage (server render): defaults, updates still work in memory, and storage is picked up when it appears', () => {
  let s: ReturnType<typeof memStorage> | null = null
  const store = createOptionsStore(() => s)
  assert.deepEqual(store.get(), defaultOptions())
  assert.equal(store.getServer(), store.getServer())
  const r = store.update({ soundOn: true })
  assert.equal(r.ok && r.saved, false)
  assert.equal(store.get().soundOn, true)
  s = memStorage({ [LEGACY_KEYS.fleetTimeline]: 'hidden' })
  store.reload()
  assert.equal(store.get().soundOn, false)
})

test('a storage that throws does not break reading or updating', () => {
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  const store = createOptionsStore(() => boom)
  assert.equal(store.get().fadeSeconds, 15)
  const r = store.update({ fadeSeconds: 1 })
  assert.equal(r.ok && r.saved, false)
  assert.equal(store.get().fadeSeconds, 1)
})

test('fleetDeselected keeps its identity across unrelated updates (the fleet hook memoises on it)', () => {
  const store = createOptionsStore(() => memStorage())
  store.update({ fleetDeselected: ['a', 'b'] })
  const list = store.get().fleetDeselected
  store.update({ lingerSeconds: { memory: 10 } })
  assert.equal(store.get().fleetDeselected, list)
})
