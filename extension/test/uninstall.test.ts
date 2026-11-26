/**
 * Runs the vscode:uninstall script against a sandboxed HOME and checks it
 * removes only Agent Flow's hooks.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = path.join(__dirname, '..', 'scripts', 'uninstall.js')

describe('uninstall script', { skip: process.platform === 'win32' && 'HOME override is POSIX-only' }, () => {
  it("removes Agent Flow hooks and keeps other tools' loopback hooks", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-uninstall-'))
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const foreign = { hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/9207692e/stop' }] }
    fs.mkdirSync(path.join(home, '.claude', 'agent-flow'), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [foreign, { hooks: [{ type: 'command', command: `"node" "${home}/.claude/agent-flow/hook.js"` }] }],
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }],
      },
    }))

    execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home } })

    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
      model: 'opus',
      hooks: { Stop: [foreign] },
    })
    assert.equal(fs.existsSync(path.join(home, '.claude', 'agent-flow')), false)
  })
})

describe('uninstall script: chained statusLine wrapper (P6a)', { skip: process.platform === 'win32' && 'HOME override is POSIX-only' }, () => {
  // Installs through the real installer into the sandbox HOME, then runs the real uninstall script.
  async function sandbox(original: unknown, extra: Record<string, unknown> = {}) {
    const { installStatusLine, paths } = await import('../src/statusline-installer')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-uninstall-sl-'))
    const p = paths(home)
    fs.mkdirSync(path.dirname(p.settings), { recursive: true })
    if (original !== undefined) fs.writeFileSync(p.settings, JSON.stringify({ model: 'opus', ...(original === null ? {} : { statusLine: original }), ...extra }, null, 2) + '\n')
    const r = installStatusLine({ home, nodePath: process.execPath, managedSettingsPaths: [path.join(home, 'none.json')], claudeConfigDir: path.join(home, '.claude') })
    assert.equal(r.ok, true)
    return { home, p }
  }
  const run = (home: string) => execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home } })

  it('puts the original statusLine back exactly, before the wrapper script is deleted', async () => {
    const orig = { type: 'command', command: 'echo "a|b"', padding: 1 }
    const { home, p } = await sandbox(orig)
    fs.mkdirSync(p.limitsDir, { recursive: true }); fs.writeFileSync(p.limits, '{"v":1}')
    run(home)
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, 'utf-8')), { model: 'opus', statusLine: orig })
    for (const f of [p.shim, p.record, p.limits, p.backup]) assert.equal(fs.existsSync(f), false)
    assert.equal(fs.existsSync(path.join(home, '.claude', 'agent-flow')), false)
  })

  it('N1: removes the launcher, node-path and node-missing marker too (launcher install and legacy install)', async () => {
    const orig = { type: 'command', command: 'echo "a|b"', padding: 1 }
    const { home, p } = await sandbox(orig)
    assert.equal(fs.existsSync(p.launcher), true)
    fs.mkdirSync(p.limitsDir, { recursive: true }); fs.writeFileSync(p.nodeMissing, '{"v":1,"at":1}')
    run(home)
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, 'utf-8')), { model: 'opus', statusLine: orig })
    for (const f of [p.shim, p.launcher, p.nodePath, p.nodeMissing, p.record, p.backup, p.limitsDir]) assert.equal(fs.existsSync(f), false, path.basename(f))
    assert.equal(fs.existsSync(path.join(home, '.claude', 'agent-flow')), false)

    // an install made before N1: `"<node>" "<shim>"`, no launcher, no node-path
    const legacy = await sandbox(orig)
    const { legacyWrapperCommand } = await import('../src/statusline-installer')
    const s = JSON.parse(fs.readFileSync(legacy.p.settings, 'utf-8'))
    s.statusLine.command = legacyWrapperCommand({ home: legacy.home, nodePath: process.execPath })
    fs.writeFileSync(legacy.p.settings, JSON.stringify(s, null, 2) + '\n')
    const rec = JSON.parse(fs.readFileSync(legacy.p.record, 'utf-8')); rec.installed = s.statusLine
    fs.writeFileSync(legacy.p.record, JSON.stringify(rec))
    fs.rmSync(legacy.p.launcher); fs.rmSync(legacy.p.nodePath)
    run(legacy.home)
    assert.deepEqual(JSON.parse(fs.readFileSync(legacy.p.settings, 'utf-8')), { model: 'opus', statusLine: orig })
    assert.equal(fs.existsSync(legacy.p.shim), false)
  })

  it('removes the key when there was no statusLine, and keeps the hooks removal working in the same file', async () => {
    const hookCmd = (h: string) => `"node" "${h}/.claude/agent-flow/hook.js"`
    const { home, p } = await sandbox(null)
    const s = JSON.parse(fs.readFileSync(p.settings, 'utf-8'))
    s.hooks = { Stop: [{ hooks: [{ type: 'command', command: hookCmd(home) }] }] }
    fs.writeFileSync(p.settings, JSON.stringify(s, null, 2))
    run(home)
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, 'utf-8')), { model: 'opus' })
  })

  it('a statusLine the user replaced is left alone', async () => {
    const { home, p } = await sandbox({ type: 'command', command: 'old' })
    const mine = { type: 'command', command: 'mine' }
    fs.writeFileSync(p.settings, JSON.stringify({ statusLine: mine }))
    run(home)
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, 'utf-8')), { statusLine: mine })
  })

  it('an edited wrapper entry keeps its edits but loses the wrapper command', async () => {
    const { home, p } = await sandbox({ type: 'command', command: 'old', padding: 0 })
    const s = JSON.parse(fs.readFileSync(p.settings, 'utf-8')); s.statusLine.padding = 7
    fs.writeFileSync(p.settings, JSON.stringify(s))
    run(home)
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, 'utf-8')).statusLine, { type: 'command', command: 'old', padding: 7 })
  })

  it('a missing record never leaves a call to the deleted script behind', async () => {
    const { home, p } = await sandbox({ type: 'command', command: 'old' })
    fs.rmSync(p.record)
    run(home)
    assert.equal('statusLine' in JSON.parse(fs.readFileSync(p.settings, 'utf-8')), false)
  })

  it('a settings.json that never existed before the install is removed again', async () => {
    const { home, p } = await sandbox(undefined)
    assert.equal(fs.existsSync(p.settings), true)
    run(home)
    assert.equal(fs.existsSync(p.settings), false)
  })
})

describe('uninstall script: symlinked settings.json and limits history (R2 M1, L1)', { skip: process.platform === 'win32' && 'HOME override and symlinks are POSIX-only' }, () => {
  const run = (home: string) => execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home } })

  async function linkedSandbox(original: Record<string, unknown>) {
    const { installStatusLine, paths } = await import('../src/statusline-installer')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-uninstall-link-'))
    const p = paths(home)
    const target = path.join(home, 'dotfiles', 'settings.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(original, null, 2) + '\n', { mode: 0o640 }); fs.chmodSync(target, 0o640)
    fs.mkdirSync(path.dirname(p.settings), { recursive: true })
    fs.symlinkSync(path.join('..', 'dotfiles', 'settings.json'), p.settings)
    const r = installStatusLine({ home, nodePath: process.execPath, managedSettingsPaths: [path.join(home, 'none.json')], claudeConfigDir: path.join(home, '.claude') })
    assert.equal(r.ok, true)
    assert.equal(fs.lstatSync(p.settings).isSymbolicLink(), true, 'install kept the link')
    return { home, p, target }
  }

  it('restores the statusLine through the link: still a symlink, target deep-equal to the original, mode kept', async () => {
    const original = { model: 'opus', statusLine: { type: 'command', command: 'echo \"a|b\"', padding: 1 } }
    const { home, p, target } = await linkedSandbox(original)
    run(home)
    assert.equal(fs.lstatSync(p.settings).isSymbolicLink(), true, 'still a symlink after uninstall')
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), original)
    assert.equal(fs.statSync(target).mode & 0o777, 0o640)
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['settings.json'], 'no tmp file left')
  })

  it('removes the hooks through the link as well', async () => {
    const hookCmd = (h: string) => `\"node\" \"${h}/.claude/agent-flow/hook.js\"`
    const { home, p, target } = await linkedSandbox({ model: 'opus' })
    const s = JSON.parse(fs.readFileSync(target, 'utf-8'))
    s.hooks = { Stop: [{ hooks: [{ type: 'command', command: hookCmd(home) }] }] }
    fs.writeFileSync(target, JSON.stringify(s, null, 2))
    run(home)
    assert.equal(fs.lstatSync(p.settings).isSymbolicLink(), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { model: 'opus' })
  })

  it('(L1) deletes claude-history.json and removes the limits directory', async () => {
    const { home, p } = await linkedSandbox({ model: 'opus' })
    fs.mkdirSync(p.limitsDir, { recursive: true })
    fs.writeFileSync(p.limits, '{\"v\":1}'); fs.writeFileSync(p.limitsHistory, '{\"v\":1,\"readings\":[]}')
    run(home)
    assert.equal(fs.existsSync(p.limitsHistory), false)
    assert.equal(fs.existsSync(p.limits), false)
    assert.equal(fs.existsSync(p.limitsDir), false)
  })
})
