import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationMessage } from '@/hooks/simulation/types'
import {
  buildSessionItems, pickDefaultAgentId, hasRichInput, toolCopyText, toolCopyAll, toolInputJson,
  formatClock, formatCostUsd, formatOrigin,
} from './session-detail'

let n = 0
const msg = (m: Partial<ConversationMessage> & Pick<ConversationMessage, 'type'>): ConversationMessage => ({
  id: `m${n++}`, content: '', timestamp: n, ...m,
})

test('a tool call and its result with the same id become one item, in order', () => {
  const items = buildSessionItems([
    msg({ type: 'user', content: 'hi' }),
    msg({ type: 'tool_call', toolName: 'Bash', toolUseId: 'a', content: '> Bash ls' }),
    msg({ type: 'tool_call', toolName: 'Bash', toolUseId: 'b', content: '> Bash pwd' }),
    msg({ type: 'tool_result', toolName: 'Bash', toolUseId: 'b', result: '/repo', content: '< /repo' }),
    msg({ type: 'tool_result', toolName: 'Bash', toolUseId: 'a', result: 'x', content: '< x' }),
    msg({ type: 'assistant', content: 'done' }),
  ])
  assert.deepEqual(items.map(i => i.kind), ['message', 'tool', 'tool', 'message'])
  const [, a, b] = items as Array<Extract<(typeof items)[number], { kind: 'tool' }>>
  assert.equal(a.result?.result, 'x')
  assert.equal(b.result?.result, '/repo')
})

test('results without ids pair with the earliest open call of the same tool', () => {
  const items = buildSessionItems([
    msg({ type: 'tool_call', toolName: 'Read', content: '> Read a' }),
    msg({ type: 'tool_call', toolName: 'Bash', content: '> Bash b' }),
    msg({ type: 'tool_result', toolName: 'Bash', result: 'out', content: '< out' }),
  ])
  assert.equal(items.length, 2)
  assert.equal((items[0] as { result?: unknown }).result, undefined)
  assert.equal((items[1] as { result?: ConversationMessage }).result?.result, 'out')
})

test('a call without a result stays open, and a result without a call stands alone', () => {
  const open = buildSessionItems([msg({ type: 'tool_call', toolName: 'Bash', toolUseId: 'z', content: '> Bash sleep' })])
  assert.equal(open.length, 1)
  assert.equal((open[0] as { result?: unknown }).result, undefined)

  const orphan = buildSessionItems([msg({ type: 'tool_result', toolName: 'Bash', toolUseId: 'gone', result: 'late', content: '< late' })])
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0].kind, 'tool')
  assert.equal((orphan[0] as { call?: unknown }).call, undefined)
})

test('empty conversation gives no items', () => {
  assert.deepEqual(buildSessionItems([]), [])
})

test('a duplicate result for an id already paired is kept as its own item, not lost', () => {
  const items = buildSessionItems([
    msg({ type: 'tool_call', toolName: 'Bash', toolUseId: 'a', content: '> Bash x' }),
    msg({ type: 'tool_result', toolName: 'Bash', toolUseId: 'a', result: '1', content: '< 1' }),
    msg({ type: 'tool_result', toolName: 'Bash', toolUseId: 'a', result: '2', content: '< 2' }),
  ])
  assert.equal(items.length, 2)
})

test('default session: newest wall-clock message wins, a session node beats the main node on a tie', () => {
  const agents = new Map([['Taxis', { isMain: true }], ['Taxis · A', { isMain: false }], ['Taxis · B', { isMain: false }]])
  const convs = new Map<string, ConversationMessage[]>([
    ['Taxis · A', [msg({ type: 'user', at: 1000 })]],
    ['Taxis · B', [msg({ type: 'user', at: 5000 })]],
    ['Taxis', [msg({ type: 'user', at: 5000 })]],
  ])
  assert.equal(pickDefaultAgentId(agents, convs), 'Taxis · B')
})

test('default session with no messages: first session node, else the main node, else null', () => {
  const none = new Map<string, ConversationMessage[]>()
  assert.equal(pickDefaultAgentId(new Map([['M', { isMain: true }], ['S', { isMain: false }]]), none), 'S')
  assert.equal(pickDefaultAgentId(new Map([['M', { isMain: true }]]), none), 'M')
  assert.equal(pickDefaultAgentId(new Map(), none), null)
})

test('default session without wall-clock times still picks a node that has messages', () => {
  const agents = new Map([['M', { isMain: true }], ['S', { isMain: false }]])
  const convs = new Map<string, ConversationMessage[]>([['M', [msg({ type: 'user' })]]])
  assert.equal(pickDefaultAgentId(agents, convs), 'M')
})

test('copy text: bash gives the command, edit gives a diff, write gives the content', () => {
  assert.equal(toolCopyText('Bash', { command: 'git status && ls -la' }, 'ignored'), 'git status && ls -la')
  assert.equal(
    toolCopyText('Edit', { file_path: '/a/b.ts', old_string: 'one\ntwo', new_string: 'three' }, ''),
    '--- /a/b.ts\n-one\n-two\n+three',
  )
  // a patch in the new_string with no old text has no "-" lines
  assert.equal(toolCopyText('Edit', { file_path: '/a', old_string: '', new_string: 'x\ny' }, ''), '--- /a\n+x\n+y')
  assert.equal(toolCopyText('Write', { file_path: '/a', content: 'body\nmore' }, ''), 'body\nmore')
})

test('copy text for other tools is the whole input as JSON, then the args, never empty when there is data', () => {
  assert.equal(toolCopyText('kanban_show', { task_id: 't_1' }, 'x'), '{\n  "task_id": "t_1"\n}')
  assert.equal(toolCopyText('kanban_show', {}, 'raw args'), 'raw args')
  assert.equal(toolCopyText('Bash', {}, 'raw args'), 'raw args')
  assert.equal(toolInputJson(undefined), '')
  assert.equal(toolInputJson({}), '')
})

test('rich input: only when the key fields are there, so no tool renders as an empty box', () => {
  assert.equal(hasRichInput('Bash', { command: 'ls' }), true)
  assert.equal(hasRichInput('Bash', { command: '' }), false)
  assert.equal(hasRichInput('Bash', {}), false)
  assert.equal(hasRichInput('Bash', undefined), false)
  assert.equal(hasRichInput('Edit', { file_path: '/a', old_string: '', new_string: 'x' }), true)
  assert.equal(hasRichInput('Edit', { file_path: '/a' }), false)
  assert.equal(hasRichInput('Write', { file_path: '/a', content: '' }), true)
  assert.equal(hasRichInput('kanban_show', { task_id: 't' }), false)
})

test('copy all has the name, the arguments and the result, with the full text', () => {
  const long = 'x'.repeat(50_000)
  const all = toolCopyAll('Bash', { command: 'cat big' }, '', long)
  assert.ok(all.startsWith('# Bash\ncat big\n# result\n'))
  assert.ok(all.endsWith(long))
  assert.equal(toolCopyAll('Bash', { command: 'ls' }, '', undefined), '# Bash\nls')
})

test('formatting: clock, cost and origin', () => {
  assert.equal(formatClock(undefined), '')
  assert.match(formatClock(Date.UTC(2026, 10, 23, 12, 0, 0)), /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(formatCostUsd(0.0042), '$0.0042')
  assert.equal(formatCostUsd(1.2346, true), '~$1.235')
  assert.equal(formatOrigin('Webbugt', 'telegram'), 'Webbugt via telegram')
  assert.equal(formatOrigin(undefined, 'kanban'), 'kanban')
  assert.equal(formatOrigin('Webbugt', undefined), 'Webbugt')
  assert.equal(formatOrigin(), '')
})
