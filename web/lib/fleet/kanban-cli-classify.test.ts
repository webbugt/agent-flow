import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { BashUseTracker, bashCommandOf, type BashEventLike } from './bash-blocks'
import { DEFAULT_KANBAN_BOARD, EventUseTracker, kanbanCliUse, type EventUse } from './event-uses'
import { DEFAULT_BOARD_SLUG } from './kanban-source'
import { SingleSessionTracker, buildSingleBlocks } from './single-blocks'
import { defaultOptions } from './options-registry'

const S = 1000
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const NOW = T0
const session = { id: 'hermes-taxis', label: 'taxis' }

type Ev = BashEventLike
const bashEvent = (command: string, agoSec: number, id: string | null, truncate = false): Ev => ({
  time: 0,
  type: 'tool_call_start',
  payload: {
    agent: 'taxis · Plan', tool: 'Bash', ...(id ? { toolUseId: id } : {}),
    args: command.slice(0, 80),
    // The hook path carries the first 80 characters only; the transcript path the full command.
    ...(truncate ? {} : { inputData: { command } }),
    at: T0 - agoSec * S,
  },
})

const kanbanUses = (events: Ev[]): EventUse[] => new EventUseTracker({ kinds: ['kanban'] }).update([session], () => events, NOW)
const bashHeads = (events: Ev[]) => new BashUseTracker().update([session], () => events, NOW).map(n => n.head)

// Fake values only.
const TASK_ID = 't_abc123'
const TITLE = 'Rotate the fake staging widget'
const BODY = 'Fake body: do the quarterly widget audit'

test('default board decision: the code uses the slug `default` (kanban-source.ts), and this module pins it', () => {
  assert.equal(DEFAULT_KANBAN_BOARD, DEFAULT_BOARD_SLUG)
  assert.equal(DEFAULT_KANBAN_BOARD, 'default')
})

test('hermes kanban --board agent-flow show <id>: a kanban use (board, verb), no bash block', () => {
  const events = [bashEvent(`hermes kanban --board agent-flow show ${TASK_ID}`, 5, 'u1')]
  assert.deepEqual(kanbanCliUse(`hermes kanban --board agent-flow show ${TASK_ID}`), { key: 'agent-flow', action: 'show', leading: true })
  const uses = kanbanUses(events)
  assert.equal(uses.length, 1)
  assert.deepEqual([uses[0].kind, uses[0].key, uses[0].action, uses[0].profile], ['kanban', 'agent-flow', 'show', 'taxis'])
  assert.deepEqual(bashHeads(events), [], 'no `hermes` bash block')
})

test('hermes -p taxis kanban --board x list: kanban x, verb list', () => {
  const events = [bashEvent('hermes -p taxis kanban --board x list', 5, 'u1')]
  const uses = kanbanUses(events)
  assert.deepEqual(uses.map(u => [u.key, u.action]), [['x', 'list']])
  assert.deepEqual(bashHeads(events), [])
  assert.deepEqual(kanbanCliUse('hermes --profile taxis kanban --board x list'), { key: 'x', action: 'list', leading: true })
  assert.deepEqual(kanbanCliUse('hermes -p=taxis kanban --board x list'), { key: 'x', action: 'list', leading: true })
})

test('hermes kanban list without --board: the default board (`default`)', () => {
  const events = [bashEvent('hermes kanban list', 5, 'u1')]
  assert.deepEqual(kanbanUses(events).map(u => [u.key, u.action]), [['default', 'list']])
  assert.deepEqual(bashHeads(events), [])
})

test('hermes status and hermes chat stay bash with head hermes, no kanban use', () => {
  for (const cmd of ['hermes status', 'hermes chat -q hi', 'hermes -p taxis gateway status', 'hermes --version']) {
    const events = [bashEvent(cmd, 5, 'u1')]
    assert.equal(kanbanCliUse(cmd), null, cmd)
    assert.deepEqual(kanbanUses(events), [], cmd)
    assert.deepEqual(bashHeads(events), ['hermes'], cmd)
  }
})

test('pipeline: hermes kanban --board x list | grep foo -> kanban x list, no bash block', () => {
  const events = [bashEvent('hermes kanban --board x list | grep foo', 5, 'u1')]
  assert.deepEqual(kanbanUses(events).map(u => [u.key, u.action]), [['x', 'list']])
  assert.deepEqual(bashHeads(events), [])
})

test('chains: classify on the first hermes kanban segment; other segments keep their normal bash head', () => {
  // cmd && hermes kanban: the bash head is the first command, the kanban use is added.
  const chained = [bashEvent('git pull && hermes kanban --board x list', 5, 'u1')]
  assert.deepEqual(kanbanUses(chained).map(u => [u.key, u.action]), [['x', 'list']])
  assert.deepEqual(bashHeads(chained), ['git'])
  assert.equal(kanbanCliUse('git pull && hermes kanban --board x list')!.leading, false)
  // cd <dir> && hermes kanban: `cd` is skipped by the head rule, so the kanban call is the head and replaces the block.
  const cd = [bashEvent('cd /tmp/fake && hermes kanban --board x list', 5, 'u2')]
  assert.deepEqual(kanbanUses(cd).map(u => [u.key, u.action]), [['x', 'list']])
  assert.deepEqual(bashHeads(cd), [])
  // Only the first hermes kanban segment counts.
  assert.deepEqual(kanbanCliUse('hermes kanban --board a list; hermes kanban --board b show'), { key: 'a', action: 'list', leading: true })
  // A non-kanban hermes first keeps its bash block; the later kanban segment still is a kanban use.
  const mixed = [bashEvent('hermes status && hermes kanban --board x list', 5, 'u3')]
  assert.deepEqual(kanbanUses(mixed).map(u => [u.key, u.action]), [['x', 'list']])
  assert.deepEqual(bashHeads(mixed), ['hermes'])
})

test('--board after the verb, --board=slug, hyphenated verbs, wrappers and bash -c', () => {
  assert.deepEqual(kanbanCliUse(`hermes kanban show ${TASK_ID} --board x`), { key: 'x', action: 'show', leading: true })
  assert.deepEqual(kanbanCliUse('hermes kanban --board=x list'), { key: 'x', action: 'list', leading: true })
  assert.deepEqual(kanbanCliUse(`hermes kanban --board x request-review ${TASK_ID}`), { key: 'x', action: 'request_review', leading: true })
  assert.deepEqual(kanbanCliUse('HERMES_HOME=/tmp/fake env hermes kanban --board x list'), { key: 'x', action: 'list', leading: true })
  assert.deepEqual(kanbanCliUse('bash -lc "hermes kanban --board x list"'), { key: 'x', action: 'list', leading: true })
  assert.deepEqual(kanbanCliUse('/usr/local/bin/hermes kanban --board x ls --assignee fake-profile'), { key: 'x', action: 'ls', leading: true })
})

test('not a plain board or verb: not classified (stays bash), nothing is guessed', () => {
  assert.equal(kanbanCliUse('hermes kanban --board "$B" list'), null)
  assert.equal(kanbanCliUse('hermes kanban --board ../etc list'), null)
  assert.equal(kanbanCliUse('hermes kanban --board'), null)
  assert.equal(kanbanCliUse('hermes kanban --board x'), null, 'no verb')
  assert.equal(kanbanCliUse('hermes kanban'), null)
  assert.equal(kanbanCliUse('hermes kanban --help'), null)
  assert.equal(kanbanCliUse('echo hermes kanban --board x list'), null, 'echo is the program')
  assert.equal(kanbanCliUse('grep kanban notes.txt'), null)
  assert.deepEqual(bashHeads([bashEvent('hermes kanban --board "$B" list', 5, 'u1')]), ['hermes'])
})

test('a here-doc body is not read', () => {
  assert.equal(kanbanCliUse('cat > notes.md <<EOF\nhermes kanban --board x list\nEOF'), null)
})

test('duplicate delivery of one toolUseId (hook, then transcript) counts once, in both trackers', () => {
  const cmd = `hermes kanban --board agent-flow comment ${TASK_ID} "${BODY}"`
  const hook = bashEvent(cmd, 5, 'dup', true)
  const transcript = bashEvent(cmd, 5, 'dup')
  for (const events of [[hook, transcript], [transcript, hook], [transcript, transcript]]) {
    assert.equal(kanbanUses(events).length, 1)
    assert.deepEqual(bashHeads(events), [])
  }
})

test('a hook delivery cut before it is classifiable, then the full one: the kanban call replaces the early bash use', () => {
  const full = `hermes kanban --board agent-flow show ${TASK_ID}`
  const cut = bashEvent('hermes kanban --board', 5, 'dup', true)
  const transcript = bashEvent(full, 5, 'dup')
  const tracker = new BashUseTracker()
  const buffer = [cut]
  assert.deepEqual(tracker.update([session], () => buffer, NOW).map(n => n.head), ['hermes'], 'the cut text alone is a hermes command')
  buffer.push(transcript)
  assert.deepEqual(tracker.update([session], () => buffer, NOW), [], 'the full text turns it into a kanban call: the bash use is dropped')
  // Opposite order: the full call first; the cut one cannot come back in as a bash use.
  assert.deepEqual(bashHeads([transcript, cut]), [])
  assert.deepEqual(kanbanUses([cut, transcript]).map(u => [u.key, u.action]), [['agent-flow', 'show']])
})

test('privacy: a task id, title, body or comment never appears in the blocks or their inspection', () => {
  const events: Ev[] = [
    bashEvent(`hermes kanban --board agent-flow show ${TASK_ID}`, 9, 'a'),
    bashEvent(`hermes kanban --board agent-flow create "${TITLE}" --body "${BODY}" --assignee fake-profile`, 8, 'b'),
    bashEvent(`hermes kanban --board agent-flow comment ${TASK_ID} "${BODY}"`, 7, 'c'),
    bashEvent(`hermes kanban --board agent-flow complete ${TASK_ID} --summary "${TITLE}"`, 6, 'd'),
  ]
  const sources = new SingleSessionTracker().update(session, () => events, NOW)
  assert.deepEqual(sources.bash, [], 'no bash node, so no command text is held anywhere')
  const views = buildSingleBlocks({ sources, now: NOW, options: defaultOptions() })
  assert.deepEqual(views.map(v => v.id), ['kanban:agent-flow'])
  assert.equal(views[0].label, 'agent-flow')
  assert.equal(views[0].kind, 'kanban')
  assert.equal(views[0].sublabel, '4 events')
  assert.deepEqual(views[0].inspection.items.map(i => i.action).sort(), ['comment', 'complete', 'create', 'show'])
  const wire = JSON.stringify({ sources, views })
  for (const secret of [TASK_ID, TITLE, BODY, 'fake-profile', 'quarterly']) assert.ok(!wire.includes(secret), `leaked: ${secret}`)
})

test('single view: a hermes kanban shell call is a kanban block and no hermes bash block; hermes status is the bash block', () => {
  const events: Ev[] = [
    bashEvent('hermes kanban --board agent-flow list', 9, 'a'),
    bashEvent('hermes status', 8, 'b'),
  ]
  const views = buildSingleBlocks({ sources: new SingleSessionTracker().update(session, () => events, NOW), now: NOW, options: defaultOptions() })
  assert.deepEqual(views.map(v => v.id).sort(), ['bash:hermes', 'kanban:agent-flow'])
  assert.equal(views.find(v => v.id === 'bash:hermes')!.sublabel, '1 call', 'only `hermes status`')
})

test('bashCommandOf is unchanged (full command, else args)', () => {
  assert.equal(bashCommandOf({ inputData: { command: 'git status' }, args: 'git' }), 'git status')
  assert.equal(bashCommandOf({ args: 'git st' }), 'git st')
  assert.equal(bashCommandOf({ inputData: { command: '  ' }, args: '' }), null)
})
