import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  redactSecrets,
  sanitizeDeep,
  limitText,
  maxTextChars,
  MAX_TEXT_CHARS,
  toolInput,
  toolResult,
  rowsToItems,
  readSessionTranscript,
  BACKLOG_MAX_ROWS,
} from './hermes-transcript'
import type { TranscriptRow } from './hermes-transcript'
import { HermesLogWatcher, displayToolName } from './hermes-logs'
import type { AgentEvent } from '../extension/src/protocol'

type Db = {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
  close(): void
}
function openWritable(file: string): Db {
  const Ctor = (require('node:sqlite') as { DatabaseSync: new (f: string) => Db }).DatabaseSync
  return new Ctor(file)
}

// Every secret below is made up for the test.
const FAKE_SK = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0kLmN'
const FAKE_GH = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

// ─── Redaction ──────────────────────────────────────────────────────────────

test('redacts API keys, tokens, passwords, private keys and URL credentials', () => {
  const input = [
    `OPENAI_API_KEY=${FAKE_SK}`,
    `curl -H "Authorization: Bearer ${FAKE_JWT}" https://x.test`,
    `token ${FAKE_GH}`,
    '{"password": "hunter2hunter2", "user": "bob"}',
    'postgres://admin:s3cretpass@db.local:5432/app',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----',
    'AWS key AKIAABCDEFGHIJKLMNOP here',
  ].join('\n')
  const out = redactSecrets(input)
  for (const secret of [FAKE_SK, FAKE_GH, FAKE_JWT, 'hunter2hunter2', 's3cretpass', 'MIIBOgIBAAJBAKj34', 'AKIAABCDEFGHIJKLMNOP']) {
    assert.ok(!out.includes(secret), `secret still present: ${secret.slice(0, 8)}…`)
  }
  assert.ok(out.includes('"user": "bob"'), 'ordinary fields stay')
  assert.ok(out.includes('OPENAI_API_KEY='), 'the name stays, only the value goes')
  assert.ok(out.includes('db.local:5432/app'), 'the rest of a URL stays')
})

test('redaction leaves ordinary text alone and stays fast on a long base64 run', () => {
  const plain = 'Run the tests, then read the tokens count: 12345 and the token budget.\nconst x = 1'
  assert.equal(redactSecrets(plain), plain)
  const blob = 'A'.repeat(2_000_000)
  const t0 = Date.now()
  assert.equal(redactSecrets(blob), blob)
  assert.ok(Date.now() - t0 < 2000, 'linear time on long unbroken text')
})

test('redacts Telegram, GitLab, HuggingFace, npm tokens and Slack/Discord webhooks', () => {
  const tg = '123456789:' + 'AAH' + 'x'.repeat(32)
  const cases: Array<[string, string]> = [
    [`curl https://api.telegram.org/bot${tg}/sendMessage`, tg.split(':')[1]],
    [`chat 1 via ${tg} done`, tg.split(':')[1]],
    [`clone --token glpat-${'a1B2c3D4e5'.repeat(2)}`, 'glpat-a1B2c3D4e5'],
    [`export X=hf_${'aB3dE5gH7j'.repeat(4)}`, 'hf_aB3dE5gH7j'],
    [`registry auth npm_${'aB3dE5gH7j'.repeat(4)}`, 'npm_aB3dE5gH7j'],
    ['post https://hooks.slack.com/services/T0123ABCD/B0123ABCD/abcDEF123456ghIJKL', 'abcDEF123456ghIJKL'],
    ['post https://discord.com/api/webhooks/123456789012345678/AbCdEf_gh-IjKlMnOp', 'AbCdEf_gh-IjKlMnOp'],
  ]
  for (const [input, secret] of cases) {
    const out = redactSecrets(input)
    assert.ok(!out.includes(secret), `still present: ${secret.slice(0, 10)}…`)
  }
  assert.ok(redactSecrets(`https://api.telegram.org/bot${tg}/sendMessage`).endsWith('/sendMessage'), 'the rest of the URL stays')
  assert.equal(redactSecrets('version 2026:11 build 12345678:short'), 'version 2026:11 build 12345678:short')
})

test('a secret nested deeper than the depth limit is still redacted', () => {
  let deep: unknown = { k: FAKE_SK, ok: 'visible' }
  for (let i = 0; i < 10; i++) deep = { n: deep }
  const input = toolInput('mcp_x', JSON.stringify(deep))
  assert.ok(!input.args.includes(FAKE_SK), 'args')
  assert.ok(!JSON.stringify(input.inputData).includes(FAKE_SK), 'inputData')
  assert.ok(!JSON.stringify(sanitizeDeep(deep)).includes(FAKE_SK), 'sanitizeDeep')
})

// ─── Size cap ───────────────────────────────────────────────────────────────

test('long text passes through intact below the cap and ends with a marker above it', () => {
  const long = 'word '.repeat(30_000) // 150,000 chars: far beyond the old 25/30/40/120/200 limits
  assert.ok(long.length < MAX_TEXT_CHARS)
  assert.equal(limitText(long), long)

  const huge = 'x'.repeat(MAX_TEXT_CHARS + 500)
  const cut = limitText(huge)
  assert.ok(cut.startsWith('x'.repeat(MAX_TEXT_CHARS)))
  assert.match(cut, /\[500 more characters not shown\]$/)
})

test('the cap does not split an emoji and can be configured or switched off', () => {
  const text = '😀'.repeat(10) // 20 UTF-16 units
  const cut = limitText(text, 5)
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut.split('\n')[0]), 'no lone surrogate')
  assert.equal(maxTextChars({}), 200_000)
  assert.equal(maxTextChars({ AGENT_FLOW_MAX_TEXT_CHARS: '1234' }), 1234)
  assert.equal(maxTextChars({ AGENT_FLOW_MAX_TEXT_CHARS: '0' }), Infinity)
  assert.equal(maxTextChars({ AGENT_FLOW_MAX_TEXT_CHARS: 'nope' }), 200_000)
})

// ─── Tool input and result ──────────────────────────────────────────────────

test('a Bash command passes through whole, however long', () => {
  const command = 'cd /repo && ' + Array.from({ length: 400 }, (_, i) => `echo step-${i}`).join(' && ')
  assert.ok(command.length > 5000)
  const input = toolInput('terminal', JSON.stringify({ command }))
  assert.equal(input.args, command)
  assert.equal(input.inputData.command, command)
})

test('an edit keeps the full old and new text for the diff', () => {
  const oldText = Array.from({ length: 60 }, (_, i) => `old line ${i}`).join('\n')
  const newText = Array.from({ length: 80 }, (_, i) => `new line ${i}`).join('\n')
  const input = toolInput('patch', JSON.stringify({ path: '/repo/a.ts', old_string: oldText, new_string: newText }))
  assert.deepEqual(input.inputData, { file_path: '/repo/a.ts', old_string: oldText, new_string: newText })
  assert.equal(input.args, '/repo/a.ts')

  const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const w = toolInput('write_file', JSON.stringify({ path: '/repo/b.ts', content }))
  assert.deepEqual(w.inputData, { file_path: '/repo/b.ts', content })
})

test('other tools map to the renderer shapes; unknown tools keep all their arguments', () => {
  assert.deepEqual(toolInput('read_file', '{"path":"/a","offset":5,"limit":50}').inputData, { file_path: '/a', offset: 5, limit: 50 })
  assert.deepEqual(toolInput('web_search', '{"query":"agent flow"}').inputData, { query: 'agent flow' })
  const unknown = toolInput('kanban_comment', JSON.stringify({ task_id: 't_1', body: 'x'.repeat(3000) }))
  assert.equal((unknown.inputData as { body: string }).body.length, 3000)
  assert.deepEqual(toolInput('terminal', 'not json').inputData, {})
  assert.equal(toolInput('terminal', 'not json').args, 'not json')
})

test('secrets in tool arguments and results are redacted', () => {
  const input = toolInput('terminal', JSON.stringify({ command: `export TOKEN=${FAKE_GH}; deploy` }))
  assert.ok(!input.args.includes(FAKE_GH))
  assert.ok(!JSON.stringify(input.inputData).includes(FAKE_GH))
  const res = toolResult(JSON.stringify({ output: `API_KEY=${FAKE_SK}\nok`, exit_code: 0 }))
  assert.ok(!res.text.includes(FAKE_SK))
  assert.ok(res.text.endsWith('ok'))
})

test('a tool result shows the whole output, with errors and exit codes appended', () => {
  const output = Array.from({ length: 3000 }, (_, i) => `log line ${i}`).join('\n')
  const ok = toolResult(JSON.stringify({ output, exit_code: 0, error: null }))
  assert.equal(ok.text, output)
  assert.equal(ok.isError, false)

  const failed = toolResult(JSON.stringify({ output: 'partial', exit_code: 2, error: 'boom' }))
  assert.equal(failed.text, 'partial\n[error] boom\n[exit code 2]')
  assert.equal(failed.isError, true)

  assert.equal(toolResult(JSON.stringify({ content: '1|hello\n2|world', total_lines: 2 })).text, '1|hello\n2|world')
  assert.deepEqual(toolResult('plain text result'), { text: 'plain text result', isError: false })
})

// ─── Rows to items ──────────────────────────────────────────────────────────

function row(id: number, role: string, extra: Partial<TranscriptRow> = {}): TranscriptRow {
  return { id, role, content: null, tool_calls: null, tool_call_id: null, tool_name: null, reasoning: null, timestamp: 1000 + id, ...extra }
}

test('rows become messages, tool starts and tool ends; the system prompt is skipped', () => {
  const longUser = 'Please '.repeat(500)
  const calls = new Map<string, string>()
  const rows: TranscriptRow[] = [
    row(1, 'system', { content: 'SYSTEM PROMPT TEXT' }),
    row(2, 'user', { content: longUser }),
    row(3, 'assistant', {
      content: 'On it.',
      reasoning: 'Thinking about the plan',
      tool_calls: JSON.stringify([{ call_id: 'toolu_1', id: 'toolu_1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'ls -la' }) } }]),
    }),
    row(4, 'tool', { tool_call_id: 'toolu_1', tool_name: 'terminal', content: JSON.stringify({ output: 'total 0', exit_code: 0, error: null }) }),
  ]
  const items = rowsToItems(rows, calls, { displayTool: displayToolName })
  assert.deepEqual(items, [
    { kind: 'message', role: 'user', content: longUser },
    { kind: 'message', role: 'thinking', content: 'Thinking about the plan' },
    { kind: 'message', role: 'assistant', content: 'On it.' },
    { kind: 'tool_start', callId: 'toolu_1', hermesTool: 'terminal', tool: 'Bash', args: 'ls -la', inputData: { command: 'ls -la' } },
    { kind: 'tool_end', callId: 'toolu_1', hermesTool: 'terminal', result: 'total 0', isError: false },
  ])
  assert.ok(!JSON.stringify(items).includes('SYSTEM PROMPT'))
})

test('a result that arrives in a later batch still gets its tool name', () => {
  const calls = new Map<string, string>()
  const first = rowsToItems([row(1, 'assistant', { tool_calls: JSON.stringify([{ call_id: 'c1', function: { name: 'patch', arguments: '{"path":"/x","old_string":"a","new_string":"b"}' } }]) })], calls, { displayTool: displayToolName })
  assert.equal(first[0].kind, 'tool_start')
  const later = rowsToItems([row(2, 'tool', { tool_call_id: 'c1', content: '{"success": true}' })], calls, { displayTool: displayToolName })
  assert.equal((later[0] as { hermesTool: string }).hermesTool, 'patch')
})

// ─── Reading state.db ───────────────────────────────────────────────────────

function makeDb(file: string, sid: string) {
  const db = openWritable(file)
  db.exec('create table sessions (id text primary key, title text, system_prompt text)')
  db.exec('create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_calls text, tool_call_id text, tool_name text, reasoning text, timestamp real)')
  db.prepare('insert into sessions values (?, ?, ?)').run(sid, 'A title', 'TOP SECRET SYSTEM PROMPT')
  const add = (role: string, content: string | null, extra: { calls?: string; callId?: string; tool?: string } = {}) =>
    db.prepare('insert into messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp) values (?, ?, ?, ?, ?, ?, ?)')
      .run(sid, role, content, extra.calls ?? null, extra.callId ?? null, extra.tool ?? null, Date.now() / 1000)
  return { db, add }
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('reads a session from state.db read-only: backlog from the last user message, then only new rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-transcript-'))
  const file = path.join(dir, 'state.db')
  const { db, add } = makeDb(file, 'sess-1')
  add('user', 'old question')
  add('assistant', 'old answer')
  add('user', 'current question')
  add('assistant', null, { calls: JSON.stringify([{ call_id: 'c1', function: { name: 'terminal', arguments: '{"command":"pwd"}' } }]) })
  db.close()

  const first = readSessionTranscript(file, 'sess-1')
  assert.ok(first)
  assert.deepEqual(first!.rows.map(r => r.role), ['user', 'assistant'], 'starts at the last user message')
  assert.equal(first!.rows[0].content, 'current question')
  assert.equal(first!.lastId, 4)
  assert.ok(!JSON.stringify(first).includes('TOP SECRET'), 'the system prompt is never selected')

  const again = readSessionTranscript(file, 'sess-1', first!.lastId)
  assert.deepEqual(again, { rows: [], lastId: 4 })

  const w = openWritable(file)
  w.prepare('insert into messages (session_id, role, content, tool_call_id, timestamp) values (?, ?, ?, ?, ?)').run('sess-1', 'tool', '{"output":"/repo"}', 'c1', 1)
  w.close()
  const next = readSessionTranscript(file, 'sess-1', 4)
  assert.deepEqual(next!.rows.map(r => r.role), ['tool'])

  assert.equal(readSessionTranscript(file, 'no-such-session'), undefined)
  assert.equal(readSessionTranscript(path.join(dir, 'missing.db'), 'sess-1'), undefined)
})

test('reading leaves the database file byte for byte unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-transcript-'))
  const file = path.join(dir, 'state.db')
  const { db, add } = makeDb(file, 's')
  add('user', 'hello')
  db.close()
  const before = sha(file)
  readSessionTranscript(file, 's')
  readSessionTranscript(file, 's', 0)
  assert.equal(sha(file), before)
  assert.deepEqual(fs.readdirSync(dir), ['state.db'], 'no journal or other file left behind')
})

test('the first read replays at most BACKLOG_MAX_ROWS rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-transcript-'))
  const file = path.join(dir, 'state.db')
  const { db, add } = makeDb(file, 's')
  db.exec('begin') // one transaction: far faster than a commit per row
  add('user', 'go')
  for (let i = 0; i < BACKLOG_MAX_ROWS + 50; i++) add('assistant', `step ${i}`)
  db.exec('commit')
  db.close()
  const batch = readSessionTranscript(file, 's')!
  assert.equal(batch.rows.length, BACKLOG_MAX_ROWS)
  assert.equal(batch.rows[batch.rows.length - 1].content, `step ${BACKLOG_MAX_ROWS + 49}`)
})

// ─── Watcher ────────────────────────────────────────────────────────────────

const TOOL_LINE = '2026-11-23 12:06:13,000 INFO [20261123_103037_d0ddaef5] agent.tool_executor: tool terminal completed (0.10s, 588 chars)'
const INBOUND = "2026-11-23 10:27:47,089 INFO gateway.run: inbound message: platform=matrix user=Webbugt chat=!room:matrix.org msg='secret text' reply_to_id=None"

function watcherFixture(profile: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logs-'))
  const logDir = path.join(root, 'profiles', profile, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, 'agent.log')
  fs.writeFileSync(logFile, '')
  const events: AgentEvent[] = []
  return {
    profilesRoot: path.join(root, 'profiles'),
    logFile,
    gatewayFile: path.join(logDir, 'gateway.log'),
    events,
    emit: (e: AgentEvent) => { events.push(e) },
    lifecycle: () => {},
  }
}

test('the live feed carries the full message text, command and result from state.db', () => {
  const f = watcherFixture('omh-coder')
  const userText = 'Please look at this long request. '.repeat(100)
  const command = 'cd /repo && ' + Array.from({ length: 200 }, (_, i) => `echo ${i}`).join(' && ')
  const result = Array.from({ length: 2000 }, (_, i) => `out ${i}`).join('\n')
  const reply = 'Here is a complete answer. '.repeat(120)
  const rows: TranscriptRow[] = [
    row(1, 'user', { content: userText }),
    row(2, 'assistant', { content: reply, tool_calls: JSON.stringify([{ call_id: 'c1', function: { name: 'terminal', arguments: JSON.stringify({ command }) } }]) }),
    row(3, 'tool', { tool_call_id: 'c1', content: JSON.stringify({ output: result, exit_code: 0, error: null }) }),
  ]
  let served = 0
  const w = new HermesLogWatcher({
    profilesRoot: f.profilesRoot, emit: f.emit, lifecycle: f.lifecycle, now: () => 0, titleFor: () => 'Long request',
    transcriptFor: (_db, _sid, after) => {
      if (after === undefined) { served = 3; return { rows, lastId: 3 } }
      return { rows: [], lastId: after }
    },
  })
  w.poll()
  fs.appendFileSync(f.logFile, TOOL_LINE + '\n')
  w.poll()
  assert.equal(served, 3)

  const msgs = f.events.filter(e => e.type === 'message').map(e => e.payload as { role: string; content: string })
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant'])
  assert.equal(msgs[0].content, userText)
  assert.equal(msgs[1].content, reply)

  const starts = f.events.filter(e => e.type === 'tool_call_start')
  const ends = f.events.filter(e => e.type === 'tool_call_end')
  assert.equal(starts.length, 1, 'the log-derived tool event is replaced, not added')
  assert.equal(ends.length, 1)
  const sp = starts[0].payload as { tool: string; args: string; inputData: { command: string }; toolUseId: string }
  const ep = ends[0].payload as { result: string; toolUseId: string; isError: boolean }
  assert.equal(sp.tool, 'Bash')
  assert.equal(sp.args, command)
  assert.equal(sp.inputData.command, command)
  assert.equal(ep.result, result)
  assert.equal(ep.toolUseId, sp.toolUseId)
  assert.equal(ep.isError, false)
})

test('new rows are emitted on later polls and an inbound placeholder is not added for a session read from state.db', () => {
  const f = watcherFixture('hestia')
  let rows: TranscriptRow[] = [row(1, 'user', { content: 'first' })]
  const w = new HermesLogWatcher({
    profilesRoot: f.profilesRoot, emit: f.emit, lifecycle: f.lifecycle, now: () => 0, titleFor: () => 'Chat',
    transcriptFor: (_db, _sid, after) => {
      const fresh = rows.filter(r => after === undefined || r.id > after)
      return { rows: fresh, lastId: fresh.length ? fresh[fresh.length - 1].id : after ?? 0 }
    },
  })
  w.poll()
  fs.appendFileSync(f.logFile, TOOL_LINE + '\n')
  w.poll()
  rows = [...rows, row(2, 'assistant', { content: 'second' })]
  fs.writeFileSync(f.gatewayFile, INBOUND + '\n')
  w.poll()
  w.poll()
  const contents = f.events.filter(e => e.type === 'message').map(e => (e.payload as { content: string }).content)
  assert.deepEqual(contents, ['first', 'second'], 'each row once, no "Message from" placeholder')
  assert.ok(!JSON.stringify(f.events).includes('secret text'), 'gateway.log text is still never read')
})

test('without readable state.db text the watcher keeps its log-only events', () => {
  const f = watcherFixture('taxis')
  const w = new HermesLogWatcher({
    profilesRoot: f.profilesRoot, emit: f.emit, lifecycle: f.lifecycle, now: () => 0, titleFor: () => 'Route',
    transcriptFor: () => undefined,
  })
  w.poll()
  fs.writeFileSync(f.gatewayFile, INBOUND + '\n')
  fs.appendFileSync(f.logFile, TOOL_LINE + '\n')
  w.poll()
  const start = f.events.find(e => e.type === 'tool_call_start')!
  assert.equal((start.payload as { args: string }).args, '')
  const msg = f.events.find(e => e.type === 'message')!
  assert.equal((msg.payload as { content: string }).content, 'Message from Webbugt via matrix')
})
