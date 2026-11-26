import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  KIND_LABELS, fadeHint, hiddenAgentsText, lingerHint, parseFadeInput, parseLingerInput, parseSecondsInput, resourceBlockDefaultsPatch,
} from './options-panel-model'
import {
  MAX_FADE_SECONDS, MAX_LINGER_SECONDS, RESOURCE_KINDS, applyOptionsPatch, defaultOptions,
} from './options-registry'

test('seconds input: plain numbers are accepted, with a comma or surrounding spaces', () => {
  assert.deepEqual(parseLingerInput('20'), { ok: true, value: 20 })
  assert.deepEqual(parseLingerInput(' 7.5 '), { ok: true, value: 7.5 })
  assert.deepEqual(parseLingerInput('7,5'), { ok: true, value: 7.5 })
  assert.deepEqual(parseLingerInput('0'), { ok: true, value: 0 })
  assert.deepEqual(parseLingerInput(String(MAX_LINGER_SECONDS)), { ok: true, value: MAX_LINGER_SECONDS })
  assert.deepEqual(parseFadeInput(String(MAX_FADE_SECONDS)), { ok: true, value: MAX_FADE_SECONDS })
})

test('seconds input: empty, text, negatives, exponents, Infinity and too large are rejected with a reason', () => {
  for (const t of ['', '  ', 'abc', '-1', '1e3', 'Infinity', 'NaN', '5s', '1.2.3', '.5', '5.', '0x10']) {
    const r = parseLingerInput(t)
    assert.equal(r.ok, false, JSON.stringify(t))
    if (!r.ok) assert.ok(r.error.length > 0)
  }
  assert.equal(parseLingerInput(String(MAX_LINGER_SECONDS + 1)).ok, false)
  assert.equal(parseFadeInput(String(MAX_FADE_SECONDS + 1)).ok, false)
  assert.equal(parseSecondsInput('5', 4).ok, false)
})

test('whatever the panel parser accepts, the registry accepts too', () => {
  const cur = defaultOptions()
  for (const t of ['0', '1', '20', '7.5', '3600']) {
    const r = parseLingerInput(t)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(applyOptionsPatch(cur, { lingerSeconds: { bash: r.value } }).ok, true, t)
  }
  for (const t of ['0', '15', '600']) {
    const r = parseFadeInput(t)
    if (r.ok) assert.equal(applyOptionsPatch(cur, { fadeSeconds: r.value }).ok, true, t)
  }
})

test('every kind has a label; hints describe 0 and non-zero values', () => {
  for (const k of RESOURCE_KINDS) assert.ok(KIND_LABELS[k].length > 0)
  assert.match(lingerHint(0), /immediately/)
  assert.match(lingerHint(20), /20 s/)
  assert.match(fadeHint(0), /hard cut/)
  assert.match(fadeHint(15), /15 s/)
})

test('the reset patch brings the block settings back to the defaults and leaves the rest alone', () => {
  const cur = defaultOptions()
  cur.lingerSeconds.bash = 0
  cur.fadeSeconds = 99
  cur.show.fleet.memory = false
  cur.soundOn = true
  cur.fleetDeselected = ['a']
  const r = applyOptionsPatch(cur, resourceBlockDefaultsPatch())
  assert.equal(r.ok, true)
  if (!r.ok) return
  const d = defaultOptions()
  assert.deepEqual(r.options.lingerSeconds, d.lingerSeconds)
  assert.equal(r.options.fadeSeconds, d.fadeSeconds)
  assert.deepEqual(r.options.show, d.show)
  assert.equal(r.options.soundOn, true)
  assert.deepEqual(r.options.fleetDeselected, ['a'])
})

test('hidden agents text', () => {
  assert.match(hiddenAgentsText(0), /No agents/)
  assert.match(hiddenAgentsText(1), /^1 agent or lane is/)
  assert.match(hiddenAgentsText(5), /^5 agents or lanes are/)
})
