import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ArgError, BUILTIN_PLANS, FORBIDDEN_PORTS, VIEWPORTS, assertAllowedPort, expandPlan, parseShotArgs,
  shotFileName, validatePlan,
} from './shot-lib'
import {
  CLAUDE_SESSIONS, CONFIG_FIXTURES, FIXTURE_IDS, HERMES_SESSIONS, LIMITS_FIXTURES, SCENARIOS,
  appendHermesLines, claudeTranscriptLines, encodeProjectDir, hermesLiveLines, loadScenario, materializeFixtures, rewriteConfigFixture,
} from './shot-fixtures'

// ─── Argument parsing ───────────────────────────────────────────────────────

test('parseShotArgs: --task-id is required and checked', () => {
  assert.throws(() => parseShotArgs([]), ArgError)
  assert.throws(() => parseShotArgs(['--task-id', '../x']), ArgError)
  assert.throws(() => parseShotArgs(['--task-id', '--plan']), ArgError)
  const o = parseShotArgs(['--task-id', 't_abc12345'])
  assert.equal(o.taskId, 't_abc12345')
  assert.equal(o.plan, 'builtin:overlay')
  assert.deepEqual(o.viewports, ['desktop', 'phone'])
  assert.equal(o.port, 0)
  assert.equal(o.scenario, 'costs')
})

test('parseShotArgs: options, one-shot flags and conflicts', () => {
  const o = parseShotArgs(['--task-id', 'x', '--viewports', 'phone', '--scenario', 'all', '--limits', 'L-2', '--config', 'C-eur', '--start-index', '3', '--no-build', '-v'])
  assert.deepEqual(o.viewports, ['phone'])
  assert.equal(o.scenario, 'all')
  assert.equal(o.limits, 'L-2')
  assert.equal(o.config, 'C-eur')
  assert.equal(o.startIndex, 3)
  assert.equal(o.noBuild, true)
  assert.equal(o.verbose, true)

  const c = parseShotArgs(['--task-id', 'x', '--name', 'My Tip', '--key', '$', '--hover', 'pill:first', '--wait', '200'])
  assert.deepEqual(c.custom, { name: 'my-tip', steps: [{ key: '$' }, { hover: 'pill:first' }, { wait: 200 }] })

  assert.throws(() => parseShotArgs(['--task-id', 'x', '--plan', 'builtin:h0', '--hover', '10,10']), ArgError)
  assert.throws(() => parseShotArgs(['--task-id', 'x', '--viewports', 'tablet']), ArgError)
  assert.throws(() => parseShotArgs(['--task-id', 'x', '--bogus']), ArgError)
  assert.throws(() => parseShotArgs(['--task-id', 'x', '--wait', '999999']), ArgError)
  assert.throws(() => parseShotArgs(['--task-id', 'x', '--start-index', '0']), ArgError)
  assert.equal(parseShotArgs(['--help']).help, true)
})

// ─── Port refusal (H0-A2) ───────────────────────────────────────────────────

test('ports 3001 and 3301 are refused, in the check and in argument parsing', () => {
  assert.deepEqual([...FORBIDDEN_PORTS], [3001, 3301])
  for (const p of [3001, 3301]) {
    assert.throws(() => assertAllowedPort(p), /refusing port/)
    assert.throws(() => parseShotArgs(['--task-id', 'x', '--port', String(p)]), /refusing port/)
  }
  assert.throws(() => assertAllowedPort(-1), ArgError)
  assert.throws(() => assertAllowedPort(70000), ArgError)
  assert.throws(() => assertAllowedPort(1.5), ArgError)
  assert.doesNotThrow(() => assertAllowedPort(3999))
  assert.equal(parseShotArgs(['--task-id', 'x', '--port', '3999']).port, 3999)
})

// ─── Viewports, file names, plans ───────────────────────────────────────────

test('viewports are 1440x900 and 390x844 at scale 2', () => {
  assert.deepEqual([VIEWPORTS.desktop.width, VIEWPORTS.desktop.height, VIEWPORTS.desktop.deviceScaleFactor, VIEWPORTS.desktop.mobile], [1440, 900, 2, false])
  assert.deepEqual([VIEWPORTS.phone.width, VIEWPORTS.phone.height, VIEWPORTS.phone.deviceScaleFactor, VIEWPORTS.phone.mobile], [390, 844, 2, true])
})

test('shotFileName: NN-slug-viewport[-hover].png', () => {
  assert.equal(shotFileName(1, 'Cost Overlay', 'desktop'), '01-cost-overlay-desktop.png')
  assert.equal(shotFileName(12, 'tip', 'phone', [{ hover: 'a' }]), '12-tip-phone-hover.png')
  assert.throws(() => shotFileName(1, '***', 'phone'), ArgError)
})

test('expandPlan numbers files in order and honours --viewports', () => {
  const both = expandPlan(BUILTIN_PLANS.h0, ['desktop', 'phone'], 1)
  assert.deepEqual(both.slice(0, 5).map(j => j.file), [
    '01-baseline-overlay-off-desktop.png',
    '02-baseline-overlay-on-desktop.png',
    '03-baseline-overlay-on-phone.png',
    '04-agent-hover-desktop-hover.png',
    '05-agent-tap-phone.png',
  ])
  assert.deepEqual(both.map(j => j.index), both.map((_, i) => i + 1))
  const phoneOnly = expandPlan(BUILTIN_PLANS.h0, ['phone'], 10)
  assert.ok(phoneOnly.length > 0 && phoneOnly.every(j => j.viewport === 'phone'))
  assert.equal(phoneOnly[0].index, 10)
  const smoke = expandPlan(BUILTIN_PLANS.overlay, ['desktop', 'phone'], 1)
  assert.deepEqual(smoke.map(j => j.file), ['01-cost-overlay-desktop.png', '02-cost-overlay-phone.png'])
})

test('validatePlan accepts a good plan and rejects bad ones', () => {
  const ok = validatePlan({ shots: [{ name: 'A b', viewports: ['phone'], steps: [{ hover: '1,2' }, { wait: 10 }] }] })
  assert.equal(ok.shots[0].name, 'a-b')
  assert.throws(() => validatePlan({}), ArgError)
  assert.throws(() => validatePlan({ shots: [] }), ArgError)
  assert.throws(() => validatePlan({ shots: [{ name: 'a' }, { name: 'A' }] }), /used twice/)
  assert.throws(() => validatePlan({ shots: [{ name: 'a', steps: [{ hover: 'x', click: 'y' }] }] }), ArgError)
  assert.throws(() => validatePlan({ shots: [{ name: 'a', steps: [{ nope: 'x' }] }] }), ArgError)
  assert.throws(() => validatePlan({ shots: [{ name: 'a', steps: [{ wait: -5 }] }] }), ArgError)
  assert.throws(() => validatePlan({ shots: [{ name: 'a', viewports: ['tv'] }] }), ArgError)
  for (const p of Object.values(BUILTIN_PLANS)) assert.doesNotThrow(() => validatePlan(p))
})

// ─── Fixtures (H0-A3, H0-A6, H0-A7) ─────────────────────────────────────────

test('fixture ids F-A..F-H, L-1..L-4 and C-* all exist', () => {
  for (const id of ['F-A', 'F-B', 'F-C', 'F-D', 'F-E', 'F-F', 'F-G', 'F-H', 'L-1', 'L-2', 'L-3', 'L-4', 'C-default', 'C-eur', 'C-invalid', 'C-custom-price', 'C-local-energy']) {
    assert.ok(FIXTURE_IDS.includes(id), `missing fixture ${id}`)
  }
  assert.deepEqual(Object.keys(LIMITS_FIXTURES), ['L-1', 'L-2', 'L-3', 'L-4'])
  assert.deepEqual(Object.keys(CONFIG_FIXTURES), ['C-default', 'C-eur', 'C-invalid', 'C-custom-price', 'C-local-energy'])
})

test('the costs scenario has an API, a subscription, a Copilot, a local-model and a Fable session', () => {
  const { claude, hermes } = loadScenario('costs')
  const models = claude.flatMap(f => f.calls.map(c => c.model))
  assert.ok(claude.some(f => f.billing === 'api' && f.calls.some(c => c.model.startsWith('claude-sonnet'))), 'Claude API session')
  assert.ok(models.some(m => m.includes('fable')), 'Fable session')
  const providers = hermes.flatMap(f => f.calls.map(c => c.provider))
  assert.ok(providers.includes('claude-subscription-directsdk-experimental'), 'subscription session')
  assert.ok(providers.includes('copilot'), 'Copilot session')
  assert.ok(providers.includes('ollama'), 'local-model session')
  assert.throws(() => loadScenario('nope'), /unknown scenario/)
  for (const sc of Object.values(SCENARIOS)) assert.doesNotThrow(() => { for (const id of [...sc.claude, ...sc.hermes]) assert.ok(FIXTURE_IDS.includes(id)) })
})

test('fixtures are synthetic: no tokens, keys, e-mail addresses or home paths', () => {
  const blob = JSON.stringify([CLAUDE_SESSIONS, HERMES_SESSIONS, LIMITS_FIXTURES, CONFIG_FIXTURES])
  const bad = [/sk-[A-Za-z0-9]{16,}/, /ghp_[A-Za-z0-9]{16,}/, /gho_[A-Za-z0-9]{16,}/, /Bearer\s+[A-Za-z0-9._-]{16,}/i, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, /\/home\/[a-z]/, /api[_-]?key/i, /password/i]
  for (const re of bad) assert.doesNotMatch(blob, re, `fixture text matches ${re}`)
})

test('claude transcript lines parse and carry usage, except in the no-usage fixture', () => {
  const now = Date.UTC(2026, 10, 25, 9, 0, 0)
  const a = claudeTranscriptLines(CLAUDE_SESSIONS.find(f => f.id === 'F-A')!, '/tmp/ws', now).map(l => JSON.parse(l))
  const assistants = a.filter(l => l.type === 'assistant')
  assert.equal(assistants.length, 3)
  assert.equal(assistants[0].message.usage.cache_creation_input_tokens, 18_000)
  assert.equal(assistants[1].message.usage.cache_read_input_tokens, 18_000)
  assert.equal(a[0].type, 'user')
  const h = claudeTranscriptLines(CLAUDE_SESSIONS.find(f => f.id === 'F-H')!, '/tmp/ws', now).map(l => JSON.parse(l))
  assert.ok(h.filter(l => l.type === 'assistant').every(l => l.message.usage === undefined))
})

test('hermes log lines use the format the watcher parses', () => {
  const f = HERMES_SESSIONS.find(s => s.id === 'F-E')!
  const lines = hermesLiveLines(f, Date.UTC(2026, 10, 25, 9, 0, 0))
  const api = lines.filter(l => l.includes('API call #'))
  assert.equal(api.length, 3)
  assert.match(api[0], /\[20261125_090100_e0e0e0e5\] agent\.conversation_loop: API call #1: model=claude-haiku-5\.5 provider=copilot in=14000 out=420 total=14420 latency=3\.1s id=fixture$/)
  assert.match(api[1], /cache=24000\/30000 \(80%\)/)
  assert.ok(lines.some(l => /agent\.tool_executor: tool search_files completed/.test(l)))
})

test('materializeFixtures writes transcripts, profile folders and state.db into the given HOME only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-test-'))
  try {
    const home = path.join(tmp, 'home'); const workspace = path.join(tmp, 'ws')
    const m = materializeFixtures({ home, workspace, scenario: 'costs', limits: 'L-2', config: 'C-eur' })
    assert.equal(m.claudeFiles.length, 2)
    for (const f of m.claudeFiles) {
      assert.ok(f.startsWith(path.join(home, '.claude', 'projects', encodeProjectDir(workspace))))
      assert.ok(fs.statSync(f).size > 0)
    }
    assert.equal(m.hermesLogFiles.length, 3)
    for (const f of m.hermesLogFiles) assert.equal(fs.readFileSync(f, 'utf8'), '', 'agent.log starts empty (usage is appended after the watcher attaches)')
    assert.ok(fs.existsSync(path.join(m.hermesRoot, 'profiles', 'copilot-demo', 'state.db')))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.agent-flow', 'limits', 'claude.json'), 'utf8')).five_hour, { used_percentage: 37 })
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.agent-flow', 'costs.json'), 'utf8')).currency.display, 'EUR')
    const n = appendHermesLines(m, 'costs')
    assert.equal(n, 14)
    assert.match(fs.readFileSync(m.hermesLogFiles[1], 'utf8'), /provider=/)
    assert.throws(() => materializeFixtures({ home, workspace, scenario: 'costs', limits: 'L-9' }), /unknown limits fixture/)
    assert.throws(() => materializeFixtures({ home, workspace, scenario: 'costs', config: 'C-9' }), /unknown config fixture/)
    // C-default and L-4 mean "no file"
    const home2 = path.join(tmp, 'home2')
    materializeFixtures({ home: home2, workspace, scenario: 'claude', limits: 'L-4', config: 'C-default' })
    assert.equal(fs.existsSync(path.join(home2, '.agent-flow')), false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ─── Hot-reload step (costs P3 screenshots 03/04) ───────────────────────────

test('the config step is a valid plan step and the hotreload plan rewrites to C-eur after the overlay is on', () => {
  assert.doesNotThrow(() => validatePlan({ shots: [{ name: 'a', steps: [{ config: 'C-eur' }] }] }))
  assert.throws(() => validatePlan({ shots: [{ name: 'a', steps: [{ config: '' }] }] }), ArgError)
  const jobs = expandPlan(BUILTIN_PLANS.hotreload, ['desktop', 'phone'], 3)
  assert.deepEqual(jobs.map(j => j.file), ['03-hot-reload-before-usd-desktop.png', '04-hot-reload-after-eur-desktop.png'])
  const steps = BUILTIN_PLANS.hotreload.shots[1].steps!
  const iKey = steps.findIndex(s => 'key' in s); const iCfg = steps.findIndex(s => 'config' in s)
  assert.ok(iKey >= 0 && iCfg > iKey, 'the overlay is turned on (USD) before costs.json is rewritten')
  assert.deepEqual(steps[iCfg], { config: 'C-eur' })
  assert.ok(!(BUILTIN_PLANS.hotreload.shots[0].steps ?? []).some(s => 'config' in s), 'the "before" shot never rewrites the file')
})

test('rewriteConfigFixture replaces costs.json atomically, removes it for C-default, and refuses unknown names', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-cfg-'))
  try {
    const file = path.join(home, '.agent-flow', 'costs.json')
    rewriteConfigFixture(home, 'C-eur')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).currency.display, 'EUR')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    rewriteConfigFixture(home, 'C-custom-price')
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).pricing)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['costs.json'], 'no temp file left behind')
    rewriteConfigFixture(home, 'C-default')
    assert.equal(fs.existsSync(file), false)
    assert.throws(() => rewriteConfigFixture(home, 'C-9'), /unknown config fixture/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
