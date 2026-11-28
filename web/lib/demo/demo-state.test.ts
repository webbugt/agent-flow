import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDemoAction, canSubagentReturn, createDemoState, demoNodeChoices, demoSessionId, demoSessionList, demoSources, normaliseProfile,
  normaliseResourceKey, type DemoAction, type DemoState,
} from './demo-state'
import { isDemoPath } from './demo-route'
import { DEMO_PANEL_GAP, DEMO_PANEL_WIDTH, demoPanelInset, shouldPollLiveFleet } from './demo-feed'
import { usesOfCall as rawUsesOfCall } from '@/lib/fleet/event-uses'
import { bashCommandOf, commandHead } from '@/lib/fleet/command-head'

/** What the live reader makes of a tool call: kind and key (the reader adds an action verb the demo does not assert). */
const usesOfCall = (call: { name: string; input: Record<string, unknown> }) => rawUsesOfCall(call).map(({ kind, key }) => ({ kind, key }))

const T0 = 1_800_000_000_000

function run(actions: DemoAction[], start: DemoState = createDemoState(), t0 = T0): DemoState {
  let s = start
  actions.forEach((a, i) => { s = applyDemoAction(s, a, t0 + i * 1000) })
  return s
}

const started = (profile = 'taxis') => run([{ type: 'session_start', profile }])
const id = (profile = 'taxis') => demoSessionId(profile)
const types = (s: DemoState, sessionId: string) => (s.events[sessionId] ?? []).map(e => e.type)

describe('demo-state: session_start', () => {
  it('creates one bridge session per profile, labelled "<profile> · demo", with a main node and a session node', () => {
    const s = started()
    assert.equal(s.sessions.length, 1)
    assert.equal(s.sessions[0].id, 'demo-taxis')
    assert.equal(s.sessions[0].label, 'taxis · demo')
    assert.equal(s.sessions[0].status, 'active')
    assert.deepEqual(types(s, id()), ['agent_spawn', 'agent_spawn'])
    const [main, node] = s.events[id()]
    assert.equal((main.payload as { isMain?: boolean }).isMain, true)
    assert.equal((node.payload as { parent?: string }).parent, 'taxis')
    assert.equal((node.payload as { name?: string }).name, 'taxis s1')
  })

  it('a second start of the same profile adds a node to the same session, not a new tab', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'session_start', profile: 'taxis' }])
    assert.equal(s.sessions.length, 1)
    assert.deepEqual(s.sessions[0].nodes.map(n => n.name), ['taxis s1', 'taxis s2'])
    assert.deepEqual(types(s, id()), ['agent_spawn', 'agent_spawn', 'agent_spawn'])
  })

  it('different profiles get separate sessions', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'session_start', profile: 'sophia' }])
    assert.deepEqual(demoSessionList(s).map(x => x.id), ['demo-taxis', 'demo-sophia'])
  })

  it('normalises the profile name and rejects unusable ones (same state object)', () => {
    assert.equal(normaliseProfile('  Taxis '), 'taxis')
    assert.equal(normaliseProfile('bad name!'), null)
    assert.equal(normaliseProfile(''), null)
    const s = createDemoState()
    assert.equal(applyDemoAction(s, { type: 'session_start', profile: 'a b' }, T0), s)
  })
})

describe('demo-state: tool_call / tool_return', () => {
  it('tool_call emits tool_call_start with agent, tool, id and args', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'tool_call', sessionId: id(), tool: 'Bash', args: 'ls -la' }])
    const ev = s.events[id()].at(-1)!
    assert.equal(ev.type, 'tool_call_start')
    const p = ev.payload as Record<string, unknown>
    assert.equal(p.agent, 'taxis s1')
    assert.equal(p.tool, 'Bash')
    assert.equal(p.args, 'ls -la')
    assert.deepEqual(p.inputData, { command: 'ls -la' })
    assert.ok(typeof p.toolUseId === 'string' && (p.toolUseId as string).length > 0)
    assert.equal(s.sessions[0].nodes[0].open.length, 1)
  })

  it('uses a default argument when none is given, and truncates long arguments', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'tool_call', sessionId: id(), tool: 'Read' }, { type: 'tool_call', sessionId: id(), tool: 'Grep', args: 'x'.repeat(1000) }])
    const [a, b] = s.events[id()].slice(-2).map(e => e.payload as { args: string })
    assert.ok(a.args.length > 0)
    assert.equal(b.args.length, 200)
  })

  it('tool_return closes the oldest open call with the same toolUseId, ok or error', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' },
      { type: 'tool_call', sessionId: id(), tool: 'Read' },
      { type: 'tool_call', sessionId: id(), tool: 'Edit' },
      { type: 'tool_return', sessionId: id() },
      { type: 'tool_return', sessionId: id(), isError: true },
    ])
    const evs = s.events[id()]
    const starts = evs.filter(e => e.type === 'tool_call_start').map(e => (e.payload as { toolUseId: string }).toolUseId)
    const ends = evs.filter(e => e.type === 'tool_call_end')
    assert.deepEqual(ends.map(e => (e.payload as { toolUseId: string }).toolUseId), starts)
    assert.deepEqual(ends.map(e => (e.payload as { isError: boolean }).isError), [false, true])
    assert.equal(s.sessions[0].nodes[0].open.length, 0)
  })

  it('tool_return with nothing open, unknown session, or bad tool name changes nothing', () => {
    const s = started()
    assert.equal(applyDemoAction(s, { type: 'tool_return', sessionId: id() }, T0), s)
    assert.equal(applyDemoAction(s, { type: 'tool_call', sessionId: 'demo-nobody', tool: 'Read' }, T0), s)
    assert.equal(applyDemoAction(s, { type: 'tool_call', sessionId: id(), tool: 'bad tool;' }, T0), s)
  })

  it('event times are seconds since the session started and never negative', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'tool_call', sessionId: id(), tool: 'Read' }])
    assert.equal(s.events[id()].at(-1)!.time, 1)
    const early = applyDemoAction(started(), { type: 'tool_call', sessionId: id(), tool: 'Read' }, T0 - 5000)
    assert.equal(early.events[id()].at(-1)!.time, 0)
  })

  it('one time base per session: a subagent dispatched later does not restart the clock', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' },                                 // t=0
      { type: 'subagent_dispatch', sessionId: id() },                              // +1s
      { type: 'tool_call', sessionId: id(), node: 'taxis s1 › sub1', tool: 'Read' }, // +2s, on the subagent
      { type: 'tool_call', sessionId: id(), node: 'taxis s1', tool: 'Read' },       // +3s, on the parent
    ])
    const calls = s.events[id()].filter(e => e.type === 'tool_call_start').map(e => e.time)
    assert.deepEqual(calls, [2, 3])
    const times = s.events[id()].map(e => e.time)
    assert.deepEqual([...times].sort((a, b) => a - b), times)
  })

  it('call ids are unique', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, ...Array.from({ length: 5 }, () => ({ type: 'tool_call', sessionId: id(), tool: 'Read' }) as DemoAction)])
    const ids = s.events[id()].filter(e => e.type === 'tool_call_start').map(e => (e.payload as { toolUseId: string }).toolUseId)
    assert.equal(new Set(ids).size, 5)
  })
})

describe('demo-state: permission_wait, subagents, done', () => {
  it('permission_wait emits permission_requested for the node', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'permission_wait', sessionId: id() }])
    const ev = s.events[id()].at(-1)!
    assert.equal(ev.type, 'permission_requested')
    assert.equal((ev.payload as { agent: string }).agent, 'taxis s1')
  })

  it('subagent_dispatch spawns a child node under the parent and emits subagent_dispatch', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() }])
    assert.deepEqual(s.events[id()].slice(-2).map(e => e.type), ['agent_spawn', 'subagent_dispatch'])
    const child = s.sessions[0].nodes[1]
    assert.equal(child.kind, 'subagent')
    assert.equal(child.parent, 'taxis s1')
    assert.equal((s.events[id()].at(-2)!.payload as { parent: string }).parent, 'taxis s1')
  })

  it('subagent_return finishes the newest active child and emits subagent_return + agent_complete', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() }, { type: 'subagent_return', sessionId: id() }])
    assert.deepEqual(s.events[id()].slice(-2).map(e => e.type), ['subagent_return', 'agent_complete'])
    assert.equal(s.sessions[0].nodes[1].status, 'done')
    assert.equal(s.sessions[0].status, 'active')
  })

  it('subagent_return with no active child changes nothing', () => {
    const s = started()
    assert.equal(applyDemoAction(s, { type: 'subagent_return', sessionId: id() }, T0), s)
    assert.equal(canSubagentReturn(s, id()), false)
  })

  it('subagent_return aimed at the subagent itself returns that subagent to its parent', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() },
      { type: 'subagent_return', sessionId: id(), node: 'taxis s1 › sub1' },
    ])
    assert.deepEqual(s.events[id()].slice(-2).map(e => e.type), ['subagent_return', 'agent_complete'])
    assert.deepEqual(s.events[id()].at(-2)!.payload, { parent: 'taxis s1', child: 'taxis s1 › sub1', summary: 'taxis s1 › sub1 finished (demo)' })
    assert.equal((s.events[id()].at(-1)!.payload as { name: string }).name, 'taxis s1 › sub1')
    assert.equal(s.sessions[0].nodes[1].status, 'done')
    assert.equal(s.sessions[0].nodes[0].status, 'active')
    assert.equal(s.sessions[0].status, 'active')
  })

  it('panel flow: dispatch, then return with the target the panel picks (the new subagent), changes state', () => {
    const dispatched = run([{ type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() }])
    // demoNodeChoices lists nodes in order; the panel defaults to the newest active node of the open tab: the subagent.
    const picked = demoNodeChoices(dispatched).filter(c => c.status === 'active' && c.sessionId === id()).at(-1)!
    assert.equal(picked.node, 'taxis s1 › sub1')
    assert.equal(canSubagentReturn(dispatched, picked.sessionId, picked.node), true)
    const returned = applyDemoAction(dispatched, { type: 'subagent_return', sessionId: picked.sessionId, node: picked.node }, T0 + 5000)
    assert.notEqual(returned, dispatched)
    assert.equal(returned.sessions[0].nodes[1].status, 'done')
    assert.equal(canSubagentReturn(returned, id()), false)
  })

  it('a returning subagent takes its own active subagents with it', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() },
      { type: 'subagent_dispatch', sessionId: id(), node: 'taxis s1 › sub1' },
      { type: 'subagent_return', sessionId: id(), node: 'taxis s1 › sub1' },
    ])
    const nodes = Object.fromEntries(s.sessions[0].nodes.map(n => [n.name, n.status]))
    assert.deepEqual(nodes, { 'taxis s1': 'active', 'taxis s1 › sub1': 'done', 'taxis s1 › sub1 › sub1': 'done' })
  })

  it('the target of a tool call can be a subagent', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() },
      { type: 'tool_call', sessionId: id(), node: 'taxis s1 › sub1', tool: 'Read' },
    ])
    assert.equal((s.events[id()].at(-1)!.payload as { agent: string }).agent, 'taxis s1 › sub1')
  })

  it('done completes the node; the last node completing completes the session (main complete event too)', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'done', sessionId: id() }])
    assert.deepEqual(s.events[id()].slice(-2).map(e => e.type), ['agent_complete', 'agent_complete'])
    assert.equal(s.sessions[0].status, 'completed')
    // an agent cannot act once done
    assert.equal(applyDemoAction(s, { type: 'tool_call', sessionId: id(), tool: 'Read' }, T0), s)
  })

  it('done of a parent finishes its children and keeps another session node alive', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' }, { type: 'session_start', profile: 'taxis' },
      { type: 'subagent_dispatch', sessionId: id(), node: 'taxis s1' },
      { type: 'done', sessionId: id(), node: 'taxis s1' },
    ])
    const nodes = Object.fromEntries(s.sessions[0].nodes.map(n => [n.name, n.status]))
    assert.deepEqual(nodes, { 'taxis s1': 'done', 'taxis s2': 'active', 'taxis s1 › sub1': 'done' })
    assert.equal(s.sessions[0].status, 'active')
  })

  it('a completed profile that starts again is announced again and reactivated', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'done', sessionId: id() }, { type: 'session_start', profile: 'taxis' }])
    assert.equal(s.sessions[0].status, 'active')
    assert.equal(s.events[id()].filter(e => e.type === 'agent_spawn' && (e.payload as { isMain?: boolean }).isMain).length, 2)
  })
})

describe('demo-state: resources', () => {
  const base = () => started()

  it('kanban: add registers the board, a node appears, and the use is a tool call the live reader recognises', () => {
    const s = applyDemoAction(base(), { type: 'resource_add', kind: 'kanban', key: 'demo-board', sessionId: id(), node: 'taxis s1' }, T0 + 1000)
    assert.deepEqual(s.resources, [{ kind: 'kanban', key: 'demo-board' }])
    assert.equal(s.kanban.length, 1)
    assert.equal(s.kanban[0].slug, 'demo-board')
    assert.equal(s.kanban[0].recentEvents.length, 1)
    assert.equal(s.kanban[0].recentEvents[0].assignee, 'taxis')
    const start = s.events[id()].find(e => e.type === 'tool_call_start')!
    const p = start.payload as { tool: string; inputData: Record<string, unknown> }
    assert.deepEqual(usesOfCall({ name: p.tool, input: p.inputData }), [{ kind: 'kanban', key: 'demo-board' }])
    assert.deepEqual(types(s, id()).slice(-2), ['tool_call_start', 'tool_call_end'])
  })

  it('memory: add registers a namespace; store/search/forget counts and the live reader agree on the tag', () => {
    let s = applyDemoAction(base(), { type: 'resource_add', kind: 'memory', key: 'demo_memory', sessionId: id(), call: 'store' }, T0 + 1000)
    s = applyDemoAction(s, { type: 'resource_use', sessionId: id(), kind: 'memory', key: 'demo_memory', call: 'search' }, T0 + 2000)
    s = applyDemoAction(s, { type: 'resource_use', sessionId: id(), kind: 'memory', key: 'demo_memory', call: 'forget' }, T0 + 3000)
    const n = s.supermemory[0]
    assert.equal(n.containerTag, 'demo_memory')
    assert.deepEqual(n.counts, { store: 1, search: 1, forget: 1 })
    assert.equal(n.total, 3)
    assert.deepEqual(n.byProfile.taxis, { store: 1, search: 1, forget: 1 })
    const starts = s.events[id()].filter(e => e.type === 'tool_call_start').map(e => e.payload as { tool: string; inputData: Record<string, unknown> })
    assert.deepEqual(starts.map(p => p.tool), ['supermemory_store', 'supermemory_search', 'supermemory_forget'])
    for (const p of starts) assert.deepEqual(usesOfCall({ name: p.tool, input: p.inputData }), [{ kind: 'memory', key: 'demo_memory' }])
  })

  it('bash: the use is a Bash call whose command head is the key', () => {
    const s = applyDemoAction(base(), { type: 'resource_add', kind: 'bash', key: 'git', sessionId: id() }, T0 + 1000)
    const ev = s.events[id()].find(e => e.type === 'tool_call_start')!
    const p = ev.payload as { tool: string; inputData: Record<string, unknown> }
    assert.equal(p.tool, 'Bash')
    // Bash heads have their own reader (bash-blocks): it takes the command from the payload and cuts the head.
    const command = bashCommandOf(ev.payload)
    assert.ok(command !== null)
    assert.equal(commandHead(command!), 'git')
  })

  it('subsystem: cron is a cronjob_manage call; gateway is a message with a platform', () => {
    let s = applyDemoAction(base(), { type: 'resource_add', kind: 'subsystem', key: 'cron', sessionId: id() }, T0 + 1000)
    const p = s.events[id()].find(e => e.type === 'tool_call_start')!.payload as { tool: string; inputData: Record<string, unknown> }
    assert.deepEqual(usesOfCall({ name: p.tool, input: p.inputData }), [{ kind: 'subsystem', key: 'cron' }])
    s = applyDemoAction(s, { type: 'resource_add', kind: 'subsystem', key: 'gateway', sessionId: id() }, T0 + 2000)
    assert.equal(s.events[id()].at(-1)!.type, 'message')
    assert.deepEqual(s.resources.map(r => r.key), ['cron', 'gateway'])
  })

  it('add without a session only registers; adding the same resource again is a no-op', () => {
    const s = applyDemoAction(base(), { type: 'resource_add', kind: 'kanban', key: 'b1' }, T0)
    assert.equal(s.events[id()].length, 2)
    assert.equal(s.kanban.length, 1)
    assert.equal(applyDemoAction(s, { type: 'resource_add', kind: 'kanban', key: 'b1' }, T0), s)
  })

  it('adding again with a session registers once and uses twice', () => {
    let s = applyDemoAction(base(), { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: id() }, T0 + 1000)
    s = applyDemoAction(s, { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: id() }, T0 + 2000)
    assert.equal(s.resources.length, 1)
    assert.equal(s.kanban[0].recentEvents.length, 2)
  })

  it('a failed add with an unknown session registers nothing', () => {
    const s = base()
    assert.equal(applyDemoAction(s, { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: 'demo-nobody' }, T0), s)
  })

  it('resource_use of an unregistered resource changes nothing', () => {
    const s = base()
    assert.equal(applyDemoAction(s, { type: 'resource_use', sessionId: id(), kind: 'kanban', key: 'b1' }, T0), s)
  })

  it('resource_remove drops the node and the registration; events already drawn stay', () => {
    let s = applyDemoAction(base(), { type: 'resource_add', kind: 'memory', key: 'm1', sessionId: id() }, T0 + 1000)
    const before = s.events[id()].length
    s = applyDemoAction(s, { type: 'resource_remove', kind: 'memory', key: 'm1' }, T0 + 2000)
    assert.deepEqual(s.resources, [])
    assert.deepEqual(s.supermemory, [])
    assert.equal(s.events[id()].length, before)
    assert.equal(applyDemoAction(s, { type: 'resource_remove', kind: 'memory', key: 'm1' }, T0), s)
  })

  it('keys the live readers would not draw are refused', () => {
    assert.equal(normaliseResourceKey('kanban', 'Bad Board!'), null)
    assert.equal(normaliseResourceKey('kanban', ''), null)
    assert.equal(normaliseResourceKey('memory', 'personal_notes'), null, 'personal containers are never drawn')
    assert.equal(normaliseResourceKey('bash', 'rm -rf'), null)
    assert.equal(normaliseResourceKey('subsystem', 'weather'), null)
    assert.equal(normaliseResourceKey('subsystem', 'CRON'), 'cron')
    assert.equal(normaliseResourceKey('nope' as never, 'x'), null)
    const s = base()
    assert.equal(applyDemoAction(s, { type: 'resource_add', kind: 'kanban', key: 'Bad Board!' }, T0), s)
  })

  it('carries names only: no event payload holds task text or memory content', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' },
      { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: id() },
      { type: 'resource_add', kind: 'memory', key: 'm1', sessionId: id(), call: 'store' },
    ])
    const text = JSON.stringify(s.events[id()].filter(e => e.type.startsWith('tool_call')))
    assert.ok(!/"query"|"content"|"memory"|"title"/.test(text))
  })

  it('demoSources exposes the boards and namespaces in the /api/fleet shape', () => {
    const s = run([
      { type: 'session_start', profile: 'taxis' },
      { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: id() },
      { type: 'resource_add', kind: 'memory', key: 'm1', sessionId: id() },
    ])
    const src = demoSources(s)
    assert.equal(src.kanban.length, 1)
    assert.equal(src.supermemory.length, 1)
  })
})

describe('demo-state: reset, purity, determinism', () => {
  it('reset returns an empty state', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: id() }, { type: 'reset' }])
    assert.deepEqual(s, createDemoState())
  })

  it('does not mutate its input state', () => {
    const s0 = run([{ type: 'session_start', profile: 'taxis' }, { type: 'tool_call', sessionId: id(), tool: 'Read' }])
    const frozen = JSON.stringify(s0)
    applyDemoAction(s0, { type: 'tool_return', sessionId: id() }, T0 + 5000)
    applyDemoAction(s0, { type: 'resource_add', kind: 'kanban', key: 'b1', sessionId: id() }, T0 + 5000)
    applyDemoAction(s0, { type: 'done', sessionId: id() }, T0 + 5000)
    assert.equal(JSON.stringify(s0), frozen)
  })

  it('the same actions at the same times give the same state', () => {
    const acts: DemoAction[] = [
      { type: 'session_start', profile: 'taxis' }, { type: 'tool_call', sessionId: id(), tool: 'Bash' },
      { type: 'resource_add', kind: 'memory', key: 'm1', sessionId: id() }, { type: 'tool_return', sessionId: id() },
    ]
    assert.deepEqual(run(acts), run(acts))
  })

  it('every session event carries its own session id', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'session_start', profile: 'sophia' }, { type: 'tool_call', sessionId: 'demo-sophia', tool: 'Read' }])
    for (const [sid, evs] of Object.entries(s.events)) for (const e of evs) assert.equal(e.sessionId, sid)
  })

  it('demoNodeChoices lists every node with a `<session>::<node>` value', () => {
    const s = run([{ type: 'session_start', profile: 'taxis' }, { type: 'subagent_dispatch', sessionId: id() }])
    assert.deepEqual(demoNodeChoices(s).map(c => c.value), ['demo-taxis::taxis s1', 'demo-taxis::taxis s1 › sub1'])
  })
})

describe('demo route helpers', () => {
  it('isDemoPath matches /demo and /demo/ only, ignoring query and fragment', () => {
    for (const p of ['/demo', '/demo/', '/demo?x=1', '/demo#a']) assert.equal(isDemoPath(p), true, p)
    for (const p of ['/', '/demos', '/demo/x', '/demo.js', '/api/demo', '']) assert.equal(isDemoPath(p), false, p)
  })

  it('the map keeps the open panel\'s width free, nothing when it is folded or the screen is too narrow', () => {
    assert.equal(demoPanelInset(true, 1440), DEMO_PANEL_WIDTH + DEMO_PANEL_GAP)
    assert.equal(demoPanelInset(false, 1440), 0)
    assert.equal(demoPanelInset(true, 390), 0, 'on a phone the panel overlays the map')
    assert.equal(demoPanelInset(true, DEMO_PANEL_WIDTH + DEMO_PANEL_GAP + 280), DEMO_PANEL_WIDTH + DEMO_PANEL_GAP)
    assert.equal(demoPanelInset(true, DEMO_PANEL_WIDTH + DEMO_PANEL_GAP + 279), 0)
  })

  it('the live /api/fleet poll is off in the demo and on in live mode only', () => {
    assert.equal(shouldPollLiveFleet({ showFleet: true, useMockData: false, demo: true }), false)
    assert.equal(shouldPollLiveFleet({ showFleet: true, useMockData: false, demo: false }), true)
    assert.equal(shouldPollLiveFleet({ showFleet: false, useMockData: false, demo: false }), false)
    assert.equal(shouldPollLiveFleet({ showFleet: true, useMockData: true, demo: false }), false)
  })
})
