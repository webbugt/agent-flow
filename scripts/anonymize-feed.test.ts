import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { rowsToItems } from './hermes-transcript'
import type { TranscriptRow } from './hermes-transcript'
import { HermesLogWatcher, displayToolName } from './hermes-logs'
import { createAnonymizePolicy } from '../web/lib/content-privacy'
import { applyAnonymization } from '../web/lib/fleet/fleet-api'
import type { KanbanBoardNode } from '../web/lib/fleet/kanban-source'
import { parseArgs } from '../app/src/args'
import type { AgentEvent } from '../extension/src/protocol'

// Every secret and text below is made up for the test.
const FAKE_KEY = 'sk-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2'
const COMMAND = `curl -H "Authorization: Bearer ${FAKE_KEY}" https://private.example/${'x'.repeat(300)}`
const OLD = Array.from({ length: 12 }, (_, i) => `old private line ${i}`).join('\n')
const NEW = Array.from({ length: 15 }, (_, i) => `new private line ${i}`).join('\n')
const RESULT = JSON.stringify({ output: Array.from({ length: 50 }, (_, i) => `result private ${i} password=hunter2hunter2`).join('\n'), exit_code: 0 })
const USER_TEXT = 'my private question '.repeat(20)

function row(id: number, role: string, extra: Partial<TranscriptRow> = {}): TranscriptRow {
  return { id, role, content: null, tool_calls: null, tool_call_id: null, tool_name: null, reasoning: null, timestamp: 1000 + id, ...extra }
}
const call = (id: string, name: string, args: object) => ({ call_id: id, function: { name, arguments: JSON.stringify(args) } })

const ROWS: TranscriptRow[] = [
  row(1, 'user', { content: USER_TEXT }),
  row(2, 'assistant', {
    content: 'private answer',
    tool_calls: JSON.stringify([
      call('c1', 'terminal', { command: COMMAND }),
      call('c2', 'patch', { path: '/repo/a.ts', old_string: OLD, new_string: NEW }),
      call('c3', 'write_file', { path: '/repo/b.ts', content: NEW }),
    ]),
  }),
  row(3, 'tool', { tool_call_id: 'c1', content: RESULT }),
]

test('anonymized: only names, paths and sizes leave; no command, diff, message or result text', () => {
  const items = rowsToItems(ROWS, new Map(), { displayTool: displayToolName, anonymize: true, from: { user: 'Webbugt', platform: 'matrix' } })
  const json = JSON.stringify(items)
  for (const leaked of ['private', FAKE_KEY, 'hunter2', 'private.example', 'Authorization']) {
    assert.ok(!json.includes(leaked), `leaked: ${leaked}`)
  }
  assert.deepEqual(items[0], { kind: 'message', role: 'user', content: `user message from Webbugt via matrix · ${USER_TEXT.length} chars` })
  const starts = items.filter(i => i.kind === 'tool_start') as Array<{ args: string; inputData: Record<string, unknown> }>
  assert.equal(starts[0].args, `curl · ${COMMAND.length} chars`)
  assert.deepEqual(starts[1].inputData, { file_path: '/repo/a.ts', old_string: '(12 lines removed)', new_string: '(15 lines added)' })
  assert.deepEqual(starts[2].inputData, { file_path: '/repo/b.ts', content: `(15 lines, ${NEW.length} chars)` })
  const end = items.find(i => i.kind === 'tool_end') as { result: string }
  assert.match(end.result, /^\(\d+ lines?, \d+ chars\)$/)
})

test('shown: the same rows give the full command, diff and result, with secrets redacted', () => {
  const items = rowsToItems(ROWS, new Map(), { displayTool: displayToolName, anonymize: false })
  const starts = items.filter(i => i.kind === 'tool_start') as Array<{ args: string; inputData: Record<string, unknown> }>
  assert.ok(starts[0].args.includes('https://private.example/' + 'x'.repeat(300)), 'the full command, not cut')
  assert.ok(!starts[0].args.includes(FAKE_KEY), 'a Bearer token is redacted even when content is shown')
  assert.equal(starts[1].inputData.old_string, OLD)
  assert.equal(starts[1].inputData.new_string, NEW)
  const end = items.find(i => i.kind === 'tool_end') as { result: string }
  assert.ok(end.result.includes('result private 49'))
  assert.ok(!end.result.includes('hunter2'), 'password=... is redacted even when content is shown')
  assert.equal((items[0] as { content: string }).content, USER_TEXT)
})

// ─── Watcher: per profile ───────────────────────────────────────────────────

const TOOL_LINE = (sid: string) => `2026-11-23 12:06:13,000 INFO [${sid}] agent.tool_executor: tool terminal completed (0.10s, 588 chars)`

function fixture(profiles: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-feed-'))
  const logs: Record<string, string> = {}
  for (const p of profiles) {
    const dir = path.join(root, 'profiles', p, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.log'), '')
    logs[p] = path.join(dir, 'agent.log')
  }
  const events: Array<{ event: AgentEvent; sessionId?: string }> = []
  return { root, logs, events, emit: (event: AgentEvent, sessionId?: string) => { events.push({ event, sessionId }) } }
}

function run(value: string | undefined, overrides?: Record<string, boolean>) {
  const f = fixture(['hestia', 'sophia'])
  const warnings: string[] = []
  const policy = createAnonymizePolicy({ value, overrides, warn: m => warnings.push(m) })
  const w = new HermesLogWatcher({
    profilesRoot: path.join(f.root, 'profiles'),
    emit: f.emit,
    lifecycle: () => {},
    now: () => 0,
    titleFor: () => 'Work',
    anonymize: policy,
    warn: m => warnings.push(m),
    transcriptFor: () => ({ rows: ROWS, lastId: 3 }),
  })
  w.poll()
  for (const p of ['hestia', 'sophia']) fs.appendFileSync(f.logs[p], TOOL_LINE(`s_${p}`) + '\n')
  w.poll()
  const byProfile = (p: string) => JSON.stringify(f.events.filter(e => e.sessionId === `hermes-${p}`).map(e => e.event))
  return { hestia: byProfile('hestia'), sophia: byProfile('sophia'), warnings }
}

test('watcher, none: every profile shows full content', () => {
  const r = run('none')
  for (const p of [r.hestia, r.sophia]) assert.ok(p.includes('result private 49') || p.includes('old private line 11'))
  assert.deepEqual(r.warnings, [])
})

test('watcher, all: every profile shows structure only', () => {
  const r = run('all')
  for (const p of [r.hestia, r.sophia]) {
    assert.ok(!p.includes('private'), 'no text')
    assert.ok(p.includes('curl · '))
  }
})

test('watcher, list: only the listed profile is anonymized', () => {
  const r = run('hestia')
  assert.ok(!r.hestia.includes('private'))
  assert.ok(r.sophia.includes('old private line 11'))
  assert.ok(!r.sophia.includes('hunter2') && !r.sophia.includes(FAKE_KEY), 'redaction still applies to shown content')
})

test('watcher, unknown profile name: falls back to the default, warns, does not crash', () => {
  const r = run('hestia,ghost')
  assert.ok(!r.hestia.includes('private'))
  assert.ok(r.sophia.includes('old private line 11'), 'a profile that is not listed follows the default')
  assert.equal(r.warnings.filter(w => w.includes('"ghost"')).length, 1)
})

test('watcher, per-profile override beats the global setting', () => {
  const r = run('all', { sophia: false })
  assert.ok(!r.hestia.includes('private'))
  assert.ok(r.sophia.includes('old private line 11'))
})

// ─── Fleet view ─────────────────────────────────────────────────────────────

test('fleet: task titles of anonymized assignees are hidden, others stay', () => {
  const node = {
    id: 'kanban:main', type: 'kanban-board', slug: 'main', name: 'Main', description: '', archived: false, dbPath: '/x',
    taskCounts: {}, totalTasks: 2, lastEventAt: 2,
    recentEvents: [
      { id: 1, taskId: 't_a', taskTitle: 'Private task title', assignee: 'hestia', kind: 'created', runId: null, at: 1 },
      { id: 2, taskId: 't_b', taskTitle: 'Public task title', assignee: 'sophia', kind: 'created', runId: null, at: 2 },
      { id: 3, taskId: 't_c', taskTitle: 'No assignee', assignee: null, kind: 'created', runId: null, at: 3 },
    ],
  } as KanbanBoardNode
  const out = applyAnonymization([node], createAnonymizePolicy({ value: 'hestia' }))
  assert.equal(out[0].recentEvents[0].taskTitle, 't_a (title hidden, 18 chars)')
  assert.equal(out[0].recentEvents[1].taskTitle, 'Public task title')
  assert.equal(out[0].recentEvents[2].taskTitle, 'No assignee')
  assert.equal(node.recentEvents[0].taskTitle, 'Private task title', 'the input is not changed')
  assert.equal(applyAnonymization([node], createAnonymizePolicy({ value: 'all' }))[0].recentEvents[2].taskTitle, 'No assignee', 'no assignee: no profile to apply')
  assert.equal(applyAnonymization([node], undefined)[0].recentEvents[0].taskTitle, 'Private task title')
  assert.equal(applyAnonymization([node], createAnonymizePolicy({ value: 'none' }))[0].recentEvents[0].taskTitle, 'Private task title')
})

// ─── CLI flags ──────────────────────────────────────────────────────────────

test('relay flags: --anonymize-content[=value], --show-content', () => {
  assert.equal(parseArgs([]).anonymizeContent, undefined)
  assert.equal(parseArgs(['--anonymize-content']).anonymizeContent, 'all')
  assert.equal(parseArgs(['--anonymize-content=all']).anonymizeContent, 'all')
  assert.equal(parseArgs(['--anonymize-content=none']).anonymizeContent, 'none')
  assert.equal(parseArgs(['--anonymize-content=hestia,sophia']).anonymizeContent, 'hestia,sophia')
  assert.equal(parseArgs(['--anonymize-content', 'hestia', '--no-open']).anonymizeContent, 'hestia')
  assert.equal(parseArgs(['--anonymize-content', '--no-open']).anonymizeContent, 'all')
  assert.equal(parseArgs(['--show-content']).anonymizeContent, 'none')
  assert.equal(parseArgs(['--anonymize-content=all', '--port', '4000']).port, 4000)
})
