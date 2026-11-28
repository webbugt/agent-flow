import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKnownCommit, parseServerVersion, serverVersionMessage, shouldReload } from './server-version'
import { handleServerVersion, RELOAD_GUARD_KEY, type ReloadDeps } from './auto-reload'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('message shape: type, commit and branch, nothing else', () => {
  const msg = serverVersionMessage({ commit: A, branch: 'main' })
  assert.deepEqual(msg, { type: 'server-version', commit: A, branch: 'main' })
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg)
})

test('message shape: missing or non-string build info becomes "unknown"', () => {
  assert.deepEqual(serverVersionMessage({}), { type: 'server-version', commit: 'unknown', branch: 'unknown' })
  assert.deepEqual(serverVersionMessage({ commit: 42, branch: '  ' }), { type: 'server-version', commit: 'unknown', branch: 'unknown' })
  assert.equal(serverVersionMessage({ commit: `  ${A}\n` }).commit, A)
})

test('parseServerVersion accepts its own message and rejects everything else', () => {
  const msg = serverVersionMessage({ commit: A, branch: 'main' })
  assert.deepEqual(parseServerVersion(JSON.parse(JSON.stringify(msg))), msg)
  assert.equal(parseServerVersion(null), null)
  assert.equal(parseServerVersion('server-version'), null)
  assert.equal(parseServerVersion({ type: 'limits-update', commit: A }), null)
  assert.equal(parseServerVersion({ type: 'server-version' }), null)
  assert.equal(parseServerVersion({ type: 'server-version', commit: 7 }), null)
})

test('isKnownCommit: a real id only', () => {
  assert.equal(isKnownCommit(A), true)
  for (const v of ['unknown', 'UNKNOWN', ' unknown ', '', '  ', undefined, null, 5]) assert.equal(isKnownCommit(v), false, String(v))
})

test('shouldReload: differing known commits reload', () => {
  assert.equal(shouldReload({ clientCommit: A, serverCommit: B }), true)
})

test('shouldReload: same commit never reloads', () => {
  assert.equal(shouldReload({ clientCommit: A, serverCommit: A }), false)
  assert.equal(shouldReload({ clientCommit: A, serverCommit: ` ${A} ` }), false)
})

test('shouldReload: unknown on either side never reloads (dev / tsx run)', () => {
  assert.equal(shouldReload({ clientCommit: 'unknown', serverCommit: B }), false)
  assert.equal(shouldReload({ clientCommit: A, serverCommit: 'unknown' }), false)
  assert.equal(shouldReload({ clientCommit: 'unknown', serverCommit: 'unknown' }), false)
  assert.equal(shouldReload({ clientCommit: '', serverCommit: B }), false)
  assert.equal(shouldReload({ clientCommit: A, serverCommit: undefined }), false)
})

test('shouldReload: loop guard blocks a second reload for the same server commit, not for a newer one', () => {
  assert.equal(shouldReload({ clientCommit: A, serverCommit: B, lastReloadedFor: B }), false)
  assert.equal(shouldReload({ clientCommit: A, serverCommit: B, lastReloadedFor: A }), true)
  assert.equal(shouldReload({ clientCommit: A, serverCommit: B, lastReloadedFor: null }), true)
})

function fakeDeps(clientCommit: string, initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  let reloads = 0
  const deps: ReloadDeps = {
    clientCommit,
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v) } },
    reload: () => { reloads++ },
  }
  return { deps, store, reloads: () => reloads }
}

test('handleServerVersion: reloads once on mismatch and records the guard', () => {
  const f = fakeDeps(A)
  const msg = serverVersionMessage({ commit: B, branch: 'main' })
  assert.equal(handleServerVersion(msg, f.deps), true)
  assert.equal(f.reloads(), 1)
  assert.equal(f.store.get(RELOAD_GUARD_KEY), B)
  // the periodic broadcast repeats the message; the page (still stale) must not reload again
  assert.equal(handleServerVersion(msg, f.deps), false)
  assert.equal(f.reloads(), 1)
})

test('handleServerVersion: a still newer server commit reloads again', () => {
  const f = fakeDeps(A, { [RELOAD_GUARD_KEY]: B })
  assert.equal(handleServerVersion(serverVersionMessage({ commit: 'c'.repeat(40) }), f.deps), true)
  assert.equal(f.reloads(), 1)
})

test('handleServerVersion: matching, unknown and malformed messages do nothing', () => {
  const f = fakeDeps(A)
  assert.equal(handleServerVersion(serverVersionMessage({ commit: A }), f.deps), false)
  assert.equal(handleServerVersion(serverVersionMessage({}), f.deps), false)
  assert.equal(handleServerVersion({ type: 'server-version' }, f.deps), false)
  assert.equal(handleServerVersion({ type: 'agent-event' }, f.deps), false)
  const dev = fakeDeps('unknown')
  assert.equal(handleServerVersion(serverVersionMessage({ commit: B }), dev.deps), false)
  assert.equal(f.reloads() + dev.reloads(), 0)
})

test('handleServerVersion: no usable storage means no reload (it could loop)', () => {
  const none = fakeDeps(A)
  none.deps.storage = null
  assert.equal(handleServerVersion(serverVersionMessage({ commit: B }), none.deps), false)
  const throwing = fakeDeps(A)
  throwing.deps.storage = { getItem: () => null, setItem: () => { throw new Error('quota') } }
  assert.equal(handleServerVersion(serverVersionMessage({ commit: B }), throwing.deps), false)
  assert.equal(none.reloads() + throwing.reloads(), 0)
})
