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
  deepEqual, defaultManagedSettingsPaths, inspectStatusLine, installStatusLine, isLegacyWrapperCommand, isWrapperCommand, legacyWrapperCommand, paths, uninstallStatusLine, wrapperCommand,
  type InstallerEnv,
} from '../src/statusline-installer'
import { getShimScriptContent, STATUSLINE_SHIM_MARKER } from '../src/statusline-shim'
import { getLauncherScriptContent, STATUSLINE_LAUNCHER_MARKER } from '../src/statusline-launcher'

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
const ours = (home: string) => [paths(home).shim, paths(home).launcher, paths(home).nodePath, paths(home).record, paths(home).backup, paths(home).limitsDir, path.join(home, '.agent-flow')]

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
    // N1: the command names the launcher in this HOME, not a node binary; the launcher finds node itself
    assert.equal(after.statusLine.command, `sh "${t.home}/.claude/agent-flow/statusline-run.sh"`)
    assert.ok(after.statusLine.command.includes(STATUSLINE_LAUNCHER_MARKER))
    assert.equal(after.statusLine.command.includes(process.execPath), false, 'no fixed node path in settings.json')
    assert.equal(read(t.p.launcher), getLauncherScriptContent())
    assert.equal(mode(t.p.launcher), 0o755)
    // the install-time node is recorded for the launcher (0600)
    assert.equal(read(t.p.nodePath), process.execPath + '\n')
    assert.equal(mode(t.p.nodePath), 0o600)
  })

  it('Windows keeps the absolute-node command: no launcher, no node-path, and the round trip still works', () => {
    const t = mk()
    const env = { ...t.env, platform: 'win32' as const }
    writeSettings(t.p, JSON.stringify({ model: 'm' }, null, 2) + '\n')
    assert.equal(installStatusLine(env).ok, true)
    const cmd = JSON.parse(read(t.p.settings)).statusLine.command
    assert.equal(cmd, `"${process.execPath}" "${t.home}/.claude/agent-flow/statusline-shim.js"`)
    assert.equal(cmd, legacyWrapperCommand(env))
    assert.equal(fs.existsSync(t.p.launcher), false)
    assert.equal(fs.existsSync(t.p.nodePath), false)
    const insp = inspectStatusLine(env)
    assert.equal(insp.state, 'installed')
    assert.equal(insp.legacy, false, 'on Windows this is the normal form, not a legacy one')
    const again = installStatusLine(env)
    assert.equal(again.ok && again.action, 'already-installed')
    assert.equal(fs.existsSync(t.p.launcher), false)
    assert.equal(uninstallStatusLine(env).ok, true)
    assert.equal(read(t.p.settings), JSON.stringify({ model: 'm' }, null, 2) + '\n')
  })

  it('works with a HOME that contains spaces: the command is quoted, the round trip is exact', () => {
    const t = mk()
    const home = path.join(path.dirname(t.home), 'my home dir')
    fs.mkdirSync(home)
    const env = { ...t.env, home }
    const p = paths(home)
    const raw = JSON.stringify({ statusLine: { type: 'command', command: 'echo "a b"' } }, null, 2) + '\n'
    writeSettings(p, raw)
    assert.equal(installStatusLine(env).ok, true)
    assert.equal(JSON.parse(read(p.settings)).statusLine.command, `sh "${home}/.claude/agent-flow/statusline-run.sh"`)
    assert.equal(uninstallStatusLine(env).ok, true)
    assert.equal(read(p.settings), raw)
  })

  it('refuses a HOME the POSIX shell would expand inside the double quotes ($, backtick, backslash)', () => {
    for (const ch of ['$', '`', '\\']) {
      const t = mk()
      const r = installStatusLine({ ...t.env, home: `${t.home}/we${ch}ird` })
      assert.equal(!r.ok && r.code, 'path-unsafe', ch)
    }
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

describe('statusLine installer: symlinked settings.json and limits history (R2 M1, L1)', { skip: process.platform === 'win32' && 'POSIX symlinks and modes' }, () => {
  /** $home/dotfiles/settings.json is the real file; $home/.claude/settings.json -> ../dotfiles/settings.json. */
  function linked(text: string, fileMode = 0o640) {
    const t = mk()
    const target = path.join(t.home, 'dotfiles', 'settings.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, { mode: fileMode }); fs.chmodSync(target, fileMode)
    fs.mkdirSync(path.dirname(t.p.settings), { recursive: true })
    fs.symlinkSync(path.join('..', 'dotfiles', 'settings.json'), t.p.settings)
    return { ...t, target }
  }
  const isLink = (f: string) => fs.lstatSync(f).isSymbolicLink()

  it('install writes through the link: it stays a link, the dotfiles target holds the wrapper, the mode is kept', () => {
    const orig = { type: 'command', command: 'echo \"x|y\"', padding: 1 }
    const raw = JSON.stringify({ hooks: HOOKS, statusLine: orig, model: 'm' }, null, 2) + '\n'
    const t = linked(raw)
    const r = installStatusLine(t.env)
    assert.equal(r.ok && r.action, 'installed')
    assert.equal(isLink(t.p.settings), true, 'still a symlink')
    assert.equal(fs.readlinkSync(t.p.settings), path.join('..', 'dotfiles', 'settings.json'))
    assert.equal(fs.lstatSync(t.target).isSymbolicLink(), false)
    const after = JSON.parse(read(t.target))
    assert.equal(isWrapperCommand(after.statusLine.command), true, 'the target holds the wrapper')
    assert.equal(mode(t.target), 0o640)
    assert.equal(read(t.p.backup), raw, 'backup is the byte-identical original')
    assert.deepEqual(fs.readdirSync(path.dirname(t.target)), ['settings.json'], 'no tmp file left next to the target')
  })

  it('uninstall writes through too: link intact, target content deep-equal to the original', () => {
    const orig = { type: 'command', command: 'echo \"x|y\"', padding: 1, extra: { a: [1, 2] } }
    const original = { hooks: HOOKS, statusLine: orig, model: 'm' }
    const t = linked(JSON.stringify(original, null, 2) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'uninstalled')
    assert.equal(isLink(t.p.settings), true, 'still a symlink after uninstall')
    assert.ok(deepEqual(JSON.parse(read(t.target)), original), 'round-trips deep-equal')
    assert.equal(mode(t.target), 0o640)
    for (const f of [t.p.shim, t.p.record, t.p.backup]) assert.equal(fs.existsSync(f), false, path.basename(f))
  })

  it('a link without a statusLine round-trips too (key removed again)', () => {
    const original = { model: 'm', env: { A: '1' } }
    const t = linked(JSON.stringify(original) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    assert.equal(isLink(t.p.settings), true)
    assert.equal(uninstallStatusLine(t.env).ok, true)
    assert.equal(isLink(t.p.settings), true)
    assert.ok(deepEqual(JSON.parse(read(t.target)), original))
  })

  it('a dangling link is refused and nothing changes (the link is not replaced)', () => {
    const t = mk()
    fs.mkdirSync(path.dirname(t.p.settings), { recursive: true })
    fs.symlinkSync(path.join('..', 'dotfiles', 'missing.json'), t.p.settings)
    const r = installStatusLine(t.env)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'settings-unreadable')
    assert.equal(isLink(t.p.settings), true)
    assert.equal(fs.existsSync(path.join(t.home, 'dotfiles')), false)
    for (const f of ours(t.home).slice(0, 3)) assert.equal(fs.existsSync(f), false, path.basename(f))
  })

  it('a link loop is refused', () => {
    const t = mk()
    fs.mkdirSync(path.dirname(t.p.settings), { recursive: true })
    fs.symlinkSync('settings.json', t.p.settings)
    const r = installStatusLine(t.env)
    assert.equal(r.ok, false)
    assert.equal(isLink(t.p.settings), true)
  })

  it('(L1) uninstall deletes the limits history file too, and the limits directory goes with it', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ model: 'm' }) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    fs.mkdirSync(t.p.limitsDir, { recursive: true })
    fs.writeFileSync(t.p.limits, '{\"v\":1}'); fs.writeFileSync(t.p.limitsHistory, '{\"v\":1,\"readings\":[]}')
    assert.equal(uninstallStatusLine(t.env).ok, true)
    assert.equal(fs.existsSync(t.p.limitsHistory), false, 'claude-history.json is gone')
    assert.equal(fs.existsSync(t.p.limits), false)
    assert.equal(fs.existsSync(t.p.limitsDir), false, 'the limits directory could be removed')
  })

  it('(L1) the history is also removed when the statusLine no longer points to Agent Flow (left-alone path)', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ model: 'm' }) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    fs.mkdirSync(t.p.limitsDir, { recursive: true })
    fs.writeFileSync(t.p.limitsHistory, '{\"v\":1,\"readings\":[]}')
    fs.writeFileSync(t.p.settings, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'left-alone')
    assert.equal(fs.existsSync(t.p.limitsHistory), false)
  })
})

describe('statusLine installer: launcher, legacy command, repair (N1)', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  /** A legacy install = what the installer wrote before N1: `"<node>" "<shim>"`. The win32 form is exactly that command. */
  function legacyInstall(original: unknown, fileMode = 0o640) {
    const t = mk()
    const raw = JSON.stringify({ model: 'opus', hooks: HOOKS, ...(original === undefined ? {} : { statusLine: original }), env: { A: '1' } }, null, 2) + '\n'
    writeSettings(t.p, raw, fileMode)
    assert.equal(installStatusLine({ ...t.env, platform: 'win32' }).ok, true)
    return { ...t, raw }
  }
  const orig = { type: 'command', command: 'echo "a|b"', padding: 2, refreshInterval: 30, extra: { n: [1, { x: null }] } }

  it('the old command form is detected as installed, legacy, upgradable', () => {
    const t = legacyInstall(orig)
    const cmd = JSON.parse(read(t.p.settings)).statusLine.command
    assert.equal(cmd, legacyWrapperCommand(t.env))
    assert.equal(isLegacyWrapperCommand(cmd), true)
    assert.equal(isLegacyWrapperCommand(wrapperCommand(t.env)), false)
    assert.equal(isWrapperCommand(cmd), true, 'still recognised as ours')
    const insp = inspectStatusLine(t.env)
    assert.equal(insp.state, 'installed')
    assert.equal(insp.legacy, true)
    assert.equal(insp.canUpgrade, true)
    assert.equal(insp.label, 'installed (legacy command)')
    assert.equal(insp.canInstall, false)
    assert.equal(inspectStatusLine({ ...t.env, platform: 'win32' }).label, 'installed')
  })

  it('installing again upgrades in place: only the command (and the record copy of it) changes; original, backup, mode, key order stay', () => {
    const t = legacyInstall(orig)
    const recBefore = JSON.parse(read(t.p.record))
    const backupBefore = read(t.p.backup)
    assert.equal(backupBefore, t.raw)
    const bakMtime = fs.statSync(t.p.backup).mtimeMs

    const r = installStatusLine(t.env)
    assert.equal(r.ok && r.action, 'upgraded')

    const after = JSON.parse(read(t.p.settings))
    assert.deepEqual(Object.keys(after), ['model', 'hooks', 'statusLine', 'env'])
    assert.deepEqual(after.statusLine, { ...orig, command: wrapperCommand(t.env) }, 'every other statusLine field is kept')
    assert.deepEqual(after.hooks, HOOKS)
    assert.equal(mode(t.p.settings), 0o640)
    // the saved original survives untouched; only `installed` follows the new command
    const rec = JSON.parse(read(t.p.record))
    assert.deepEqual(rec.original, orig)
    assert.equal(rec.hadStatusLine, true)
    assert.equal(rec.installedAt, recBefore.installedAt)
    assert.equal(typeof rec.upgradedAt, 'string')
    assert.deepEqual(rec.installed, after.statusLine)
    assert.equal(mode(t.p.record), 0o600)
    // the backup is still the pristine pre-install file (not the legacy-wrapped one)
    assert.equal(read(t.p.backup), backupBefore)
    assert.equal(fs.statSync(t.p.backup).mtimeMs, bakMtime)
    // new files
    assert.equal(read(t.p.launcher), getLauncherScriptContent()); assert.equal(mode(t.p.launcher), 0o755)
    assert.equal(read(t.p.nodePath), process.execPath + '\n'); assert.equal(mode(t.p.nodePath), 0o600)
    // now a normal install
    const insp = inspectStatusLine(t.env)
    assert.equal(insp.state, 'installed'); assert.equal(insp.legacy, false); assert.equal(insp.label, 'installed')
    const again = installStatusLine(t.env)
    assert.equal(again.ok && again.action, 'already-installed')
  })

  it('upgrade then uninstall restores the original deep-equal (byte-identical file) and removes every file Agent Flow made', () => {
    const t = legacyInstall(orig)
    assert.equal(installStatusLine(t.env).ok && true, true)
    fs.mkdirSync(t.p.limitsDir, { recursive: true })
    fs.writeFileSync(t.p.limits, '{"v":1}'); fs.writeFileSync(t.p.nodeMissing, '{"v":1,"at":1}')
    const u = uninstallStatusLine(t.env)
    assert.equal(u.ok && u.action, 'uninstalled')
    assert.equal(read(t.p.settings), t.raw)
    assert.ok(deepEqual(JSON.parse(read(t.p.settings)).statusLine, orig))
    for (const f of [t.p.shim, t.p.launcher, t.p.nodePath, t.p.record, t.p.backup, t.p.limits, t.p.nodeMissing, t.p.limitsDir]) assert.equal(fs.existsSync(f), false, path.basename(f))
  })

  it('a legacy install without a user statusLine upgrades and uninstalls too (key removed again)', () => {
    const t = legacyInstall(undefined)
    assert.equal(inspectStatusLine(t.env).legacy, true)
    assert.equal(installStatusLine(t.env).ok && true, true)
    assert.deepEqual(JSON.parse(read(t.p.settings)).statusLine, { type: 'command', command: wrapperCommand(t.env) })
    assert.equal(uninstallStatusLine(t.env).ok, true)
    assert.equal(read(t.p.settings), t.raw)
  })

  it('an uninstall of a legacy install that was never upgraded still works and also removes launcher / node-path leftovers', () => {
    const t = legacyInstall(orig)
    fs.writeFileSync(t.p.launcher, '#!/bin/sh\n'); fs.writeFileSync(t.p.nodePath, '/x\n')
    assert.equal(uninstallStatusLine(t.env).ok, true)
    assert.equal(read(t.p.settings), t.raw)
    assert.equal(fs.existsSync(t.p.launcher), false); assert.equal(fs.existsSync(t.p.nodePath), false)
  })

  it('a statusLine edited after the install is NOT upgraded (nothing changes, uninstall still guards it)', () => {
    const t = legacyInstall(orig)
    const s = JSON.parse(read(t.p.settings)); s.statusLine.padding = 9
    fs.writeFileSync(t.p.settings, JSON.stringify(s, null, 2) + '\n')
    const before = read(t.p.settings); const recBefore = read(t.p.record)
    assert.equal(inspectStatusLine(t.env).canUpgrade, false)
    const r = installStatusLine(t.env)
    assert.equal(!r.ok && r.code, 'modified-after-install')
    assert.equal(read(t.p.settings), before); assert.equal(read(t.p.record), recBefore)
    assert.equal(fs.existsSync(t.p.launcher), false)
  })

  it('no usable node: the upgrade is refused and the working legacy install is left exactly as it was', () => {
    const t = legacyInstall(orig)
    const before = read(t.p.settings); const recBefore = read(t.p.record)
    const r = installStatusLine({ ...t.env, nodePath: path.join(t.home, 'no-such-node') })
    assert.equal(!r.ok && r.code, 'node-unavailable')
    assert.equal(read(t.p.settings), before); assert.equal(read(t.p.record), recBefore)
    assert.equal(fs.existsSync(t.p.launcher), false); assert.equal(fs.existsSync(t.p.nodePath), false)
  })

  it('a failed settings write during the upgrade rolls back: record restored, new files removed', () => {
    if (process.getuid && process.getuid() === 0) return // root ignores directory permissions
    const t = legacyInstall(orig)
    const before = read(t.p.settings); const recBefore = read(t.p.record)
    fs.chmodSync(path.dirname(t.p.settings), 0o500) // settings.json cannot be replaced; .claude/agent-flow stays writable
    try {
      const r = installStatusLine(t.env)
      assert.equal(!r.ok && r.code, 'io-error')
    } finally { fs.chmodSync(path.dirname(t.p.settings), 0o700) }
    assert.equal(read(t.p.settings), before)
    assert.equal(read(t.p.record), recBefore, 'the record matches settings.json again')
    assert.equal(fs.existsSync(t.p.launcher), false); assert.equal(fs.existsSync(t.p.nodePath), false)
    assert.equal(uninstallStatusLine(t.env).ok, true, 'uninstall still works afterwards')
  })

  it('a symlinked settings.json is upgraded through the link (stays a link, target changes, mode kept)', () => {
    const t = mk()
    const target = path.join(t.home, 'dotfiles', 'settings.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({ statusLine: orig, model: 'm' }, null, 2) + '\n', { mode: 0o640 }); fs.chmodSync(target, 0o640)
    fs.mkdirSync(path.dirname(t.p.settings), { recursive: true })
    fs.symlinkSync(path.join('..', 'dotfiles', 'settings.json'), t.p.settings)
    assert.equal(installStatusLine({ ...t.env, platform: 'win32' }).ok, true)
    assert.equal(inspectStatusLine(t.env).legacy, true)
    const r = installStatusLine(t.env)
    assert.equal(r.ok && r.action, 'upgraded')
    assert.equal(fs.lstatSync(t.p.settings).isSymbolicLink(), true)
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false)
    assert.equal(JSON.parse(read(target)).statusLine.command, wrapperCommand(t.env))
    assert.equal(mode(target), 0o640)
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['settings.json'], 'no temp file next to the target')
    assert.equal(uninstallStatusLine(t.env).ok, true)
    assert.equal(fs.lstatSync(t.p.settings).isSymbolicLink(), true)
    assert.ok(deepEqual(JSON.parse(read(target)), { statusLine: orig, model: 'm' }))
  })

  it('a deleted launcher is reported as broken and install repairs it; a node-path whose node is gone is re-recorded', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ model: 'm' }) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    fs.rmSync(t.p.launcher)
    const insp = inspectStatusLine(t.env)
    assert.equal(insp.state, 'broken'); assert.equal(insp.code, 'io-error')
    const settingsBefore = read(t.p.settings)
    const fixed = installStatusLine(t.env)
    assert.equal(fixed.ok && fixed.action, 'already-installed')
    assert.equal(read(t.p.launcher), getLauncherScriptContent())
    assert.equal(read(t.p.settings), settingsBefore, 'settings.json untouched by the repair')
    assert.equal(inspectStatusLine(t.env).state, 'installed')

    fs.writeFileSync(t.p.nodePath, path.join(t.home, 'old-node', 'bin', 'node') + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    assert.equal(read(t.p.nodePath), process.execPath + '\n', 'the stale record is replaced by the node that works now')
    // a record that still works is left alone
    const other = path.join(t.home, 'other-node'); fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(t.p.nodePath, other + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    assert.equal(read(t.p.nodePath), other + '\n')
  })

  it('install clears a stale node-missing marker (node is known again)', () => {
    const t = mk()
    writeSettings(t.p, '{}\n')
    assert.equal(installStatusLine(t.env).ok, true)
    fs.mkdirSync(t.p.limitsDir, { recursive: true }); fs.writeFileSync(t.p.nodeMissing, '{"v":1,"at":1}')
    fs.writeFileSync(t.p.nodePath, '/gone/node\n')
    assert.equal(installStatusLine(t.env).ok, true)
    assert.equal(fs.existsSync(t.p.nodeMissing), false)
  })

  it('uninstall (launcher install) removes launcher, node-path and node-missing marker; the left-alone path does too', () => {
    const t = mk()
    writeSettings(t.p, JSON.stringify({ statusLine: { type: 'command', command: 'old' } }, null, 2) + '\n')
    assert.equal(installStatusLine(t.env).ok, true)
    fs.mkdirSync(t.p.limitsDir, { recursive: true }); fs.writeFileSync(t.p.nodeMissing, '{"v":1,"at":1}')
    assert.equal(uninstallStatusLine(t.env).ok, true)
    for (const f of [t.p.launcher, t.p.nodePath, t.p.nodeMissing, t.p.limitsDir]) assert.equal(fs.existsSync(f), false, path.basename(f))

    const u = mk()
    writeSettings(u.p, JSON.stringify({ model: 'm' }) + '\n')
    assert.equal(installStatusLine(u.env).ok, true)
    fs.mkdirSync(u.p.limitsDir, { recursive: true }); fs.writeFileSync(u.p.nodeMissing, '{"v":1,"at":1}')
    fs.writeFileSync(u.p.settings, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    const left = uninstallStatusLine(u.env)
    assert.equal(left.ok && left.action, 'left-alone')
    for (const f of [u.p.launcher, u.p.nodePath, u.p.nodeMissing]) assert.equal(fs.existsSync(f), false, path.basename(f))
  })

  it('neighbours survive uninstall: hook.js and costs.json are not ours', () => {
    const t = mk()
    writeSettings(t.p, '{}\n')
    const hookJs = path.join(path.dirname(t.p.shim), 'hook.js')
    installStatusLine(t.env)
    fs.writeFileSync(hookJs, '// hook'); fs.writeFileSync(path.join(t.home, '.agent-flow', 'costs.json'), '{}')
    uninstallStatusLine(t.env)
    assert.equal(fs.existsSync(hookJs), true); assert.equal(fs.existsSync(path.join(t.home, '.agent-flow', 'costs.json')), true)
  })

  it('isWrapperCommand / isLegacyWrapperCommand: both forms, either slash style, nothing else', () => {
    assert.equal(isWrapperCommand('sh "/h/.claude/agent-flow/statusline-run.sh"'), true)
    assert.equal(isWrapperCommand('sh "C:\\Users\\a\\.claude\\agent-flow\\statusline-run.sh"'), true)
    assert.equal(isLegacyWrapperCommand('sh "/h/.claude/agent-flow/statusline-run.sh"'), false)
    assert.equal(isLegacyWrapperCommand('"/n/bin/node" "/h/.claude/agent-flow/statusline-shim.js"'), true)
    assert.equal(isLegacyWrapperCommand(undefined), false)
    assert.equal(isWrapperCommand('sh "/h/.claude/agent-flow/hook.js"'), false)
  })
})
