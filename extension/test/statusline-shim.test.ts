/**
 * P6a: the installed shim script, executed for real with a temp HOME. Proves: tee keeps only the whitelisted fields,
 * the file is 0600 and atomic, malformed input never breaks the chain, the original command gets the same stdin and its
 * stdout / exit code come back, and nothing from the transcript or prompt is stored.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { installStatusLine, paths, uninstallStatusLine, type InstallerEnv } from '../src/statusline-installer'
import { LIMITS_FILE_KEYS } from '../src/statusline-shim'

const temps: string[] = []
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function setup(statusLine?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-shim-'))
  temps.push(root)
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const p = paths(home)
  if (statusLine !== undefined) fs.writeFileSync(p.settings, JSON.stringify({ statusLine }, null, 2) + '\n')
  const env: InstallerEnv = { home, nodePath: process.execPath, managedSettingsPaths: [path.join(root, 'none.json')], claudeConfigDir: path.join(home, '.claude') }
  const r = installStatusLine(env)
  assert.equal(r.ok, true)
  return { root, home, p, env }
}

/** Runs the wrapper command exactly as Claude Code would: through a shell, JSON on stdin. */
function run(home: string, command: string, stdin: string | Buffer) {
  return spawnSync(command, { shell: true, input: stdin, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8', timeout: 15000 })
}
const wrapperOf = (p: ReturnType<typeof paths>) => JSON.parse(fs.readFileSync(p.settings, 'utf-8')).statusLine.command as string

const FULL = {
  session_id: 'abc-123',
  transcript_path: '/home/u/.claude/projects/x/abc.jsonl',
  cwd: '/home/u/secret-project',
  model: { id: 'claude-opus-4-7', display_name: 'Opus' },
  workspace: { current_dir: '/home/u/secret-project', project_dir: '/home/u/secret-project' },
  version: '2.1.326',
  cost: { total_cost_usd: 1.23, total_duration_ms: 5000 },
  prompt: 'my SECRET prompt text',
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1893456000 }, seven_day: { used_percentage: 41.2, resets_at: 1893999999 } },
}

describe('statusline shim: tee', { skip: process.platform === 'win32' && 'POSIX shell' }, () => {
  it('writes only rate_limits, session_id, model.id and a timestamp (0600), nothing else from the payload', () => {
    const t = setup()
    const before = Date.now()
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.status, 0, res.stderr)
    const text = fs.readFileSync(t.p.limits, 'utf-8')
    const rec = JSON.parse(text)
    assert.deepEqual(Object.keys(rec).sort(), [...LIMITS_FILE_KEYS].sort())
    assert.equal(rec.v, 1)
    assert.ok(rec.at >= before && rec.at <= Date.now())
    assert.equal(rec.session_id, 'abc-123')
    assert.deepEqual(rec.model, { id: 'claude-opus-4-7' })
    assert.deepEqual(rec.rate_limits, FULL.rate_limits)
    for (const forbidden of ['SECRET', 'secret-project', 'transcript', '.jsonl', 'total_cost', 'display_name', '2.1.326']) assert.equal(text.includes(forbidden), false, forbidden)
    assert.equal(fs.statSync(t.p.limits).mode & 0o777, 0o600)
    assert.equal(fs.statSync(t.p.limitsDir).mode & 0o777, 0o700)
    assert.deepEqual(fs.readdirSync(t.p.limitsDir), ['claude.json'], 'no temp file left behind')
  })

  it('keeps unknown window names as numbers only and drops everything else inside a window', () => {
    const t = setup()
    const payload = { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1, note: 'LEAK', nested: { a: 1 } }, weekly_fable: { used_percentage: 9 }, 'Bad Key!': { used_percentage: 1 }, str: 'x', arr: [1], bad: { used_percentage: 'NaN' } } }
    run(t.home, wrapperOf(t.p), JSON.stringify(payload))
    const rec = JSON.parse(fs.readFileSync(t.p.limits, 'utf-8'))
    assert.deepEqual(rec.rate_limits, { five_hour: { used_percentage: 5, resets_at: 1 }, weekly_fable: { used_percentage: 9 } })
    assert.equal(JSON.stringify(rec).includes('LEAK'), false)
  })

  it('does not overwrite the last reading when a call carries no rate_limits (the first call of a session)', () => {
    const t = setup()
    run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    const first = fs.readFileSync(t.p.limits, 'utf-8')
    const res = run(t.home, wrapperOf(t.p), JSON.stringify({ session_id: 's2', model: { id: 'm' } }))
    assert.equal(res.status, 0)
    assert.equal(fs.readFileSync(t.p.limits, 'utf-8'), first)
  })

  it('a newer reading replaces the old one', () => {
    const t = setup()
    run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    run(t.home, wrapperOf(t.p), JSON.stringify({ ...FULL, rate_limits: { five_hour: { used_percentage: 99, resets_at: 5 } } }))
    assert.deepEqual(JSON.parse(fs.readFileSync(t.p.limits, 'utf-8')).rate_limits, { five_hour: { used_percentage: 99, resets_at: 5 } })
  })

  it('rejects hostile session_id / model.id values instead of storing them', () => {
    const t = setup()
    run(t.home, wrapperOf(t.p), JSON.stringify({ session_id: '../../etc/passwd\nx', model: { id: 'a b;rm -rf' }, rate_limits: { five_hour: { used_percentage: 1 } } }))
    const rec = JSON.parse(fs.readFileSync(t.p.limits, 'utf-8'))
    assert.equal('session_id' in rec, false)
    assert.equal('model' in rec, false)
  })

  for (const [name, stdin] of [
    ['empty stdin', ''], ['not JSON', 'hello world'], ['truncated JSON', '{"rate_limits": {"five_hour": '], ['JSON null', 'null'],
    ['JSON array', '[1,2]'], ['JSON string', '"x"'], ['binary garbage', Buffer.from([0xff, 0xfe, 0x00, 0x80])],
    ['huge payload', JSON.stringify({ junk: 'x'.repeat(3_000_000), rate_limits: { five_hour: { used_percentage: 3 } } })],
  ] as [string, string | Buffer][]) {
    it(`malformed input (${name}) exits 0, breaks nothing${name === 'huge payload' ? ' and still tees' : ' and writes nothing'}`, () => {
      const t = setup()
      const res = run(t.home, wrapperOf(t.p), stdin)
      assert.equal(res.status, 0, res.stderr)
      assert.equal(res.stderr, '')
      assert.equal(fs.existsSync(t.p.limits), name === 'huge payload')
    })
  }

  it('a limits directory that cannot be created does not break the status line', () => {
    const t = setup({ type: 'command', command: 'echo ORIGINAL' })
    fs.writeFileSync(t.p.limitsDir, 'a file where the directory should be')
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.status, 0)
    assert.equal(res.stdout, 'ORIGINAL\n')
  })
})

describe('statusline shim: chain', { skip: process.platform === 'win32' && 'POSIX shell' }, () => {
  it('(2) the original command gets the identical stdin and its stdout comes back byte for byte', () => {
    const catScript = 'cat'
    const t = setup({ type: 'command', command: catScript, padding: 1 })
    const input = JSON.stringify(FULL)
    const res = run(t.home, wrapperOf(t.p), input)
    assert.equal(res.status, 0)
    assert.equal(res.stdout, input, 'stdin reached the original unchanged and its stdout is forwarded')
  })

  it('forwards ANSI colours, unicode and no trailing newline untouched', () => {
    const t = setup({ type: 'command', command: `printf '\\033[32mOK\\033[0m ✓ %s' "ünï"` })
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.stdout, '\u001b[32mOK\u001b[0m ✓ ünï')
  })

  it('forwards stderr and the exit code of the original', () => {
    const t = setup({ type: 'command', command: 'echo oops 1>&2; exit 7' })
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.status, 7)
    assert.equal(res.stderr, 'oops\n')
  })

  it('the original still runs with the same stdin when the input is malformed', () => {
    const t = setup({ type: 'command', command: 'cat' })
    const res = run(t.home, wrapperOf(t.p), 'not json at all')
    assert.equal(res.status, 0)
    assert.equal(res.stdout, 'not json at all')
  })

  it('the original keeps working when it does not read stdin at all', () => {
    const t = setup({ type: 'command', command: 'echo fixed' })
    const res = run(t.home, wrapperOf(t.p), JSON.stringify({ ...FULL, junk: 'x'.repeat(2_000_000) }))
    assert.equal(res.status, 0)
    assert.equal(res.stdout, 'fixed\n')
  })

  it('a command that does not exist behaves like the original would (shell exit 127), no crash of the shim', () => {
    const t = setup({ type: 'command', command: 'definitely-not-a-command-xyz' })
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.status, 127)
    assert.ok(fs.existsSync(t.p.limits), 'tee still happened')
  })

  it('runs quoting-heavy originals through the shell exactly like Claude Code would', () => {
    const t = setup({ type: 'command', command: `echo "a|b" 'c d' $((1+2)) | tr a-z A-Z` })
    const res = run(t.home, wrapperOf(t.p), '{}')
    assert.equal(res.stdout, 'A|B C D 3\n')
  })

  it('with no original status line: prints nothing, exits 0, still tees', () => {
    const t = setup()
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.status, 0)
    assert.equal(res.stdout, '')
    assert.ok(fs.existsSync(t.p.limits))
  })

  it('a damaged original record: tees, prints nothing, exits 0 (never an error in the status line)', () => {
    const t = setup({ type: 'command', command: 'echo hi' })
    fs.writeFileSync(t.p.record, '{ broken')
    const res = run(t.home, wrapperOf(t.p), JSON.stringify(FULL))
    assert.equal(res.status, 0)
    assert.equal(res.stdout, '')
    assert.equal(res.stderr, '')
  })

  it('after uninstall the wrapper is gone: the original command alone is in settings.json again', () => {
    const t = setup({ type: 'command', command: 'echo hi' })
    assert.equal(uninstallStatusLine(t.env).ok, true)
    const sl = JSON.parse(fs.readFileSync(t.p.settings, 'utf-8')).statusLine
    assert.deepEqual(sl, { type: 'command', command: 'echo hi' })
    assert.equal(fs.existsSync(t.p.shim), false)
  })
})
