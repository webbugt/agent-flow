/**
 * The `limits-update` payload exists twice: extension/src/protocol.ts (the host builds it) and
 * web/lib/costs/observed-types.ts (the page reads it); the extension's rootDir is `src`, so they cannot share a file.
 * This test pushes payloads built by the host's own builder through the page's validator and view builder, so a field
 * renamed on one side fails here. Temp HOME only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildLimitsUpdate, limitsUpdateMessage } from '../extension/src/limits-observer'
import { installStatusLine, paths, type InstallerEnv } from '../extension/src/statusline-installer'
import { parseLimitsPayload } from '../web/lib/limits-runtime'
import { buildObservedLimitsView } from '../web/lib/costs/observed-limits'

const NOW = 1_900_000_000_000
const clock = { hm: () => 'HH:MM', dayHm: () => 'D HH:MM', sameDay: () => true }

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-contract-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: InstallerEnv = { home, nodePath: process.execPath, managedSettingsPaths: [path.join(root, 'none.json')], claudeConfigDir: path.join(home, '.claude') }
  return { root, env, p: paths(home) }
}

test('host payloads survive the page validator unchanged, in every state', () => {
  const s = sandbox()
  try {
    const states: ReturnType<typeof buildLimitsUpdate>[] = []
    states.push(buildLimitsUpdate({ env: s.env, now: NOW, seq: 1, canConfigure: true })) // prompt
    states.push(buildLimitsUpdate({ env: s.env, now: NOW, seq: 2, canConfigure: false })) // relay
    assert.equal(installStatusLine(s.env).ok, true)
    states.push(buildLimitsUpdate({ env: s.env, now: NOW, seq: 3, canConfigure: true })) // waiting
    fs.mkdirSync(s.p.limitsDir, { recursive: true })
    fs.writeFileSync(s.p.limits, JSON.stringify({ v: 1, at: NOW - 60_000, model: { id: 'claude-opus-4-7' }, rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: (NOW + 3_600_000) / 1000 }, seven_day: { used_percentage: 41, resets_at: (NOW + 86_400_000) / 1000 }, weekly_model: { used_percentage: 3 } } }))
    states.push(buildLimitsUpdate({ env: s.env, now: NOW, seq: 4, canConfigure: true })) // fresh
    states.push(buildLimitsUpdate({ env: s.env, now: NOW + 3_600_000 * 2, seq: 5, canConfigure: true })) // stale + expired 5h
    fs.writeFileSync(s.p.limits, '{ nope')
    states.push(buildLimitsUpdate({ env: s.env, now: NOW, seq: 6, canConfigure: true })) // file error
    for (const st of states) {
      const wire = JSON.parse(JSON.stringify(limitsUpdateMessage(st))) as { type: string; limits: unknown }
      assert.equal(wire.type, 'limits-update')
      assert.deepEqual(parseLimitsPayload(wire.limits), st, `seq ${st.seq}`)
    }
    const view = buildObservedLimitsView(parseLimitsPayload(JSON.parse(JSON.stringify(states[3]))), NOW, clock)
    assert.equal(view.mode, 'observed')
    assert.equal(view.chip?.text, '5h 24% · wk 41%')
    const stale = buildObservedLimitsView(parseLimitsPayload(JSON.parse(JSON.stringify(states[4]))), NOW + 3_600_000 * 2, clock)
    assert.equal(stale.rows[0].tag, 'ended')
    assert.equal(stale.rows[1].tag, 'stale')
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true })
  }
})
