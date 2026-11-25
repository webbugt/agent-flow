/**
 * Unit tests for settings.json hook handling.
 *
 * The invariant: Agent Flow only ever touches its own hooks. Other tools
 * register loopback HTTP hooks too (#73), and a settings file we can't parse
 * must never be overwritten.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isLegacyAgentFlowHookUrl, isAgentFlowHook, hasAgentFlowHook,
  mergeAgentFlowHooks, migrateLegacyHttpHooks,
  readSettingsFile, writeJsonAtomic,
} from '../src/hook-entries'

const HOOK_CMD = '"/usr/bin/node" "/home/u/.claude/agent-flow/hook.js"'
const foreignHttp = () => ({ hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/9207692e/session-start' }] })

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-hooks-'))
}

describe('isLegacyAgentFlowHookUrl', () => {
  it('matches only the bare hook server origin', () => {
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:52341'), true)
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:52341/'), true)
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:19847/hook/abc/stop'), false)
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:8080/?x=1'), false)
    assert.equal(isLegacyAgentFlowHookUrl('http://localhost:52341'), false)
    assert.equal(isLegacyAgentFlowHookUrl(undefined), false)
  })
})

describe('isAgentFlowHook', () => {
  it('matches our command hook on POSIX and Windows paths', () => {
    assert.equal(isAgentFlowHook({ hooks: [{ command: HOOK_CMD }] }), true)
    assert.equal(isAgentFlowHook({ hooks: [{ command: '"C:\\node.exe" "C:\\Users\\u\\.claude\\agent-flow\\hook.js"' }] }), true)
  })

  it("does not match other tools' hooks", () => {
    assert.equal(isAgentFlowHook(foreignHttp()), false)
    assert.equal(isAgentFlowHook({ hooks: [{ command: 'other-tool notify' }] }), false)
    assert.equal(isAgentFlowHook({}), false)
  })
})

describe('mergeAgentFlowHooks', () => {
  it('replaces our entries and keeps everything else', () => {
    const settings: Record<string, unknown> = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        SessionStart: [foreignHttp(), { hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '"/old/node" "/x/.claude/agent-flow/hook.js"' }] }],
        UserPromptSubmit: [foreignHttp()],
      },
    }
    const entry = { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2 }] }
    mergeAgentFlowHooks(settings, entry, ['SessionStart', 'Stop'])
    mergeAgentFlowHooks(settings, entry, ['SessionStart', 'Stop'])

    const hooks = settings.hooks as Record<string, unknown[]>
    assert.deepEqual(hooks.SessionStart, [foreignHttp(), entry])
    assert.deepEqual(hooks.Stop, [entry])
    assert.deepEqual(hooks.UserPromptSubmit, [foreignHttp()])
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
  })
})

describe('hasAgentFlowHook', () => {
  it('is false when only another tool has loopback hooks', () => {
    assert.equal(hasAgentFlowHook({ hooks: { SessionStart: [foreignHttp()] } }), false)
    assert.equal(hasAgentFlowHook({ hooks: { SessionStart: [{ hooks: [{ command: HOOK_CMD }] }] } }), true)
    assert.equal(hasAgentFlowHook({}), false)
  })
})

describe('migrateLegacyHttpHooks', () => {
  it('rewrites legacy Agent Flow HTTP hooks and leaves foreign ones alone', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }],
        Stop: [foreignHttp()],
      },
    }
    assert.equal(migrateLegacyHttpHooks(settings, HOOK_CMD, 2), true)
    const hooks = settings.hooks as Record<string, unknown[]>
    assert.deepEqual(hooks.PreToolUse, [{ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2 }] }])
    assert.deepEqual(hooks.Stop, [foreignHttp()])
  })

  it('reports no change when there is nothing to migrate', () => {
    const settings = { hooks: { Stop: [foreignHttp()] } }
    assert.equal(migrateLegacyHttpHooks(settings, HOOK_CMD, 2), false)
    assert.deepEqual(settings, { hooks: { Stop: [foreignHttp()] } })
  })
})

describe('readSettingsFile', () => {
  it('treats a missing or empty file as empty settings', () => {
    const dir = tmpDir()
    assert.deepEqual(readSettingsFile(path.join(dir, 'missing.json')), { ok: true, settings: {} })
    fs.writeFileSync(path.join(dir, 'empty.json'), '  \n')
    assert.deepEqual(readSettingsFile(path.join(dir, 'empty.json')), { ok: true, settings: {} })
  })

  it('reports invalid JSON and non-object values as errors', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'trailing-comma.json'), '{ "a": 1, }')
    fs.writeFileSync(path.join(dir, 'array.json'), '[]')
    assert.equal(readSettingsFile(path.join(dir, 'trailing-comma.json')).ok, false)
    assert.equal(readSettingsFile(path.join(dir, 'array.json')).ok, false)
  })
})

describe('writeJsonAtomic', () => {
  it('writes the file, creating parent dirs, and leaves no temp file behind', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'nested', 'settings.json')
    writeJsonAtomic(file, { a: 1 })
    assert.equal(fs.readFileSync(file, 'utf-8'), '{\n  "a": 1\n}\n')
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
  })

  it('writes through a symlinked file and keeps the link', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'dotfiles', 'settings.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{}\n')
    const link = path.join(dir, 'claude', 'settings.json')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link)
    writeJsonAtomic(link, { a: 2 })
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.equal(fs.readFileSync(target, 'utf-8'), '{\n  "a": 2\n}\n')
  })

  it('writes through a relative link chain and keeps every link', () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'dotfiles'))
    fs.mkdirSync(path.join(dir, 'claude'))
    const target = path.join(dir, 'dotfiles', 'settings.json')
    fs.writeFileSync(target, '{}\n')
    fs.symlinkSync('settings.json', path.join(dir, 'dotfiles', 'mid.json')) // relative, same dir
    const link = path.join(dir, 'claude', 'settings.json')
    fs.symlinkSync('../dotfiles/mid.json', link) // relative, up and over
    writeJsonAtomic(link, { chain: true })
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.ok(fs.lstatSync(path.join(dir, 'dotfiles', 'mid.json')).isSymbolicLink())
    assert.equal(fs.readlinkSync(link), '../dotfiles/mid.json')
    assert.ok(fs.lstatSync(target).isFile())
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { chain: true })
    assert.deepEqual(fs.readdirSync(path.join(dir, 'dotfiles')).sort(), ['mid.json', 'settings.json'])
  })

  it('refuses a dangling link: throws, leaves it a link, creates no target and no temp file', () => {
    const dir = tmpDir()
    const link = path.join(dir, 'settings.json')
    fs.symlinkSync(path.join(dir, 'gone', 'settings.json'), link)
    assert.throws(() => writeJsonAtomic(link, { a: 1 }), /symbolic link that cannot be followed/)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.equal(fs.existsSync(path.join(dir, 'gone')), false)
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
  })

  it('refuses a looping link', () => {
    const dir = tmpDir()
    const a = path.join(dir, 'a.json')
    const b = path.join(dir, 'b.json')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    assert.throws(() => writeJsonAtomic(a, {}), /cannot be followed/)
    assert.ok(fs.lstatSync(a).isSymbolicLink())
    assert.ok(fs.lstatSync(b).isSymbolicLink())
  })

  const mode = (f: string) => fs.statSync(f).mode & 0o777

  it('keeps the mode of an existing regular file (600 stays 600, 644 stays 644)', () => {
    const dir = tmpDir()
    for (const m of [0o600, 0o644]) {
      const file = path.join(dir, `s${m.toString(8)}.json`)
      fs.writeFileSync(file, '{}\n')
      fs.chmodSync(file, m)
      writeJsonAtomic(file, { m })
      assert.equal(mode(file), m)
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { m })
    }
  })

  it("keeps the target's mode when writing through a link", () => {
    const dir = tmpDir()
    const target = path.join(dir, 'real.json')
    fs.writeFileSync(target, '{}\n')
    fs.chmodSync(target, 0o600)
    const link = path.join(dir, 'settings.json')
    fs.symlinkSync('real.json', link)
    writeJsonAtomic(link, { a: 3 })
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.equal(mode(target), 0o600)
  })

  it('creates a new file as 0600 whatever the umask', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'new', 'settings.json')
    const old = process.umask(0o000)
    try { writeJsonAtomic(file, { a: 1 }) } finally { process.umask(old) }
    assert.equal(mode(file), 0o600)
  })

  it('removes its temp file when the rename fails', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'settings.json')
    fs.mkdirSync(file) // renaming a file onto a directory fails
    assert.throws(() => writeJsonAtomic(file, { a: 1 }))
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
  })
})

describe('readSettingsFile: links', () => {
  it('refuses a dangling link instead of reading it as empty', () => {
    const dir = tmpDir()
    const link = path.join(dir, 'settings.json')
    fs.symlinkSync(path.join(dir, 'missing.json'), link)
    const r = readSettingsFile(link)
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /cannot be followed/)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
  })

  it('reads through a working link (absolute and relative)', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'real.json'), '{"a":1}')
    fs.symlinkSync('real.json', path.join(dir, 'rel.json'))
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'abs.json'))
    assert.deepEqual(readSettingsFile(path.join(dir, 'rel.json')), { ok: true, settings: { a: 1 } })
    assert.deepEqual(readSettingsFile(path.join(dir, 'abs.json')), { ok: true, settings: { a: 1 } })
  })
})
