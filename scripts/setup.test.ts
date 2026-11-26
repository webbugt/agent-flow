import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { configureHooks, isAgentFlowHook, isAlreadySetup } from './setup'

const HOOK_CMD = '"/usr/bin/node" "/home/u/.claude/agent-flow/hook.js"'

function tmpSettings(content?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-setup-'))
  const file = path.join(dir, '.claude', 'settings.json')
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return file
}

function read(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function quietly<T>(fn: () => T): T {
  const { log, error } = console
  console.log = () => {}
  console.error = () => {}
  try { return fn() } finally { console.log = log; console.error = error }
}

const foreignHttp = { hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/9207692e/session-start' }] }
const foreignCommand = { hooks: [{ type: 'command', command: 'other-tool notify' }] }

test('isAgentFlowHook matches only our own hooks', () => {
  assert.equal(isAgentFlowHook({ hooks: [{ command: HOOK_CMD }] }), true)
  assert.equal(isAgentFlowHook({ hooks: [{ command: '"C:\\node.exe" "C:\\Users\\u\\.claude\\agent-flow\\hook.js"' }] }), true)
  assert.equal(isAgentFlowHook({ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }), true)
  assert.equal(isAgentFlowHook({ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341/' }] }), true)
  assert.equal(isAgentFlowHook(foreignHttp), false)
  assert.equal(isAgentFlowHook({ hooks: [{ type: 'http', url: 'http://127.0.0.1:8080/hooks' }] }), false)
  assert.equal(isAgentFlowHook(foreignCommand), false)
  assert.equal(isAgentFlowHook({}), false)
})

test("configureHooks keeps other tools' loopback HTTP hooks (#73)", () => {
  const file = tmpSettings({ hooks: { SessionStart: [foreignHttp], Stop: [foreignHttp, foreignCommand] } })
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), true)

  const { hooks } = read(file)
  assert.deepEqual(hooks.SessionStart[0], foreignHttp)
  assert.deepEqual(hooks.Stop.slice(0, 2), [foreignHttp, foreignCommand])
  for (const event of ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd']) {
    assert.equal(hooks[event].filter(isAgentFlowHook).length, 1, event)
  }
})

test('configureHooks replaces previous Agent Flow hooks instead of duplicating them', () => {
  const legacy = { hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }
  const old = { hooks: [{ type: 'command', command: '"/old/node" "/home/u/.claude/agent-flow/hook.js"', timeout: 2 }] }
  const file = tmpSettings({ hooks: { PreToolUse: [legacy, old, foreignCommand] } })
  quietly(() => configureHooks(file, HOOK_CMD))
  quietly(() => configureHooks(file, HOOK_CMD))

  const { hooks } = read(file)
  assert.deepEqual(hooks.PreToolUse, [
    foreignCommand,
    { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2 }] },
  ])
})

test('configureHooks preserves unrelated settings', () => {
  const file = tmpSettings({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' } })
  quietly(() => configureHooks(file, HOOK_CMD))
  const settings = read(file)
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
  assert.deepEqual(settings.env, { FOO: '1' })
})

test('configureHooks leaves an unparseable settings file untouched', () => {
  const broken = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n}\n'
  const file = tmpSettings(broken)
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), false)
  assert.equal(fs.readFileSync(file, 'utf-8'), broken)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
})

test('configureHooks creates settings.json when missing', () => {
  const file = tmpSettings()
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), true)
  assert.equal(read(file).hooks.SessionStart.length, 1)
})

test("isAlreadySetup ignores other tools' loopback hooks", () => {
  const file = tmpSettings({ hooks: { SessionStart: [foreignHttp] } })
  const hookScript = path.join(path.dirname(file), 'hook.js')
  fs.writeFileSync(hookScript, '')
  assert.equal(isAlreadySetup(file, hookScript), false)

  quietly(() => configureHooks(file, HOOK_CMD))
  assert.equal(isAlreadySetup(file, hookScript), true)
})

// ─── symlinked settings.json, dangling links, file mode ──────────────────────

function modeOf(f: string): number { return fs.statSync(f).mode & 0o777 }

function linkedSettings(content: unknown, targetMode?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-setup-link-'))
  fs.mkdirSync(path.join(dir, 'dotfiles'))
  fs.mkdirSync(path.join(dir, '.claude'))
  const target = path.join(dir, 'dotfiles', 'settings.json')
  fs.writeFileSync(target, JSON.stringify(content, null, 2))
  if (targetMode !== undefined) fs.chmodSync(target, targetMode)
  const link = path.join(dir, '.claude', 'settings.json')
  fs.symlinkSync('../dotfiles/settings.json', link) // relative, like stow
  return { dir, target, link }
}

test('configureHooks writes through a symlinked settings.json: the link stays, the target changes', () => {
  const { target, link } = linkedSettings({ permissions: { allow: ['Bash(ls)'] } })
  assert.equal(quietly(() => configureHooks(link, HOOK_CMD)), true)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readlinkSync(link), '../dotfiles/settings.json')
  assert.ok(fs.lstatSync(target).isFile())
  const saved = read(target)
  assert.deepEqual(saved.permissions, { allow: ['Bash(ls)'] })
  assert.equal(saved.hooks.SessionStart.length, 1)
  assert.deepEqual(read(link), saved)
})

test('configureHooks refuses a dangling symlinked settings.json and leaves it alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-setup-dangling-'))
  fs.mkdirSync(path.join(dir, '.claude'))
  const link = path.join(dir, '.claude', 'settings.json')
  fs.symlinkSync('../gone/settings.json', link)
  assert.equal(quietly(() => configureHooks(link, HOOK_CMD)), false)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readlinkSync(link), '../gone/settings.json')
  assert.equal(fs.existsSync(path.join(dir, 'gone')), false)
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude')), ['settings.json'])
  // and ensureSetup's detector treats it as "not set up" rather than throwing
  const hookScript = path.join(dir, 'hook.js')
  fs.writeFileSync(hookScript, '')
  assert.equal(isAlreadySetup(link, hookScript), false)
})

test('configureHooks keeps a 0600 settings.json at 0600 (regular file and through a link)', () => {
  const file = tmpSettings({ env: { A: '1' } })
  fs.chmodSync(file, 0o600)
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), true)
  assert.equal(modeOf(file), 0o600)

  const { target, link } = linkedSettings({ env: { A: '1' } }, 0o600)
  assert.equal(quietly(() => configureHooks(link, HOOK_CMD)), true)
  assert.equal(modeOf(target), 0o600)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})

test('configureHooks keeps a 0644 settings.json at 0644 and creates a missing one as 0600', () => {
  const file = tmpSettings({ env: { A: '1' } })
  fs.chmodSync(file, 0o644)
  quietly(() => configureHooks(file, HOOK_CMD))
  assert.equal(modeOf(file), 0o644)

  const fresh = tmpSettings()
  const old = process.umask(0o000)
  try { quietly(() => configureHooks(fresh, HOOK_CMD)) } finally { process.umask(old) }
  assert.equal(modeOf(fresh), 0o600)
})
