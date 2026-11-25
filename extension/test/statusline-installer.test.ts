/**
 * PLAN v2 section 8 (P6a-A1..A8): the statusLine installer. Every test runs against a temp HOME and temp managed-settings
 * paths; the real ~/.claude/settings.json is never read or written.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  deepEqual, defaultManagedSettingsPaths, inspectStatusLine, installStatusLine, isWrapperCommand, paths, uninstallStatusLine, wrapperCommand,
  type InstallerEnv,
} from '../src/statusline-installer'
import { getShimScriptContent, STATUSLINE_SHIM_MARKER } from '../src/statusline-shim'

const temps: string[] = []
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function mk(): { home: string; env: InstallerEnv; p: ReturnType<typeof paths>; managed: string; ws: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sl-'))
  temps.push(root)
  const home = path.join(root, 'home')
  const ws = path.join(root, 'ws')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(ws, { recursive: true })
  const managed = path.join(root, 'managed-settings.json')
  const env: InstallerEnv = { home, nodePath: process.execPath, managedSettingsPaths: [managed], workspaceDirs: [ws], claudeConfigDir: path.join(home, '.claude') }
  return { home, env, p: paths(home), managed, ws }
}

function writeSettings(p: ReturnType<typeof paths>, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(p.settings), { recursive: true })
  fs.writeFileSync(p.settings, text, { mode })
  fs.chmodSync(p.settings, mode)
}
const read = (f: string) => fs.readFileSync(f, 'utf-8')
const mode = (f: string) => fs.statSync(f).mode & 0o777
const ours = (home: string) => [paths(home).shim, paths(home).record, paths(home).backup, paths(home).limitsDir, path.join(home, '.agent-flow')]

const HOOKS = { SessionStart: [{ hooks: [{ type: 'command', command: '"node" "/h/.claude/agent-flow/hook.js"', timeout: 5 }] }] }

describe('statusLine installer: install', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  it('(a) no statusLine: installs a tee-only wrapper, keeps every other key, its order and the file mode', () => {
    const t = mk()
    const original = JSON.stringify({ model: 'opus', hooks: HOOKS, permissions: { allow: ['Bash(ls)'] }, env: { A: '1' } }, null, 2) + '\n'
    writeSettings(t.p, original, 0o640)

    const r = installStatusLine(t.env)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.action, 'installed')

    const after = JSON.parse(read(t.p.settings))
    assert.deepEqual(Object.keys(after), ['model', 'hooks', 'permissions', 'env', 'statusLine'], 'other keys keep their order, statusLine is last')
    assert.deepEqual(after.hooks, HOOKS, 'hooks untouched')
    assert.deepEqual(after.statusLine, { type: 'command', command: wrapperCommand(t.env) })
    assert.ok(isWrapperCommand(after.statusLine.command))
    assert.equal(mode(t.p.settings), 0o640, 'file mode kept')
    // backup: exact copy, 0600
    assert.equal(read(t.p.backup), original)
    assert.equal(mode(t.p.backup), 0o600)
    // record: no original, 0600
    const rec = JSON.parse(read(t.p.record))
    assert.equal(rec.hadStatusLine, false)
    assert.equal('original' in rec, false)
    assert.equal(mode(t.p.record), 0o600)
    // shim: executable, exact content
    assert.equal(read(t.p.shim), getShimScriptContent())
    assert.equal(mode(t.p.shim) & 0o100, 0o100)
    // the command names the absolute node and the shim in this HOME
    assert.equal(after.statusLine.command, `"${process.execPath}" "${t.home}/.claude/agent-flow/statusline-shim.js"`)
    assert.ok(after.statusLine.command.includes(STATUSLINE_SHIM_MARKER))
  })

  it('(b) command statusLine: the original is stored verbatim and every extra field survives in the wrapper entry', () => {
    const t = mk()
    const orig = { type: 'command', command: 'echo "$(date +%H:%M) | ~/bin/mystatus --fancy"', padding: 2, refreshInterval: 30, futureKey: { nested: [1, 2, { x: null }] } }
    writeSettings(t.p, JSON.stringify({ a: 1, statusLine: orig, z: 2 }, null, 2) + '\n')

    const r = installStatusLine(t.env)
    assert.equal(r.ok, true)
    const after = JSON.parse(read(t.p.settings))
    assert.deepEqual(Object.keys(after), ['a', 'statusLine', 'z'], 'statusLine keeps its position')
    assert.equal(after.statusLine.padding, 2)
    assert.equal(after.statusLine.refreshInterval, 30)
    assert.deepEqual(after.statusLine.futureKey, orig.futureKey)
    assert.equal(after.statusLine.command, wrapperCommand(t.env))
    const rec = JSON.parse(read(t.p.record))
    assert.equal(rec.hadStatusLine, true)
    assert.deepEqual(rec.original, orig, 'stored verbatim, deep equal')
  })

  it('(e) already wrapped: no-op, settings.json is byte-identical and the backup is not rewritten', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }, null, 2) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    const bytes = read(t.p.settings)
    const bak = fs.statSync(t.p.backup).mtimeMs
    const again = installStatusLine(t.env)
    assert.equal(again.ok && again.action, 'already-installed')
    assert.equal(read(t.p.settings), bytes)
    assert.equal(fs.statSync(t.p.backup).mtimeMs, bak)
    // and the original was NOT replaced by the wrapper (no double wrap)
    assert.equal(JSON.parse(read(t.p.record)).original.command, 'echo hi')
    assert.equal(inspectStatusLine(t.env).state, 'installed')
  })

  it('keeps the indentation and trailing newline style of the file', () => {
    for (const [name, indent, nl] of [['tab', '\t', true], ['four spaces', '    ', false], ['two spaces no newline', '  ', false]] as const) {
      const t = mk()
      const raw = JSON.stringify({ model: 'x' }, null, indent) + (nl ? '\n' : '')
      writeSettings(t.p, raw)
      assert.equal(installStatusLine(t.env).ok, true, name)
      const after = read(t.p.settings)
      assert.equal(after.endsWith('\n'), nl, name)
      assert.ok(after.includes(`\n${indent}"model"`), name)
      assert.equal(uninstallStatusLine(t.env).ok, true, name)
      assert.equal(read(t.p.settings), raw, `${name}: uninstall gives the original bytes back`)
    }
  })

  it('no settings.json yet: creates one with 0600, uninstall removes it again', () => {
    const t = mk()
    assert.equal(installStatusLine(t.env).ok, true)
    assert.equal(mode(t.p.settings), 0o600)
    assert.equal(fs.existsSync(t.p.backup), false, 'nothing to back up')
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'uninstalled')
    assert.equal(fs.existsSync(t.p.settings), false)
  })

  it('(3) a project statusLine shadows the user scope: reported, not refused', () => {
    const t = mk()
    fs.mkdirSync(path.join(t.ws, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(t.ws, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }))
    const r = installStatusLine(t.env)
    assert.equal(r.ok, true)
    assert.deepEqual(r.ok && r.shadowedBy, [path.join(t.ws, '.claude', 'settings.local.json')])
    assert.match(r.ok ? r.message : '', /may not be observed in projects/)
  })

  it('warns when CLAUDE_CONFIG_DIR points elsewhere (Claude Code would not read ~/.claude)', () => {
    const t = mk()
    const r = installStatusLine({ ...t.env, claudeConfigDir: path.join(t.home, 'elsewhere') })
    assert.equal(r.ok, true)
    assert.match((r.ok && r.warnings?.[0]) || '', /CLAUDE_CONFIG_DIR/)
  })
})

describe('statusLine installer: refusals change nothing', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const cases: [string, string, string][] = [
    ['statusLine is a string', JSON.stringify({ statusLine: 'echo hi' }), 'statusline-not-object'],
    ['statusLine is null', JSON.stringify({ statusLine: null }), 'statusline-not-object'],
    ['statusLine is an array', JSON.stringify({ statusLine: [] }), 'statusline-not-object'],
    ['type is not command', JSON.stringify({ statusLine: { type: 'static', text: 'hello' } }), 'statusline-not-command'],
    ['type missing', JSON.stringify({ statusLine: { command: 'echo' } }), 'statusline-not-command'],
    ['command empty', JSON.stringify({ statusLine: { type: 'command', command: '   ' } }), 'statusline-command-unusable'],
    ['command not text', JSON.stringify({ statusLine: { type: 'command', command: ['echo'] } }), 'statusline-command-unusable'],
    ['command contains NUL', JSON.stringify({ statusLine: { type: 'command', command: 'echo \u0000 x' } }), 'statusline-command-unusable'],
    ['command absurdly long', JSON.stringify({ statusLine: { type: 'command', command: 'x'.repeat(20_000) } }), 'statusline-command-unusable'],
    ['settings is not JSON', '{ "statusLine": { "type": "command", ', 'settings-invalid'],
    ['settings is an array', '[]', 'settings-invalid'],
  ]
  for (const [name, text, code] of cases) {
    it(`refuses: ${name}`, () => {
      const t = mk()
      writeSettings(t.p, text)
      const before = read(t.p.settings)
      const r = installStatusLine(t.env)
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.code, code)
      assert.match(!r.ok ? r.message : '', /nothing was changed|Not installed|valid JSON|not a JSON object/)
      assert.equal(read(t.p.settings), before, 'settings.json byte-identical')
      for (const f of ours(t.home)) assert.equal(fs.existsSync(f), false, `${path.basename(f)} must not exist`)
      const insp = inspectStatusLine(t.env)
      assert.equal(insp.state, 'refused')
      assert.equal(insp.canInstall, false)
      assert.equal(insp.code, code)
    })
  }

  it('(d) refuses when a managed settings file sets a statusLine', () => {
    const t = mk()
    fs.writeFileSync(t.managed, JSON.stringify({ statusLine: { type: 'command', command: 'corp-status' } }))
    writeSettings(t.p, JSON.stringify({ model: 'x' }))
    const before = read(t.p.settings)
    const r = installStatusLine(t.env)
    assert.equal(!r.ok && r.code, 'managed-statusline')
    assert.equal(read(t.p.settings), before)
    for (const f of ours(t.home)) assert.equal(fs.existsSync(f), false)
  })

  it('a managed file that exists but cannot be read is not guessed about: refuse', () => {
    const t = mk()
    fs.mkdirSync(t.managed) // a directory where a file is expected: EISDIR
    const r = installStatusLine(t.env)
    assert.equal(!r.ok && r.code, 'managed-unreadable')
  })

  it('a managed file without a statusLine does not block', () => {
    const t = mk()
    fs.writeFileSync(t.managed, JSON.stringify({ permissions: { deny: [] } }))
    assert.equal(installStatusLine(t.env).ok, true)
  })

  it('refuses without an absolute, executable node', () => {
    const t = mk()
    for (const nodePath of ['node', '', path.join(t.home, 'no-such-node')]) {
      const r = installStatusLine({ ...t.env, nodePath })
      assert.equal(!r.ok && r.code, 'node-unavailable', JSON.stringify(nodePath))
    }
    assert.equal(fs.existsSync(t.p.settings), false)
    assert.equal(fs.existsSync(path.join(t.home, '.agent-flow')), false)
  })

  it('refuses a path that cannot be quoted safely', () => {
    const t = mk()
    const r = installStatusLine({ ...t.env, home: t.home + '/we"ird' })
    assert.equal(!r.ok, true)
  })

  it('rolls back what it created when settings.json cannot be written', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ model: 'x' }))
    // Make the final rename fail: settings.json is a directory entry we cannot replace -> use a read-only claude dir
    fs.chmodSync(path.dirname(t.p.settings), 0o500)
    try {
      if (process.getuid && process.getuid() === 0) return // root ignores directory permissions
      const r = installStatusLine(t.env)
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.code, 'io-error')
      assert.equal(JSON.parse(read(t.p.settings)).statusLine, undefined)
    } finally {
      fs.chmodSync(path.dirname(t.p.settings), 0o700)
    }
  })
})

describe('statusLine installer: uninstall', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  it('(6) restores the original object exactly (deep equal) and removes only Agent Flow files', () => {
    const t = mk()
    const orig = { type: 'command', command: 'echo "x|y"', padding: 1, extra: { a: [1, 2] } }
    const raw = JSON.stringify({ hooks: HOOKS, statusLine: orig, model: 'm' }, null, 2) + '\n'
    writeSettings(t.p, raw)
    // a neighbour of ours that must survive: the hook script lives in the same directory
    fs.mkdirSync(path.dirname(t.p.shim), { recursive: true })
    const hookJs = path.join(path.dirname(t.p.shim), 'hook.js')
    fs.writeFileSync(hookJs, '// hook')
    fs.mkdirSync(t.p.limitsDir, { recursive: true })
    fs.writeFileSync(path.join(t.home, '.agent-flow', 'costs.json'), '{"schemaVersion":1}')

    assert.equal(installStatusLine(t.env).ok, true)
    fs.writeFileSync(t.p.limits, '{"v":1}')
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'uninstalled')

    assert.equal(read(t.p.settings), raw, 'byte-identical to the original file')
    assert.ok(deepEqual(JSON.parse(read(t.p.settings)).statusLine, orig))
    for (const f of [t.p.shim, t.p.record, t.p.limits, t.p.backup]) assert.equal(fs.existsSync(f), false, path.basename(f))
    assert.equal(fs.existsSync(hookJs), true, 'hook.js untouched')
    assert.equal(read(path.join(t.home, '.agent-flow', 'costs.json')), '{"schemaVersion":1}', 'costs.json untouched')
  })

  it('removes the statusLine key when there was none', () => {
    const t = mk()
    const raw = JSON.stringify({ model: 'm' }, null, 2) + '\n'
    writeSettings(t.p, raw)
    installStatusLine(t.env)
    uninstallStatusLine(t.env)
    assert.equal(read(t.p.settings), raw)
  })

  it('(6) leaves a statusLine the user changed after the install alone, and says so', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ statusLine: { type: 'command', command: 'old' } }, null, 2) + '\n')
    installStatusLine(t.env)
    const replaced = JSON.stringify({ statusLine: { type: 'command', command: 'my-new-status' } }, null, 2) + '\n'
    fs.writeFileSync(t.p.settings, replaced)
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'left-alone')
    assert.match(u.ok ? u.message : '', /no longer points to Agent Flow/)
    assert.equal(read(t.p.settings), replaced, 'untouched')
    assert.equal(fs.existsSync(t.p.shim), false, 'our files are removed')
  })

  it('refuses when our wrapper entry was edited (extra field changed) and changes nothing', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ statusLine: { type: 'command', command: 'old', padding: 0 } }, null, 2) + '\n')
    installStatusLine(t.env)
    const s = JSON.parse(read(t.p.settings)); s.statusLine.padding = 5
    fs.writeFileSync(t.p.settings, JSON.stringify(s, null, 2) + '\n')
    const before = read(t.p.settings)
    const u = uninstallStatusLine(t.env)
    assert.equal(!u.ok && u.code, 'modified-after-install')
    assert.equal(read(t.p.settings), before)
    assert.equal(fs.existsSync(t.p.shim), true, 'the wrapper keeps working')
    assert.equal(fs.existsSync(t.p.record), true)
  })

  it('refuses when the saved original is gone; the status line stays wrapped and working', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ statusLine: { type: 'command', command: 'old' } }, null, 2) + '\n')
    installStatusLine(t.env)
    fs.rmSync(t.p.record)
    const before = read(t.p.settings)
    assert.equal(inspectStatusLine(t.env).state, 'broken')
    const u = uninstallStatusLine(t.env)
    assert.equal(!u.ok && u.code, 'record-missing')
    assert.equal(read(t.p.settings), before)
    assert.equal(fs.existsSync(t.p.shim), true)
  })

  it('nothing to remove when nothing is installed', () => {
    const t = mk()
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'nothing-to-remove')
  })

  it('a damaged settings.json is never rewritten by uninstall either', () => {
    const t = mk()
    writeSettings(t.p, '{ nope')
    const u = uninstallStatusLine(t.env)
    assert.equal(!u.ok && u.code, 'settings-invalid')
    assert.equal(read(t.p.settings), '{ nope')
  })

  it('install then uninstall then install again works (state is fully reset)', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ statusLine: { type: 'command', command: 'a' } }, null, 2) + '\n')
    for (let i = 0; i < 3; i++) {
      assert.equal(installStatusLine(t.env).ok, true)
      assert.equal(uninstallStatusLine(t.env).ok, true)
    }
    assert.deepEqual(JSON.parse(read(t.p.settings)), { statusLine: { type: 'command', command: 'a' } })
  })
})

describe('statusLine installer: helpers', () => {
  it('deepEqual ignores key order, compares arrays in order, and tells types apart', () => {
    assert.equal(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true)
    assert.equal(deepEqual([1, 2], [2, 1]), false)
    assert.equal(deepEqual({ a: 1 }, { a: '1' }), false)
    assert.equal(deepEqual({ a: null }, { a: undefined }), false)
    assert.equal(deepEqual([], {}), false)
  })

  it('isWrapperCommand matches the marker with either slash style and nothing else', () => {
    assert.equal(isWrapperCommand('"node" "/h/.claude/agent-flow/statusline-shim.js"'), true)
    assert.equal(isWrapperCommand('"node" "C:\\Users\\a\\.claude\\agent-flow\\statusline-shim.js"'), true)
    assert.equal(isWrapperCommand('"node" "/h/.claude/agent-flow/hook.js"'), false)
    assert.equal(isWrapperCommand(undefined), false)
  })

  it('default managed paths are per-OS absolute paths', () => {
    assert.match(defaultManagedSettingsPaths('linux')[0], /^\/etc\/claude-code\/managed-settings\.json$/)
    assert.match(defaultManagedSettingsPaths('darwin')[0], /ClaudeCode\/managed-settings\.json$/)
    assert.match(defaultManagedSettingsPaths('win32')[0], /ClaudeCode\\managed-settings\.json$/)
  })
})
