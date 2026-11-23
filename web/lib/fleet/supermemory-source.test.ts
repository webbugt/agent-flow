import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SUPERMEMORY_NAMESPACES,
  discoverStateDbs,
  extractSupermemoryCalls,
  normalizeContainerTag,
  openStateDbReadOnly,
  readSupermemoryFleet,
  resolveHermesRoot,
} from './supermemory-source'

// Subset of the real Hermes state.db `messages` table (only columns we touch,
// plus content columns that must never leak into the output).
const SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL
);`

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0) // 2026-11-23T12:00:00Z
const DAY = 86_400_000
const sec = (ms: number) => ms / 1000

/** `agoDays` days before NOW, in epoch seconds (Hermes stores seconds as REAL). */
const ago = (agoDays: number) => sec(NOW - agoDays * DAY)

interface Call {
  /** Tool name as the provider records it, e.g. supermemory_store. */
  name: string
  args: Record<string, unknown>
  id?: string
}

function assistantRow(db: DatabaseSync, session: string, ts: number, calls: Call[], opts: { wrapped?: boolean } = {}) {
  let toolCalls: unknown[]
  if (opts.wrapped) {
    // Deferred tools invoked through a generic wrapper tool.
    toolCalls = [
      {
        call_id: calls[0].id ?? 'wrap',
        id: calls[0].id ?? 'wrap',
        type: 'function',
        function: {
          name: 'mcp__hermes__tool_call',
          arguments: JSON.stringify({ calls: calls.map((c) => ({ name: c.name, arguments: c.args })) }),
        },
      },
    ]
  } else {
    toolCalls = calls.map((c, i) => ({
      call_id: c.id ?? `c_${session}_${ts}_${i}`,
      id: c.id ?? `c_${session}_${ts}_${i}`,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }))
  }
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?,?,?,?,?)').run(
    session,
    'assistant',
    'SECRET ASSISTANT CONTENT',
    JSON.stringify(toolCalls),
    ts,
  )
}

function makeStateDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  // Noise that must be ignored: a tool *result* row and an unrelated assistant call.
  db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)').run(
    's0',
    'tool',
    'SECRET TOOL RESULT supermemory_store',
    'supermemory_store',
    ago(1),
  )
  assistantRow(db, 's0', ago(1), [{ name: 'terminal', args: { command: 'echo supermemory_store' } }])
  return db
}

const S = (extra: Record<string, unknown> = {}) => ({ content: 'SECRET CONTENT', ...extra })

let root: string
let defaultWriter: DatabaseSync

before(() => {
  root = mkdtempSync(join(tmpdir(), 'supermemory-source-'))
  mkdirSync(join(root, 'profiles', 'taxis'), { recursive: true })
  mkdirSync(join(root, 'profiles', 'sophia'), { recursive: true })
  mkdirSync(join(root, 'profiles', 'empty-dir'), { recursive: true }) // no state.db -> skipped
  mkdirSync(join(root, 'profiles', '.deleted'), { recursive: true })

  // root state.db (profile "default"), kept open in WAL mode like a live gateway.
  defaultWriter = makeStateDb(join(root, 'state.db'))
  defaultWriter.exec('PRAGMA journal_mode = WAL')
  assistantRow(defaultWriter, 'd1', ago(2), [{ name: 'supermemory_search', args: { container_tag: 'omh_family', query: 'q' } }])

  // taxis: normal calls, hyphenated aliases, tag spelling variants, untagged, old, duplicates.
  const taxis = makeStateDb(join(root, 'profiles', 'taxis', 'state.db'))
  assistantRow(taxis, 't1', ago(0.5), [
    { name: 'supermemory_store', args: S({ container_tag: 'omh_family' }) },
    { name: 'supermemory_store', args: S({ container_tag: 'matrix_org' }) },
  ])
  assistantRow(taxis, 't1', ago(1), [{ name: 'supermemory_search', args: { container_tag: 'omh_family', query: 'x', limit: 5 } }])
  assistantRow(taxis, 't1', ago(1.1), [{ name: 'supermemory-save', args: S({ container_tag: 'omh-family' }) }]) // alias + hyphen tag
  assistantRow(taxis, 't1', ago(1.2), [{ name: 'supermemory-search', args: { container_tag: 'OMH_FAMILY', query: 'y' } }])
  assistantRow(taxis, 't1', ago(2), [{ name: 'supermemory_forget', args: { container_tag: 'omh_family', id: 'doc_secret' } }])
  assistantRow(taxis, 't1', ago(2.1), [{ name: 'supermemory-forget', args: { container_tag: 'matrix_org', query: 'z' } }])
  assistantRow(taxis, 't1', ago(3), [{ name: 'supermemory_store', args: S({ container_tag: 'webbugt-video-memory' }) }])
  assistantRow(taxis, 't1', ago(3), [{ name: 'supermemory_search', args: { query: 'no tag' } }]) // unattributed
  assistantRow(taxis, 't1', ago(8), [{ name: 'supermemory_store', args: S({ container_tag: 'omh_family' }) }]) // outside window
  assistantRow(taxis, 't1', ago(4), [{ name: 'supermemory_store', args: S({ container_tag: 'brand_new_ns' }) }]) // unknown namespace
  assistantRow(taxis, 't1', ago(4), [{ name: 'supermemory_profile', args: { container_tag: 'omh_family' } }]) // not store/search/forget
  // Compaction copy of the 1-day-old search above: same call id + args, LATER timestamp. Must count once.
  assistantRow(taxis, 't2', ago(0.2), [
    { name: 'supermemory_store', args: S({ container_tag: 'matrix_org' }), id: 'dup_1' },
  ])
  assistantRow(taxis, 't2', ago(0.1), [
    { name: 'supermemory_store', args: S({ container_tag: 'matrix_org' }), id: 'dup_1' },
  ])
  // Original is OUTSIDE the window, copy inside: earliest timestamp wins -> not counted.
  assistantRow(taxis, 't3', ago(9), [{ name: 'supermemory_store', args: S({ container_tag: 'matrix_org' }), id: 'dup_old' }])
  assistantRow(taxis, 't4', ago(0.3), [{ name: 'supermemory_store', args: S({ container_tag: 'matrix_org' }), id: 'dup_old' }])
  taxis.close()

  // sophia: wrapped calls through tool_call, and an unparseable tool_calls row.
  const sophia = makeStateDb(join(root, 'profiles', 'sophia', 'state.db'))
  assistantRow(
    sophia,
    'p1',
    ago(1),
    [
      { name: 'supermemory_store', args: S({ container_tag: 'webbugt_video_memory' }), id: 'w1' },
      { name: 'supermemory_search', args: { container_tag: 'webbugt_video_memory', query: 'v' } },
    ],
    { wrapped: true },
  )
  sophia.prepare('INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES (?,?,?,?)').run(
    'p1',
    'assistant',
    '{not json supermemory_store',
    ago(1),
  )
  sophia.close()

  // A corrupt DB must not break the other nodes.
  mkdirSync(join(root, 'profiles', 'broken'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'broken', 'state.db'), 'this is not a sqlite file')
})

after(() => {
  try {
    defaultWriter.close()
  } catch {
    // ignore
  }
  rmSync(root, { recursive: true, force: true })
})

const snap = () => readSupermemoryFleet({ hermesRoot: root, now: NOW })
const node = (s: ReturnType<typeof snap>, tag: string) => {
  const n = s.nodes.find((x) => x.containerTag === tag)
  assert.ok(n, `node ${tag} missing`)
  return n
}

test('normalizeContainerTag folds case and hyphens', () => {
  assert.equal(normalizeContainerTag(' Webbugt-Video-Memory '), 'webbugt_video_memory')
  assert.equal(normalizeContainerTag('omh_family'), 'omh_family')
})

test('discoverStateDbs: root as default, profiles sorted, dot dirs and dirs without a db skipped', () => {
  const found = discoverStateDbs(root).map((d) => d.profile)
  assert.deepEqual(found, ['default', 'broken', 'sophia', 'taxis'])
})

test('each namespace is its own node; the three known ones are always present, in fixed order', () => {
  const s = snap()
  assert.deepEqual(s.nodes.slice(0, 3).map((n) => n.containerTag), [...SUPERMEMORY_NAMESPACES])
  assert.equal(node(s, 'omh_family').id, 'supermemory:omh_family')
  assert.equal(node(s, 'omh_family').type, 'supermemory-namespace')
  const ids = new Set(s.nodes.map((n) => n.id))
  assert.equal(ids.size, s.nodes.length)
})

test('7-day store/search/forget counts per namespace (aliases and tag spellings folded in)', () => {
  const s = snap()
  // omh_family: store 1 (taxis 0.5d) + 1 (alias save, hyphen tag) ; search 1 + 1 (alias) + 1 (default) ; forget 1.
  assert.deepEqual(node(s, 'omh_family').counts, { store: 2, search: 3, forget: 1 })
  assert.equal(node(s, 'omh_family').total, 6)
  // matrix_org: store 1 + dup_1 once ; forget 1 (alias). dup_old original is outside the window.
  assert.deepEqual(node(s, 'matrix_org').counts, { store: 2, search: 0, forget: 1 })
  // webbugt_video_memory: taxis store (hyphen tag) + sophia wrapped store/search.
  assert.deepEqual(node(s, 'webbugt_video_memory').counts, { store: 2, search: 1, forget: 0 })
})

test('unknown namespaces become extra nodes after the known ones', () => {
  const s = snap()
  assert.deepEqual(node(s, 'brand_new_ns').counts, { store: 1, search: 0, forget: 0 })
  assert.equal(s.nodes[s.nodes.length - 1].containerTag, 'brand_new_ns')
})

test('calls without container_tag are reported as unattributed, never assigned', () => {
  const s = snap()
  assert.deepEqual(s.unattributed, { store: 0, search: 1, forget: 0 })
})

test('window: events older than the window are dropped, and the window can be changed', () => {
  const wide = readSupermemoryFleet({ hermesRoot: root, now: NOW, windowDays: 30 })
  // adds the 8-day-old omh_family store; dup_old's earliest (9d) is now in window as well.
  assert.equal(node(wide, 'omh_family').counts.store, 3)
  assert.equal(node(wide, 'matrix_org').counts.store, 3) // 0.5d + dup_1 + dup_old (9d original)
  const narrow = readSupermemoryFleet({ hermesRoot: root, now: NOW, windowDays: 1 })
  assert.equal(narrow.windowDays, 1)
  // the window start is inclusive: the search at exactly 1d ago counts, the 1.2d one does not.
  assert.deepEqual(node(narrow, 'omh_family').counts, { store: 1, search: 1, forget: 0 })
  assert.equal(readSupermemoryFleet({ hermesRoot: root, now: NOW, windowDays: 0 }).windowDays, 1)
  assert.equal(readSupermemoryFleet({ hermesRoot: root, now: NOW, windowDays: 9999 }).windowDays, 90)
  assert.equal(snap().sinceMs, NOW - 7 * DAY)
})

test('duplicates from compaction/resume count once; the earliest timestamp decides the window', () => {
  const s = snap()
  // dup_1 (copies at 0.2d and 0.1d) counted once, dup_old (9d original, 0.3d copy) not at all.
  assert.equal(node(s, 'matrix_org').counts.store, 2)
})

test('calls routed through the tool_call wrapper are counted', () => {
  const calls = extractSupermemoryCalls(
    JSON.stringify([
      {
        id: 'x',
        function: {
          name: 'tool_call',
          arguments: JSON.stringify({ calls: [{ name: 'supermemory_forget', arguments: { container_tag: 'matrix_org', id: 'd' } }] }),
        },
      },
    ]),
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'forget')
  assert.equal(calls[0].tag, 'matrix_org')
})

test('byProfile, daily buckets and lastEventAt', () => {
  const s = snap()
  const fam = node(s, 'omh_family')
  assert.deepEqual(fam.byProfile.taxis, { store: 2, search: 2, forget: 1 })
  assert.deepEqual(fam.byProfile.default, { store: 0, search: 1, forget: 0 })
  assert.equal(fam.lastEventAt, NOW - 0.5 * DAY)
  assert.deepEqual(
    fam.daily.map((d) => d.day),
    [...fam.daily.map((d) => d.day)].sort(),
  )
  const sum = fam.daily.reduce((a, d) => a + d.store + d.search + d.forget, 0)
  assert.equal(sum, fam.total)
  assert.equal(node(s, 'webbugt_video_memory').byProfile.sophia.store, 1)
  assert.equal(node(s, 'webbugt_video_memory').lastEventAt, NOW - 1 * DAY)
  assert.equal(node(s, 'matrix_org').daily.find((d) => d.day === '2026-11-23')?.store, 2)
})

test('namespaces with no events have zero counts and null lastEventAt', () => {
  const s = readSupermemoryFleet({ hermesRoot: join(root, 'nowhere'), now: NOW })
  assert.equal(s.nodes.length, 3)
  for (const n of s.nodes) {
    assert.deepEqual(n.counts, { store: 0, search: 0, forget: 0 })
    assert.equal(n.lastEventAt, null)
  }
  assert.deepEqual(s.sources, [])
})

test('corrupt DB is isolated: other profiles still read, error is reported on the source', () => {
  const s = snap()
  const broken = s.sources.find((x) => x.profile === 'broken')
  assert.ok(broken?.error)
  assert.equal(s.sources.find((x) => x.profile === 'taxis')?.error, undefined)
  assert.ok(node(s, 'omh_family').total > 0)
})

test('output never contains content, queries, document ids or tool results', () => {
  const json = JSON.stringify(snap())
  for (const needle of ['SECRET', 'doc_secret', 'no tag', 'echo ']) assert.ok(!json.includes(needle), needle)
})

test('read-only: databases are opened with query_only and refuse writes', () => {
  const db = openStateDbReadOnly(join(root, 'profiles', 'taxis', 'state.db'))
  try {
    assert.throws(() => db.exec("INSERT INTO messages (session_id, role, timestamp) VALUES ('x','assistant',1)"))
  } finally {
    db.close()
  }
})

test('works while a writer holds the root DB open in WAL mode', () => {
  assistantRow(defaultWriter, 'd1', sec(NOW - 1000), [{ name: 'supermemory_store', args: S({ container_tag: 'omh_family' }) }])
  assert.equal(node(snap(), 'omh_family').byProfile.default.store, 1)
})

test('resolveHermesRoot: explicit option, profile HERMES_HOME mapped back to root, default ~/.hermes', () => {
  assert.equal(resolveHermesRoot({ hermesRoot: '/x' }, {}), '/x')
  assert.equal(resolveHermesRoot({}, { HERMES_HOME: '/h/.hermes/profiles/omh-coder' }), '/h/.hermes')
  assert.equal(resolveHermesRoot({}, { HERMES_HOME: '/custom/root' }), '/custom/root')
  assert.ok(resolveHermesRoot({}, {}).endsWith('.hermes'))
})
