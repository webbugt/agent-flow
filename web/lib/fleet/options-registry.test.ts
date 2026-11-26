import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_FADE_SECONDS, DEFAULT_LINGER_SECONDS, MAX_FADE_SECONDS, MAX_LINGER_SECONDS, OPTIONS_KEY, RESOURCE_KINDS,
  applyOptionsPatch, defaultOptions, loadOptions, parseOptions, saveOptions, serializeOptions, validateOptions,
} from './options-registry'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

test('the storage key is agentflow.options.v1', () => {
  assert.equal(OPTIONS_KEY, 'agentflow.options.v1')
})

test('defaults: kanban 90 s, memory 60 s, bash 20 s, subsystem 45 s, fade 15 s, everything shown', () => {
  const d = defaultOptions()
  assert.deepEqual(d.lingerSeconds, { kanban: 90, memory: 60, bash: 20, subsystem: 45 })
  assert.deepEqual(DEFAULT_LINGER_SECONDS, d.lingerSeconds)
  assert.equal(d.fadeSeconds, 15)
  assert.equal(DEFAULT_FADE_SECONDS, 15)
  for (const view of ['single', 'fleet'] as const) for (const k of RESOURCE_KINDS) assert.equal(d.show[view][k], true)
  assert.equal(validateOptions(d).errors.length, 0)
})

test('defaultOptions returns a fresh object each time', () => {
  const a = defaultOptions()
  a.lingerSeconds.bash = 999
  a.show.fleet.memory = false
  assert.equal(defaultOptions().lingerSeconds.bash, 20)
  assert.equal(defaultOptions().show.fleet.memory, true)
})

test('empty storage and no storage give the defaults', () => {
  assert.deepEqual(loadOptions(memStorage()), defaultOptions())
  assert.deepEqual(loadOptions(null), defaultOptions())
})

test('save then load round-trips, and writes only the one key', () => {
  const s = memStorage()
  const o = defaultOptions()
  o.lingerSeconds.bash = 0
  o.lingerSeconds.memory = 120.5
  o.fadeSeconds = 0
  o.show.single.subsystem = false
  assert.equal(saveOptions(s, o), true)
  assert.deepEqual([...s.m.keys()], [OPTIONS_KEY])
  assert.deepEqual(loadOptions(s), o)
})

test('bad stored values fall back per field and keep the good ones', () => {
  const raw = JSON.stringify({
    version: 1,
    lingerSeconds: { kanban: -5, memory: 'soon', bash: 7, subsystem: 1e9 },
    fadeSeconds: NaN, // JSON turns NaN into null
    show: { single: { kanban: 'yes', bash: false }, fleet: 3 },
  })
  const o = parseOptions(raw)
  assert.equal(o.lingerSeconds.kanban, 90)
  assert.equal(o.lingerSeconds.memory, 60)
  assert.equal(o.lingerSeconds.bash, 7)
  assert.equal(o.lingerSeconds.subsystem, 45)
  assert.equal(o.fadeSeconds, 15)
  assert.equal(o.show.single.kanban, true)
  assert.equal(o.show.single.bash, false)
  assert.equal(o.show.fleet.kanban, true)
})

test('garbage, arrays and wrong types in storage give the defaults', () => {
  for (const raw of ['', '{', 'null', '[]', '"x"', '42', '{"version":2}']) {
    assert.deepEqual(parseOptions(raw), defaultOptions(), raw)
  }
})

test('validateOptions reports each rejected value and drops unknown fields', () => {
  const r = validateOptions({
    version: 1, evil: 1, lingerSeconds: { kanban: Infinity, bash: -1, nope: 3 }, fadeSeconds: MAX_FADE_SECONDS + 1,
  })
  assert.ok(r.errors.some(e => e.startsWith('lingerSeconds.kanban')))
  assert.ok(r.errors.some(e => e.startsWith('lingerSeconds.bash')))
  assert.ok(r.errors.some(e => e.startsWith('fadeSeconds')))
  assert.equal('evil' in r.options, false)
  assert.equal(JSON.stringify(r.options).includes('nope'), false)
})

test('limits: 0 and the maximum are valid, just beyond is not', () => {
  assert.equal(validateOptions({ version: 1, lingerSeconds: { kanban: 0 } }).errors.length, 0)
  assert.equal(validateOptions({ version: 1, lingerSeconds: { kanban: MAX_LINGER_SECONDS } }).errors.length, 0)
  assert.equal(validateOptions({ version: 1, lingerSeconds: { kanban: MAX_LINGER_SECONDS + 0.001 } }).errors.length, 1)
  assert.equal(validateOptions({ version: 1, fadeSeconds: 0 }).errors.length, 0)
})

test('saveOptions refuses an invalid object and writes nothing', () => {
  const s = memStorage()
  const bad = defaultOptions()
  bad.lingerSeconds.kanban = -1
  assert.equal(saveOptions(s, bad), false)
  assert.equal(s.m.size, 0)
  const nan = defaultOptions()
  nan.fadeSeconds = NaN
  assert.equal(saveOptions(s, nan), false)
  assert.equal(s.m.size, 0)
})

test('broken storage does not throw: load gives defaults, save reports failure', () => {
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  assert.deepEqual(loadOptions(boom), defaultOptions())
  assert.equal(saveOptions(boom, defaultOptions()), false)
  assert.equal(saveOptions(null, defaultOptions()), false)
})

test('applyOptionsPatch applies valid changes without touching the input', () => {
  const cur = defaultOptions()
  const r = applyOptionsPatch(cur, { lingerSeconds: { bash: 0, kanban: 30 }, fadeSeconds: 5, show: { fleet: { memory: false } } })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.options.lingerSeconds.bash, 0)
  assert.equal(r.options.lingerSeconds.kanban, 30)
  assert.equal(r.options.lingerSeconds.memory, 60)
  assert.equal(r.options.fadeSeconds, 5)
  assert.equal(r.options.show.fleet.memory, false)
  assert.equal(r.options.show.single.memory, true)
  assert.deepEqual(cur, defaultOptions())
})

test('applyOptionsPatch rejects the whole patch when one value is bad', () => {
  const cur = defaultOptions()
  const bad: unknown[] = [
    { lingerSeconds: { bash: 5, kanban: -1 } },
    { lingerSeconds: { bash: '5' } },
    { lingerSeconds: { bash: NaN } },
    { lingerSeconds: { bash: Infinity } },
    { lingerSeconds: { bash: MAX_LINGER_SECONDS + 1 } },
    { lingerSeconds: { files: 5 } },
    { fadeSeconds: -0.1 },
    { fadeSeconds: null },
    { fadeSeconds: MAX_FADE_SECONDS + 1 },
    { show: { fleet: { memory: 'no' } } },
    { show: { grid: { memory: true } } },
    { show: { fleet: { files: true } } },
  ]
  for (const p of bad) {
    const r = applyOptionsPatch(cur, p as never)
    assert.equal(r.ok, false, JSON.stringify(p))
    if (!r.ok) assert.ok(r.errors.length > 0)
  }
  assert.deepEqual(cur, defaultOptions())
})

test('serializeOptions output validates cleanly', () => {
  assert.equal(validateOptions(JSON.parse(serializeOptions(defaultOptions()))).errors.length, 0)
})
