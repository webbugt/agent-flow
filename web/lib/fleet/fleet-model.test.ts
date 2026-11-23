import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  allSelectionIds, buildFleetRows, computeAxis, createFleetFixture, formatTick, groupColor, groupInstances,
  identityFromLabel, instancesFromSessions, kanbanMarkerKind, latestInstance, mergeSpans, niceTicks, DAY_MS,
  KANBAN_SECTION_ID, SUPERMEMORY_SECTION_ID, type FleetRow, type FleetInstance,
} from './fleet-model'
import { selectNone, setMany } from './fleet-selection'
import type { KanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000

const view = (off: ReadonlySet<string>) => ({ isSelected: (id: string) => !off.has(id) })
const none = new Set<string>()
const row = (rows: FleetRow[], key: string) => {
  const r = rows.find(x => x.key === key)
  assert.ok(r, `row ${key} missing`)
  return r
}

function board(slug: string, events: Array<[number, string, number]>): KanbanBoardNode {
  return {
    id: `kanban:${slug}`, type: 'kanban-board', slug, name: slug, description: '', archived: false, dbPath: '/x',
    taskCounts: { running: 1, blocked: 0, done: 2 }, totalTasks: 3,
    recentEvents: events.map(([id, kind, at]) => ({ id, taskId: `t_${id}`, taskTitle: `task ${id}`, assignee: null, kind, runId: null, at })),
    lastEventAt: events.length ? Math.max(...events.map(e => e[2])) : null,
  }
}

function space(tag: string, days: Array<[string, number]>): SupermemoryNamespaceNode {
  const daily = days.map(([day, store]) => ({ day, store, search: 0, forget: 0 }))
  const total = days.reduce((n, d) => n + d[1], 0)
  return {
    id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag,
    counts: { store: total, search: 0, forget: 0 }, total, byProfile: {}, daily, lastEventAt: null,
  }
}

// ─── Grouping ────────────────────────────────────────────────────────────────

test('identityFromLabel takes the leading profile name', () => {
  assert.equal(identityFromLabel('Taxis · fix login'), 'taxis')
  assert.equal(identityFromLabel('sophia: weekly review'), 'sophia')
  assert.equal(identityFromLabel('hestia - groceries'), 'hestia')
  assert.equal(identityFromLabel('hestia'), 'hestia')
  assert.equal(identityFromLabel(''), 'unknown')
  assert.equal(identityFromLabel(undefined), 'unknown')
})

test('fixture groups into 3 groups / 5 instances, copies stay in their own group', () => {
  const fixture = createFleetFixture(NOW)
  const groups = groupInstances(fixture)
  assert.deepEqual(groups.map(g => [g.identity, g.instances.length]), [['taxis', 2], ['sophia', 2], ['hestia', 1]])
  for (const g of groups) assert.ok(g.instances.every(i => i.identity === g.identity))
  assert.equal(groups.reduce((n, g) => n + g.instances.length, 0), 5)
})

test('groups get distinct colours, independent of start order', () => {
  const fixture = createFleetFixture(NOW)
  const colors = groupInstances(fixture).map(g => g.color)
  assert.equal(new Set(colors).size, colors.length)
  const reversed = groupInstances([...fixture].reverse())
  for (const g of groupInstances(fixture)) assert.equal(reversed.find(r => r.identity === g.identity)?.color, g.color)
  // more groups than palette slots still returns a colour for each
  const many = Array.from({ length: 20 }, (_, i) => ({ ...fixture[0], id: `i${i}`, identity: `agent${i}` }))
  assert.equal(groupInstances(many).length, 20)
})

test('group colour is stable per identity and shared by copies', () => {
  assert.equal(groupColor('taxis'), groupColor('taxis'))
  const rows = buildFleetRows({ instances: createFleetFixture(NOW), selection: view(none), expanded: new Set(['taxis']), now: NOW })
  assert.equal(row(rows, 'taxis-1').color, row(rows, 'group:taxis').color)
  assert.equal(row(rows, 'taxis-2').color, row(rows, 'group:taxis').color)
})

test('instancesFromSessions maps bridge sessions', () => {
  const out = instancesFromSessions([
    { id: 's1', label: 'taxis · a', status: 'completed', startTime: 100, lastActivityTime: 500 },
    { id: 's2', label: 'taxis · b', status: 'active', startTime: 200, lastActivityTime: 600 },
  ])
  assert.equal(out[0].endTime, 500)
  assert.equal(out[1].endTime, undefined)
  assert.equal(groupInstances(out).length, 1)
})

// ─── Rows: badges, expand, selection ────────────────────────────────────────

test('count badge only on multi-copy groups; expansion adds copy rows beneath', () => {
  const instances = createFleetFixture(NOW)
  const collapsed = buildFleetRows({ instances, selection: view(none), expanded: new Set(), now: NOW })
  assert.deepEqual(collapsed.map(r => r.key), ['group:taxis', 'group:sophia', 'group:hestia'])
  assert.equal(row(collapsed, 'group:taxis').badge, 'x2')
  assert.equal(row(collapsed, 'group:hestia').badge, undefined)
  assert.equal(row(collapsed, 'group:hestia').expandable, false)

  const open = buildFleetRows({ instances, selection: view(none), expanded: new Set(['taxis', 'hestia']), now: NOW })
  assert.deepEqual(open.map(r => r.key), ['group:taxis', 'taxis-1', 'taxis-2', 'group:sophia', 'group:hestia'])
  assert.equal(row(open, 'taxis-1').depth, 1)
  assert.equal(row(open, 'group:taxis').expanded, true)
})

test('toggling each instance hides/shows the right lane only', () => {
  const instances = createFleetFixture(NOW)
  const expanded = new Set(['taxis', 'sophia'])
  const base = buildFleetRows({ instances, selection: view(none), expanded, now: NOW })
  for (const inst of instances) {
    const off = setMany(none, [inst.id], false)
    const rows = buildFleetRows({ instances, selection: view(off), expanded, now: NOW })
    for (const r of rows.filter(x => x.kind === 'instance')) {
      assert.equal(r.hidden, r.key === inst.id, `${r.key} hidden state when ${inst.id} is off`)
      assert.equal(r.spans.length === 0, r.key === inst.id)
      assert.equal(r.checked, r.key !== inst.id)
    }
    // Other groups' rows are byte-identical to the all-selected case.
    for (const g of groupInstances(instances).filter(g => g.identity !== inst.identity)) {
      assert.deepEqual(row(rows, g.id), row(base, g.id))
    }
  }
})

test('group checkbox state: checked, indeterminate, unchecked; group data follows its own copies', () => {
  const instances = createFleetFixture(NOW)
  const one = buildFleetRows({ instances, selection: view(new Set(['taxis-1'])), expanded: new Set(), now: NOW })
  const g = row(one, 'group:taxis')
  assert.equal(g.checked, false)
  assert.equal(g.indeterminate, true)
  assert.equal(g.hidden, false)
  // only taxis-2 contributes: its span, its markers, nothing of taxis-1 or sophia
  assert.deepEqual(g.markers.map(m => m.id), ['taxis-2:t0', 'taxis-2:t1', 'taxis-2:t2', 'taxis-2:t3'])
  assert.equal(g.spans.length, 1)
  assert.equal(g.spans[0].start, NOW - 35 * MIN)

  const both = buildFleetRows({ instances, selection: view(new Set(['taxis-1', 'taxis-2'])), expanded: new Set(), now: NOW })
  const hidden = row(both, 'group:taxis')
  assert.equal(hidden.hidden, true)
  assert.equal(hidden.checked, false)
  assert.equal(hidden.indeterminate, false)
  assert.deepEqual(hidden.spans, [])
  assert.deepEqual(hidden.markers, [])
})

test('group lane merges overlapping copies into one span', () => {
  const rows = buildFleetRows({ instances: createFleetFixture(NOW), selection: view(none), expanded: new Set(), now: NOW })
  const taxis = row(rows, 'group:taxis')
  // taxis-1: -50..-20, taxis-2: -35..running -> one merged -50..now
  assert.equal(taxis.spans.length, 1)
  assert.equal(taxis.spans[0].start, NOW - 50 * MIN)
  assert.equal(taxis.spans[0].end, NOW)
  const sophia = row(rows, 'group:sophia')
  // sophia-1: -45..-30, sophia-2: -28..-12 -> two disjoint spans
  assert.equal(sophia.spans.length, 2)
})

test('mergeSpans closes open spans at now and keeps disjoint ones apart', () => {
  const out = mergeSpans([{ start: 10 }, { start: 0, end: 5 }, { start: 4, end: 8 }], 100)
  assert.deepEqual(out.map(s => [s.start, s.end]), [[0, 8], [10, 100]])
})

test('mergeSpans keeps the error status of any overlapping copy, whichever comes first', () => {
  const errFirst = mergeSpans([
    { start: 0, end: 10, status: 'error' }, { start: 5, end: 20, status: 'completed' },
  ], 100)
  assert.deepEqual(errFirst, [{ start: 0, end: 20, status: 'error' }])
  const errLater = mergeSpans([
    { start: 0, end: 10, status: 'completed' }, { start: 5, end: 20, status: 'error' },
    { start: 6, end: 7, status: 'active' },
  ], 100)
  assert.deepEqual(errLater, [{ start: 0, end: 20, status: 'error' }])
  // disjoint spans keep their own status; active outranks completed
  assert.deepEqual(mergeSpans([
    { start: 0, end: 5, status: 'error' }, { start: 10, end: 20, status: 'completed' }, { start: 15, end: 30, status: 'active' },
  ], 100).map(s => s.status), ['error', 'active'])
})

// ─── Kanban + Supermemory lanes ─────────────────────────────────────────────

test('kanban marker kinds map to created/started/blocked/completed; noise is dropped', () => {
  assert.equal(kanbanMarkerKind('created'), 'created')
  assert.equal(kanbanMarkerKind('claimed'), 'started')
  assert.equal(kanbanMarkerKind('spawned'), 'started')
  assert.equal(kanbanMarkerKind('blocked'), 'blocked')
  assert.equal(kanbanMarkerKind('completed'), 'completed')
  assert.equal(kanbanMarkerKind('heartbeat'), null)
})

test('kanban boards become lanes; heartbeats dropped; events sorted oldest first; deselect hides', () => {
  const kanban = [board('alpha', [[3, 'completed', NOW - MIN], [2, 'heartbeat', NOW - 2 * MIN], [1, 'created', NOW - 9 * MIN]]), board('beta', [[1, 'created', NOW - 100 * MIN]])]
  const rows = buildFleetRows({ instances: [], kanban, selection: view(none), expanded: new Set(), now: NOW })
  assert.deepEqual(rows.map(r => r.key), [KANBAN_SECTION_ID, 'kanban:alpha', 'kanban:beta'])
  assert.deepEqual(row(rows, 'kanban:alpha').markers.map(m => m.kind), ['created', 'completed'])
  assert.equal(row(rows, 'kanban:alpha').depth, 1)

  const off = buildFleetRows({ instances: [], kanban, selection: view(new Set(['kanban:alpha'])), expanded: new Set(), now: NOW })
  assert.equal(row(off, 'kanban:alpha').hidden, true)
  assert.deepEqual(row(off, 'kanban:alpha').markers, [])
  assert.equal(row(off, 'kanban:beta').markers.length, 1)
  assert.equal(row(off, KANBAN_SECTION_ID).indeterminate, true)
})

test('supermemory namespaces become day-bucket lanes with relative intensity', () => {
  const supermemory = [space('omh_family', [['2026-11-22', 2], ['2026-11-23', 8]]), space('matrix_org', [['2026-11-23', 1]])]
  const rows = buildFleetRows({ instances: [], supermemory, selection: view(none), expanded: new Set(), now: NOW })
  assert.deepEqual(rows.map(r => r.key), [SUPERMEMORY_SECTION_ID, 'supermemory:matrix_org', 'supermemory:omh_family'])
  const fam = row(rows, 'supermemory:omh_family')
  assert.equal(fam.spans.length, 2)
  assert.equal(fam.spans[1].intensity, 1)
  assert.equal(fam.spans[0].intensity, 0.25)
  assert.equal(fam.spans[1].start, Date.UTC(2026, 10, 23))
  assert.equal(fam.spans[1].end, Date.UTC(2026, 10, 23) + DAY_MS)
})

test('lanes from different sources never mix data', () => {
  const rows = buildFleetRows({
    instances: createFleetFixture(NOW),
    kanban: [board('alpha', [[1, 'created', NOW - MIN]])],
    supermemory: [space('omh_family', [['2026-11-23', 3]])],
    selection: view(none), expanded: new Set(), now: NOW,
  })
  for (const r of rows.filter(x => x.key.startsWith('group:'))) assert.ok(r.markers.every(m => m.kind === 'tool_call'))
  assert.ok(row(rows, 'kanban:alpha').markers.every(m => m.kind !== 'tool_call'))
  assert.deepEqual(row(rows, 'supermemory:omh_family').markers, [])
})

// ─── All / None ─────────────────────────────────────────────────────────────

test('allSelectionIds + None hides every row, All restores them', () => {
  const input = {
    instances: createFleetFixture(NOW),
    kanban: [board('alpha', [[1, 'created', NOW - MIN]])],
    supermemory: [space('omh_family', [['2026-11-23', 3]])],
  }
  const ids = allSelectionIds(input)
  assert.equal(ids.length, 7)
  const off = selectNone(none, ids)
  const rows = buildFleetRows({ ...input, selection: view(off), expanded: new Set(), now: NOW })
  assert.ok(rows.every(r => r.hidden && !r.checked && r.spans.length === 0 && r.markers.length === 0))
  assert.equal(computeAxis(rows, NOW), null)
})

// ─── Shared axis ────────────────────────────────────────────────────────────

test('one axis spans all visible rows and shrinks when an agent is deselected', () => {
  const instances = createFleetFixture(NOW)
  const all = computeAxis(buildFleetRows({ instances, selection: view(none), expanded: new Set(), now: NOW }), NOW)
  assert.ok(all)
  assert.equal(all.min, NOW - 50 * MIN)
  assert.equal(all.max, NOW)

  const noTaxis = computeAxis(buildFleetRows({ instances, selection: view(new Set(['taxis-1', 'taxis-2'])), expanded: new Set(), now: NOW }), NOW)
  assert.ok(noTaxis)
  assert.equal(noTaxis.min, NOW - 45 * MIN)
})

test('axis includes kanban markers and supermemory day spans on the same scale', () => {
  const rows = buildFleetRows({
    instances: createFleetFixture(NOW),
    kanban: [board('alpha', [[1, 'created', NOW - 3 * DAY_MS]])],
    supermemory: [space('omh_family', [['2026-11-23', 3]])],
    selection: view(none), expanded: new Set(), now: NOW,
  })
  const axis = computeAxis(rows, NOW)
  assert.ok(axis)
  assert.equal(axis.min, NOW - 3 * DAY_MS)
  assert.equal(axis.max, Date.UTC(2026, 10, 24)) // end of the supermemory day bucket
})

test('niceTicks picks a readable step and ticks stay inside the range', () => {
  const { ticks, step } = niceTicks(NOW - 50 * MIN, NOW)
  assert.equal(step, 10 * MIN)
  assert.ok(ticks.length >= 4 && ticks.length <= 7)
  assert.ok(ticks.every(t => t >= NOW - 50 * MIN && t <= NOW && t % step === 0))
  assert.equal(niceTicks(0, 0).ticks.length >= 0, true) // degenerate range does not hang
})

test('formatTick: time of day for short spans, date for multi-day', () => {
  assert.equal(formatTick(Date.UTC(2026, 10, 23, 9, 5, 7), 1_000), '09:05:07')
  assert.equal(formatTick(Date.UTC(2026, 10, 23, 9, 5, 7), 10 * MIN), '09:05')
  assert.equal(formatTick(Date.UTC(2026, 10, 23, 9, 5, 7), DAY_MS), '11-23')
})

// ─── Rows open a session ────────────────────────────────────────────────────

test('instance rows open their own session, group rows the most recent copy, lanes none', () => {
  const instances = createFleetFixture(NOW)
  const rows = buildFleetRows({
    instances, kanban: [board('media', [[1, 'created', NOW - MIN]])], selection: view(none), expanded: new Set(['taxis']), now: NOW,
  })
  assert.equal(row(rows, 'taxis-1').openSessionId, 'taxis-1')
  assert.equal(row(rows, 'taxis-2').openSessionId, 'taxis-2')
  assert.equal(row(rows, 'group:hestia').openSessionId, instances.find(i => i.identity === 'hestia')?.id)
  assert.equal(row(rows, 'kanban:media').openSessionId, undefined)
  assert.equal(row(rows, KANBAN_SECTION_ID).openSessionId, undefined)
})

test('latestInstance prefers a running copy, then the latest start', () => {
  const mk = (id: string, startTime: number, endTime?: number) =>
    ({ id, identity: 'x', runtime: 'hermes', startTime, endTime, status: endTime ? 'completed' : 'running', markers: [] }) as FleetInstance
  assert.equal(latestInstance([mk('a', 1, 5), mk('b', 3, 9)])?.id, 'b')
  assert.equal(latestInstance([mk('a', 1), mk('b', 3, 9)])?.id, 'a')
  assert.equal(latestInstance([mk('a', 1), mk('b', 3)])?.id, 'b')
  assert.equal(latestInstance([]), undefined)
})
