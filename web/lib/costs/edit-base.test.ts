import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editBase, isBaseChanged, MISSING_FINGERPRINT } from './edit-base'
import { applyCostsPayload, getCostsStatus, resetCostsRuntime } from '../costs-runtime'
import type { CostsConfigPayload, CostsLayer } from './layers'
import { applyDraft, draftFromDoc } from './settings-edit'

type Obj = Record<string, unknown>

const rule = (model: string, input: number): Obj => ({ match: { provider: 'anthropic', model }, rate: { input, output: input * 5 } })
const GOOD: Obj = { schemaVersion: 1, pricing: { models: [rule('claude-a', 1)] } }
const TWO: Obj = { schemaVersion: 1, pricing: { models: [rule('claude-a', 1), rule('claude-b', 2)] } }

function payload(user: CostsLayer | null, seq = 1, enabled = true): CostsConfigPayload {
  return { version: 1, seq, enabled, layers: user ? [user] : [] }
}
const ok = (raw: Obj, fingerprint = 'fp-ok'): CostsLayer => ({ id: 'user', path: '~/.agent-flow/costs.json', status: 'ok', raw, fingerprint })

/** The drawer's input as the real runtime derives it from a host message. */
function baseNow() {
  const st = getCostsStatus()
  return editBase(st.sources.find(s => s.id === 'user'), st.resolution.errors.filter(e => e.layer === 'user'), st.resolution.goodLayers.user as Obj | undefined)
}

test('nothing received yet: not loaded, so nothing to edit', () => {
  resetCostsRuntime()
  const b = baseNow()
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.kind, 'not-loaded')
})

test('a valid file is the base, with its content and fingerprint', () => {
  resetCostsRuntime()
  applyCostsPayload(payload(ok(GOOD, 'fp1')))
  const b = baseNow()
  assert.ok(b.ok)
  assert.deepEqual(b.ok && b.doc, GOOD)
  assert.equal(b.ok && b.fingerprint, 'fp1')
})

test('a missing file is a valid base: the version is "missing" and the draft starts empty', () => {
  resetCostsRuntime()
  applyCostsPayload(payload({ id: 'user', path: '~/.agent-flow/costs.json', status: 'missing' }))
  const b = baseNow()
  assert.ok(b.ok)
  assert.equal(b.ok && b.doc, undefined)
  assert.equal(b.ok && b.fingerprint, MISSING_FINGERPRINT)
})

test('BROKEN FILE (never loaded): blocked as unreadable; the old code would have saved a bare {schemaVersion:1}', () => {
  resetCostsRuntime()
  applyCostsPayload(payload({ id: 'user', path: '~/.agent-flow/costs.json', status: 'error', error: 'invalid JSON: Unexpected token at line 3 column 5, position 40', fingerprint: 'fp-broken' }))
  const st = getCostsStatus()
  assert.equal(st.resolution.goodLayers.user, undefined, 'the resolution has no base for a broken file')
  const b = baseNow()
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.kind, 'unreadable')
  assert.match(!b.ok ? b.reason : '', /invalid JSON/)
  assert.match(!b.ok ? b.reason : '', /Save is off/)
  // what the pre-fix drawer did: seed from the (missing) good layer and write the whole document
  assert.deepEqual(applyDraft(st.resolution.goodLayers.user as Obj | undefined, draftFromDoc(undefined)), { schemaVersion: 1 })
})

test('BROKEN AFTER BEING GOOD (host keeps a stale copy): still blocked; the stale copy is not an editing base', () => {
  resetCostsRuntime()
  applyCostsPayload(payload(ok(GOOD, 'fp1'), 1))
  applyCostsPayload(payload({ id: 'user', path: '~/.agent-flow/costs.json', status: 'error', error: 'invalid JSON: x', stale: true, raw: GOOD, fingerprint: 'fp-broken' }, 2))
  const b = baseNow()
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.kind, 'unreadable')
})

test('LAST GOOD: a valid file gains an invalid rule; the drawer must not start from the one-rule last-good copy', () => {
  resetCostsRuntime()
  applyCostsPayload(payload(ok(GOOD, 'fp1'), 1))
  const withBad: Obj = { schemaVersion: 1, pricing: { models: [rule('claude-a', 1), rule('claude-b', 2), { match: { model: 'x' }, rate: { input: -5, output: 1 } }] } }
  applyCostsPayload(payload(ok(withBad, 'fp2'), 2))
  const st = getCostsStatus()
  assert.equal(st.resolution.usingLastGood, true)
  assert.deepEqual(st.resolution.goodLayers.user, GOOD, 'the resolution serves the older one-rule copy')
  const b = baseNow()
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.kind, 'invalid')
  assert.match(!b.ok ? b.reason : '', /last good copy/)
})

test('costs turned off: the resolution is empty although the file is fine, so editing is refused', () => {
  resetCostsRuntime()
  applyCostsPayload(payload(ok(TWO, 'fp3'), 1, false))
  const b = baseNow()
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.kind, 'not-in-use')
})

test('an older host that reports no fingerprint cannot be checked, so editing is refused', () => {
  resetCostsRuntime()
  applyCostsPayload(payload({ id: 'user', path: '~/.agent-flow/costs.json', status: 'ok', raw: GOOD }))
  const b = baseNow()
  assert.equal(b.ok, false)
  assert.equal(!b.ok && b.kind, 'no-fingerprint')
})

test('an empty file is a valid base (an empty document, with a fingerprint)', () => {
  resetCostsRuntime()
  applyCostsPayload(payload(ok({}, 'fp-empty')))
  const b = baseNow()
  assert.ok(b.ok)
  assert.deepEqual(b.ok && b.doc, {})
})

test('CHANGED ON DISK: the drawer notices when the file moves to a version that is not one of its own', () => {
  resetCostsRuntime()
  applyCostsPayload(payload(ok(GOOD, 'fp1'), 1))
  const opened = baseNow()
  assert.ok(opened.ok)
  const known = [opened.ok ? opened.fingerprint : '']
  assert.equal(isBaseChanged(baseNow(), known), false)

  applyCostsPayload(payload(ok(TWO, 'fp2'), 2)) // edited by hand while the drawer is open
  assert.equal(isBaseChanged(baseNow(), known), true)

  // after our own save the host may publish the new content a moment after the save answered: both versions are ours
  assert.equal(isBaseChanged(baseNow(), ['fp2', 'fp1']), false)
  assert.equal(isBaseChanged(baseNow(), ['fp-saved', 'fp1']), true)
})

test('a blocked state is never reported as "changed" (the block message wins)', () => {
  resetCostsRuntime()
  applyCostsPayload(payload({ id: 'user', path: '~/x', status: 'error', error: 'invalid JSON: x', fingerprint: 'fp-broken' }))
  assert.equal(isBaseChanged(baseNow(), ['fp1']), false)
})
