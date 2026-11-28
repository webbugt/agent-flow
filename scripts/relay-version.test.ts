/**
 * The relay's `server-version` announcement: the interval setting and the wire shape the page parses.
 * (The live behaviour, on connect and every interval, is checked with an SSE probe; see the task report.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VERSION_BROADCAST_MS, resolveVersionBroadcastMs } from './version-broadcast'
import { parseServerVersion, serverVersionMessage } from '../web/lib/server-version'
import { BUILD_INFO } from '../app/src/build-info'

test('interval: default 60 s, env var and explicit option override, 0 disables', () => {
  assert.equal(DEFAULT_VERSION_BROADCAST_MS, 60_000)
  assert.equal(resolveVersionBroadcastMs(undefined, {}), 60_000)
  assert.equal(resolveVersionBroadcastMs(undefined, { AGENT_FLOW_VERSION_BROADCAST_MS: '5000' }), 5000)
  assert.equal(resolveVersionBroadcastMs(250, { AGENT_FLOW_VERSION_BROADCAST_MS: '5000' }), 250)
  assert.equal(resolveVersionBroadcastMs(undefined, { AGENT_FLOW_VERSION_BROADCAST_MS: '0' }), 0)
  assert.equal(resolveVersionBroadcastMs(0, {}), 0)
})

test('interval: junk falls back to the default', () => {
  for (const v of ['abc', '-5', 'NaN', 'Infinity', '  ']) {
    assert.equal(resolveVersionBroadcastMs(undefined, { AGENT_FLOW_VERSION_BROADCAST_MS: v }), 60_000, v)
  }
  assert.equal(resolveVersionBroadcastMs(-1, {}), 60_000)
})

test('wire: what the relay sends is what the page parses (JSON round trip)', () => {
  const wire = JSON.parse(JSON.stringify(serverVersionMessage({ commit: 'abc123', branch: 'main' })))
  assert.deepEqual(wire, { type: 'server-version', commit: 'abc123', branch: 'main' })
  assert.deepEqual(parseServerVersion(wire), wire)
})

test('running from source (tsx) announces "unknown", which pages ignore', () => {
  assert.deepEqual(serverVersionMessage(BUILD_INFO), { type: 'server-version', commit: 'unknown', branch: 'unknown' })
})
