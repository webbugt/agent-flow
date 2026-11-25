import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { isShotSearch, seededRandom, SHOT_MODE, registerShotHook, markShotReady } from './shot-mode'

test('isShotSearch is on only for shot=1', () => {
  assert.equal(isShotSearch('?shot=1'), true)
  assert.equal(isShotSearch('?a=b&shot=1'), true)
  assert.equal(isShotSearch(''), false)
  assert.equal(isShotSearch('?shot=0'), false)
  assert.equal(isShotSearch('?shot=true'), false)
  assert.equal(isShotSearch('?shots=1'), false)
})

test('seededRandom is deterministic, in [0,1) and differs per seed', () => {
  const a = seededRandom(7); const b = seededRandom(7); const c = seededRandom(8)
  const xs = Array.from({ length: 20 }, () => a())
  assert.deepEqual(xs, Array.from({ length: 20 }, () => b()))
  assert.notDeepEqual(xs, Array.from({ length: 20 }, () => c()))
  for (const x of xs) assert.ok(x >= 0 && x < 1)
})

test('without ?shot=1 nothing changes: no flag, no global, hooks and ready are no-ops, Math.random untouched', () => {
  assert.equal(SHOT_MODE, false)
  assert.equal((globalThis as { window?: unknown }).window, undefined)
  const off = registerShotHook('freeze', () => { throw new Error('must never be registered') })
  assert.equal(typeof off, 'function')
  off()
  markShotReady()
  assert.equal(Math.random.toString().includes('native code'), true, 'Math.random is still the native one')
})

test('with ?shot=1 the module seeds Math.random and installs window.__AF_TEST__', () => {
  const script = `
    const styles = []
    globalThis.document = { createElement: () => ({}), documentElement: { appendChild: el => styles.push(el.textContent) } }
    globalThis.window = { location: { search: '?shot=1' } }
    const ns = await import(${JSON.stringify(path.join(__dirname, 'shot-mode.ts'))})
    const m = ns.registerShotHook ? ns : ns.default
    const first = [Math.random(), Math.random()]
    const api = window.__AF_TEST__
    const out = {
      shot: m.SHOT_MODE,
      animationsOff: styles.length === 1 && /animation:none/.test(styles[0]),
      hasApi: !!api,
      readyBefore: api && api.ready,
      names: api && api.agentNames(),
      rect: api && api.agentRect('x'),
      settled: api && api.settled(),
      freezeThrows: (() => { try { api.freeze(); return false } catch { return true } })(),
    }
    let frozen = 0
    m.registerShotHook('freeze', () => { frozen++ })
    api.freeze()
    m.markShotReady()
    out.frozen = frozen
    out.readyAfter = api.ready
    out.first = first
    console.log(JSON.stringify(out))
  `
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', cwd: path.resolve(__dirname, '..', '..') })
  const r1 = run(); const r2 = run()
  assert.equal(r1.status, 0, r1.stderr)
  const o1 = JSON.parse(r1.stdout.trim().split('\n').pop()!)
  const o2 = JSON.parse(r2.stdout.trim().split('\n').pop()!)
  assert.equal(o1.shot, true)
  assert.equal(o1.hasApi, true)
  assert.equal(o1.animationsOff, true, 'CSS animations are disabled in shot mode')
  assert.equal(o1.readyBefore, false)
  assert.deepEqual(o1.names, [])
  assert.equal(o1.rect, null)
  assert.equal(o1.settled, false)
  assert.equal(o1.freezeThrows, true, 'freeze before the page registered it fails loudly')
  assert.equal(o1.frozen, 1)
  assert.equal(o1.readyAfter, true)
  assert.deepEqual(o1.first, o2.first, 'seeded Math.random repeats across processes')
})
