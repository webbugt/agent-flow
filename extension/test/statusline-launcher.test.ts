/**
 * N1: the POSIX launcher of the statusLine wrapper (`~/.claude/agent-flow/statusline-run.sh`). Every test runs it in a
 * temp HOME with fake `node` scripts, so what it finds is decided by the test, never by what is installed on the
 * machine (`AGENT_FLOW_NODE_DIRS` replaces /usr/bin & co.; PATH is set per test). The real ~/.claude is never touched.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getLauncherScriptContent, STATUSLINE_LAUNCHER_MARKER } from '../src/statusline-launcher'
import { installStatusLine, paths, wrapperCommand, type InstallerEnv } from '../src/statusline-installer'
import { getShimScriptContent } from '../src/statusline-shim'

const SKIP = process.platform === 'win32' && 'POSIX shell'
const temps: string[] = []
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A home WITH spaces in it: the launcher and the command must cope with that everywhere. */
function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-launch-'))
  temps.push(root)
  const home = path.join(root, 'h o m e')
  fs.mkdirSync(home, { recursive: true })
  const p = paths(home)
  fs.mkdirSync(path.dirname(p.launcher), { recursive: true })
  fs.writeFileSync(p.launcher, getLauncherScriptContent(), { mode: 0o755 })
  fs.writeFileSync(p.shim, '// not run: the fake nodes only print their arguments\n')
  return { root, home, p, bin: (name: string) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d } }
}

/** A `node` that says who it is, echoes its arguments and stdin (so the shim's stdout can be compared), then exits with `exit`. */
function fakeNode(file: string, id: string, exit = 0, extra = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\nprintf 'node=${id} args=%s\\n' "$*"\n${extra}command -p cat\necho err-${id} >&2\nexit ${exit}\n`, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return file
}

interface RunOpts { path?: string; dirs?: string; input?: string; shell?: string; shellArgs?: string[]; env?: Record<string, string> }
function run(t: ReturnType<typeof mk>, o: RunOpts = {}) {
  const env: Record<string, string> = { HOME: t.home, PATH: o.path ?? '', AGENT_FLOW_NODE_DIRS: o.dirs ?? '', ...(o.env ?? {}) }
  const r = spawnSync(o.shell ?? '/bin/sh', [...(o.shellArgs ?? []), t.p.launcher], { env, input: o.input ?? '', encoding: 'utf-8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
const mode = (f: string) => fs.statSync(f).mode & 0o777
const read = (f: string) => fs.readFileSync(f, 'utf-8')
const record = (t: ReturnType<typeof mk>, node: string) => { fs.mkdirSync(path.dirname(t.p.nodePath), { recursive: true }); fs.writeFileSync(t.p.nodePath, node + '\n', { mode: 0o600 }) }

describe('statusLine launcher: which node it uses', { skip: SKIP }, () => {
  it('uses the recorded node first, and runs it with the shim next to the launcher', () => {
    const t = mk()
    const recorded = fakeNode(path.join(t.root, 'rec dir', 'node'), 'RECORDED')
    fakeNode(path.join(t.bin('pathbin'), 'node'), 'PATH')
    record(t, recorded)
    const r = run(t, { path: path.join(t.root, 'pathbin'), input: 'hello' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, `node=RECORDED args=${t.p.shim}\nhello`)
    assert.equal(read(t.p.nodePath), recorded + '\n', 'node-path unchanged: nothing to heal')
  })

  it('recorded node removed -> falls back to PATH, and self-heals node-path (0600)', () => {
    const t = mk()
    record(t, path.join(t.root, 'gone', 'node'))
    fakeNode(path.join(t.bin('pathbin'), 'node'), 'PATH')
    const r = run(t, { path: path.join(t.root, 'pathbin') })
    assert.equal(r.stdout, `node=PATH args=${t.p.shim}\n`)
    assert.equal(read(t.p.nodePath), path.join(t.root, 'pathbin', 'node') + '\n', 'the node that worked is recorded')
    assert.equal(mode(t.p.nodePath), 0o600)
    // second run: the recorded node is now the first choice (PATH may be empty again)
    const again = run(t, { path: '' })
    assert.equal(again.stdout, `node=PATH args=${t.p.shim}\n`)
  })

  it('recorded node not executable, a directory, relative or empty -> ignored', () => {
    for (const bad of ['', 'relative/node', 'DIR', 'NOEXEC']) {
      const t = mk()
      const value = bad === 'DIR' ? t.bin('adir') : bad === 'NOEXEC' ? (() => { const f = path.join(t.root, 'noexec'); fs.writeFileSync(f, '#!/bin/sh\necho no\n', { mode: 0o644 }); return f })() : bad
      record(t, value)
      fakeNode(path.join(t.bin('pathbin'), 'node'), 'PATH')
      const r = run(t, { path: path.join(t.root, 'pathbin') })
      assert.equal(r.stdout, `node=PATH args=${t.p.shim}\n`, JSON.stringify(bad))
    }
  })

  it('no record at all -> PATH, and node-path is created (0600)', () => {
    const t = mk()
    fakeNode(path.join(t.bin('pathbin'), 'node'), 'PATH')
    assert.equal(fs.existsSync(t.p.nodePath), false)
    assert.equal(run(t, { path: path.join(t.root, 'pathbin') }).status, 0)
    assert.equal(read(t.p.nodePath), path.join(t.root, 'pathbin', 'node') + '\n')
    assert.equal(mode(t.p.nodePath), 0o600)
  })

  it('PATH empty -> known location: ~/.hermes/tools/node-* with the HIGHEST version (numeric, not alphabetical)', () => {
    const t = mk()
    for (const v of ['9.9.9', '26.2.0', '26.12.1', '26.12.0']) fakeNode(path.join(t.home, '.hermes', 'tools', `node-${v}-linux-x64`, 'bin', 'node'), v)
    const r = run(t, { path: '' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, `node=26.12.1 args=${t.p.shim}\n`)
    assert.equal(read(t.p.nodePath), path.join(t.home, '.hermes', 'tools', 'node-26.12.1-linux-x64', 'bin', 'node') + '\n', 'self-heal wrote the known location')
  })

  it('known locations in order: hermes, volta, nvm default, system dirs', () => {
    const t = mk()
    const sys = t.bin('sysbin')
    fakeNode(path.join(sys, 'node'), 'SYSTEM')
    assert.equal(run(t, { dirs: sys }).stdout.split(' ')[0], 'node=SYSTEM')
    fakeNode(path.join(t.home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'node'), 'NVM-20')
    fs.mkdirSync(path.join(t.home, '.nvm', 'alias'), { recursive: true })
    fs.writeFileSync(path.join(t.home, '.nvm', 'alias', 'default'), 'v20.1.0\n')
    fs.rmSync(t.p.nodePath, { force: true })
    assert.equal(run(t, { dirs: sys }).stdout.split(' ')[0], 'node=NVM-20')
    fakeNode(path.join(t.home, '.volta', 'bin', 'node'), 'VOLTA')
    fs.rmSync(t.p.nodePath, { force: true })
    assert.equal(run(t, { dirs: sys }).stdout.split(' ')[0], 'node=VOLTA')
    fakeNode(path.join(t.home, '.hermes', 'tools', 'node-1.0.0-linux-x64', 'bin', 'node'), 'HERMES')
    fs.rmSync(t.p.nodePath, { force: true })
    assert.equal(run(t, { dirs: sys }).stdout.split(' ')[0], 'node=HERMES')
  })

  it('PATH wins over the known locations', () => {
    const t = mk()
    fakeNode(path.join(t.home, '.hermes', 'tools', 'node-1.0.0-linux-x64', 'bin', 'node'), 'HERMES')
    fakeNode(path.join(t.bin('pathbin'), 'node'), 'PATH')
    assert.equal(run(t, { path: path.join(t.root, 'pathbin') }).stdout.split(' ')[0], 'node=PATH')
  })

  it('nvm: the default alias picks the version (highest matching), an alias chain is followed, a missing one falls back to the highest installed', () => {
    const t = mk()
    const nvm = path.join(t.home, '.nvm')
    for (const v of ['v18.0.0', 'v20.1.0', 'v22.3.0', 'v22.10.1']) fakeNode(path.join(nvm, 'versions', 'node', v, 'bin', 'node'), v)
    fs.mkdirSync(path.join(nvm, 'alias', 'lts'), { recursive: true })
    const pick = () => { fs.rmSync(t.p.nodePath, { force: true }); return run(t, { dirs: '' }).stdout.split(' ')[0] }
    fs.writeFileSync(path.join(nvm, 'alias', 'default'), '22\n')
    assert.equal(pick(), 'node=v22.10.1')
    fs.writeFileSync(path.join(nvm, 'alias', 'default'), 'lts/*\n')
    fs.writeFileSync(path.join(nvm, 'alias', 'lts', '*'), 'v20.1.0\n')
    assert.equal(pick(), 'node=v20.1.0', 'alias -> alias -> version')
    fs.writeFileSync(path.join(nvm, 'alias', 'default'), 'v99.0.0\n')
    assert.equal(pick(), 'node=v22.10.1', 'default not installed: highest installed')
    fs.rmSync(path.join(nvm, 'alias'), { recursive: true })
    assert.equal(pick(), 'node=v22.10.1', 'no alias file: highest installed')
  })

  it('a node found at a known location that is a directory or not executable is skipped', () => {
    const t = mk()
    fs.mkdirSync(path.join(t.home, '.volta', 'bin', 'node'), { recursive: true })
    const sys = t.bin('sysbin')
    fs.writeFileSync(path.join(sys, 'node'), '#!/bin/sh\necho x\n', { mode: 0o644 })
    const r = run(t, { dirs: sys })
    assert.equal(r.stdout, '')
    assert.equal(fs.existsSync(t.p.nodeMissing), true)
  })
})

describe('statusLine launcher: no node at all', { skip: SKIP }, () => {
  it('prints nothing, exits 0, writes the marker (0600) and creates no node-path', () => {
    const t = mk()
    record(t, path.join(t.root, 'gone', 'node'))
    const before = Date.now()
    const r = run(t, { path: '', input: '{"x":1}' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    const m = JSON.parse(read(t.p.nodeMissing))
    assert.deepEqual(Object.keys(m).sort(), ['at', 'v'])
    assert.equal(m.v, 1)
    assert.ok(m.at >= Math.floor(before / 1000) * 1000 && m.at <= Date.now() + 1000, `at=${m.at}`)
    assert.equal(mode(t.p.nodeMissing), 0o600)
    assert.equal(read(t.p.nodePath), path.join(t.root, 'gone', 'node') + '\n', 'the old record is left as it was')
  })

  it('works with no HOME .agent-flow directory yet (creates it 0700) and leaves no temp file behind', () => {
    const t = mk()
    assert.equal(fs.existsSync(path.join(t.home, '.agent-flow')), false)
    assert.equal(run(t).status, 0)
    assert.equal(mode(path.join(t.home, '.agent-flow')), 0o700)
    assert.deepEqual(fs.readdirSync(t.p.limitsDir), ['node-missing.json'])
  })

  it('a later run that finds node removes the marker', () => {
    const t = mk()
    assert.equal(run(t).stdout, '')
    assert.equal(fs.existsSync(t.p.nodeMissing), true)
    fakeNode(path.join(t.bin('pathbin'), 'node'), 'PATH')
    assert.equal(run(t, { path: path.join(t.root, 'pathbin') }).stdout, `node=PATH args=${t.p.shim}\n`)
    assert.equal(fs.existsSync(t.p.nodeMissing), false)
  })

  it('an unwritable marker location does not make it fail or print', () => {
    const t = mk()
    fs.mkdirSync(path.join(t.home, '.agent-flow'), { recursive: true })
    fs.writeFileSync(path.join(t.home, '.agent-flow', 'limits'), 'a file where the directory should be')
    const r = run(t)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  })
})

describe('statusLine launcher: pass-through', { skip: SKIP }, () => {
  it('stdin reaches the shim unchanged (binary-safe enough: newlines, quotes, unicode, no trailing newline)', () => {
    const t = mk()
    const node = fakeNode(path.join(t.root, 'n', 'node'), 'N')
    record(t, node)
    const input = '{"a":"é \\"q\\"","b":[1,2]}\nsecond line\n\nno newline at the end'
    const r = run(t, { input })
    assert.equal(r.stdout, `node=N args=${t.p.shim}\n${input}`)
  })

  it('the exit code of node (the shim) is the exit code of the launcher: 0, 1, 7, 130', () => {
    for (const code of [0, 1, 7, 130]) {
      const t = mk()
      record(t, fakeNode(path.join(t.root, 'n', 'node'), 'N', code))
      assert.equal(run(t).status, code, String(code))
    }
  })

  it('stderr passes through, and the umask is not changed for node (only the launcher\'s own file writes use 077)', () => {
    const t = mk()
    record(t, fakeNode(path.join(t.root, 'n', 'node'), 'N', 0, 'umask >&2\n'))
    const r = spawnSync('/bin/sh', ['-c', `umask 022; exec /bin/sh "${t.p.launcher}"`], { env: { HOME: t.home, PATH: '', AGENT_FLOW_NODE_DIRS: '' }, encoding: 'utf-8' })
    assert.match(r.stderr, /^0?022\nerr-N\n$/)
  })

  it('a self-healing run does not change node\'s umask either', () => {
    const t = mk()
    fakeNode(path.join(t.bin('pathbin'), 'node'), 'P', 0, 'umask >&2\n')
    const r = spawnSync('/bin/sh', ['-c', `umask 022; exec /bin/sh "${t.p.launcher}"`], { env: { HOME: t.home, PATH: path.join(t.root, 'pathbin'), AGENT_FLOW_NODE_DIRS: '' }, encoding: 'utf-8' })
    assert.match(r.stderr, /^0?022\nerr-P\n$/)
    assert.equal(mode(t.p.nodePath), 0o600, 'the record itself is private')
  })

  it('runs under every POSIX shell present (sh, dash, bash)', () => {
    let n = 0
    for (const [shell, args] of [['/bin/sh', []], ['/usr/bin/dash', []], ['/usr/bin/bash', []], ['/usr/bin/busybox', ['sh']]] as [string, string[]][]) {
      if (!fs.existsSync(shell)) continue
      const t = mk()
      for (const v of ['26.2.0', '26.12.1']) fakeNode(path.join(t.home, '.hermes', 'tools', `node-${v}-linux-x64`, 'bin', 'node'), v)
      const r = run(t, { shell, shellArgs: args, input: 'in' })
      assert.equal(r.stdout, `node=26.12.1 args=${t.p.shim}\nin`, shell)
      assert.equal(run(mk(), { shell, shellArgs: args }).stdout, '', `${shell}: no node`)
      n++
    }
    assert.ok(n >= 1)
  })
})

describe('statusLine launcher: end to end through the installed command (real node, real shim, a HOME with spaces)', { skip: SKIP }, () => {
  function installed(original?: unknown) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-launch-e2e-'))
    temps.push(root)
    const home = path.join(root, 'my home')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    if (original !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: original }, null, 2) + '\n')
    const env: InstallerEnv = { home, nodePath: process.execPath, managedSettingsPaths: [path.join(root, 'none.json')], claudeConfigDir: path.join(home, '.claude') }
    const r = installStatusLine(env)
    assert.equal(r.ok, true)
    const settings = JSON.parse(read(paths(home).settings))
    return { root, home, env, p: paths(home), command: settings.statusLine.command as string }
  }
  const claudeJson = JSON.stringify({ session_id: 'abc', model: { id: 'claude-x' }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 4102444800 } }, cwd: '/secret' })
  /** What Claude Code does: the command string goes to a shell, the JSON to stdin. */
  const claudeRuns = (home: string, command: string, input = claudeJson) =>
    spawnSync('/bin/sh', ['-c', command], { env: { HOME: home, PATH: '/usr/bin:/bin', AGENT_FLOW_NODE_DIRS: '' }, input, encoding: 'utf-8' })

  it('the command is `sh "<launcher>"`; it tees the limits, chains the original and passes its stdout and exit code through', () => {
    const t = installed({ type: 'command', command: 'cat >/dev/null; printf "orig-line"; exit 3' })
    assert.equal(t.command, `sh "${t.p.launcher}"`)
    assert.ok(t.command.includes(STATUSLINE_LAUNCHER_MARKER))
    const r = claudeRuns(t.home, t.command)
    assert.equal(r.stdout, 'orig-line')
    assert.equal(r.status, 3)
    const limits = JSON.parse(read(t.p.limits))
    assert.equal(limits.rate_limits.five_hour.used_percentage, 12)
    assert.equal(JSON.stringify(limits).includes('secret'), false, 'nothing but the whitelisted fields is stored')
  })

  it('the original command sees the same stdin as without the wrapper', () => {
    const t = installed({ type: 'command', command: 'cat' })
    assert.equal(claudeRuns(t.home, t.command).stdout, claudeJson)
  })

  it('install-time node gone and not on PATH: the wrapper still works through a known location, and heals node-path', () => {
    const t = installed({ type: 'command', command: 'printf ok' })
    const fakeRoot = path.join(t.home, '.hermes', 'tools', 'node-77.0.0-linux-x64', 'bin')
    fs.mkdirSync(fakeRoot, { recursive: true })
    fs.symlinkSync(process.execPath, path.join(fakeRoot, 'node')) // "node was upgraded to a new versioned directory"
    fs.writeFileSync(t.p.nodePath, path.join(t.root, 'old-node-dir', 'bin', 'node') + '\n') // what the install recorded: gone
    const r = claudeRuns(t.home, t.command)
    assert.equal(r.stdout, 'ok')
    assert.equal(r.status, 0)
    assert.equal(read(t.p.nodePath), path.join(fakeRoot, 'node') + '\n')
    assert.equal(fs.existsSync(t.p.limits), true, 'the reading was still observed')
  })

  it('no node anywhere: Claude Code gets an empty status line and exit 0, the marker explains why', () => {
    const t = installed({ type: 'command', command: 'printf ok' })
    fs.rmSync(t.p.nodePath)
    // The real node is only reachable through PATH here; take it away.
    const r = claudeRuns(t.home, t.command)
    // /usr/bin:/bin have no node on this host class; if they do, the run just works and there is nothing to assert.
    if (fs.existsSync('/usr/bin/node') || fs.existsSync('/bin/node')) return
    assert.equal(r.stdout, '')
    assert.equal(r.status, 0)
    assert.equal(fs.existsSync(t.p.nodeMissing), true)
  })

  it('the launcher file is executable and the command also works as a direct exec (mode 0755)', () => {
    const t = installed()
    assert.equal(mode(t.p.launcher), 0o755)
    assert.equal(read(t.p.launcher), getLauncherScriptContent())
    assert.equal(read(t.p.shim), getShimScriptContent())
    assert.equal(wrapperCommand(t.env), t.command)
  })
})
