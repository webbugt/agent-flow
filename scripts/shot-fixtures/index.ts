/**
 * Synthetic fixture sessions for the screenshot harness (scripts/shot.ts).
 *
 * Everything here is made up: profile names, session ids, titles, prompt text,
 * token counts. No real prompts, ids, hostnames or credentials. The harness
 * writes these into an isolated HOME so the built app finds them exactly where
 * it looks for real data:
 *
 *   Claude Code transcripts   $HOME/.claude/projects/<encoded workspace>/<id>.jsonl
 *   Hermes profiles           $HOME/.hermes/profiles/<profile>/{state.db,logs/agent.log}
 *
 * Fixture ids follow section 10 of docs/PLAN-configurable-costs-v2.md:
 *   F-A  Claude Code transcript, Sonnet 5.5, billing "api", cache reads
 *   F-B  Hermes, provider claude-subscription-directsdk-experimental, Opus 5.5, cache read + write
 *   F-C  Claude Code transcript, Haiku 5.5, one call at 90K and one at 120K prompt tokens
 *   F-D  Claude Code transcript, Fable 5.2 (the "Fable used in the window" case)
 *   F-E  Hermes, provider=copilot: claude-haiku-5.5, gemini-3.8-flash (with cache=), gpt-6.1-sol
 *   F-F  Hermes, provider=ollama with latency= (one call straddling 22:00 local time)
 *   F-G  Hermes, unknown model acme-xyz-9
 *   F-H  Claude Code transcript with no usage reported (context-size estimate path)
 *   L-1..L-4  limits file variants (not read by the app until the limits tasks land)
 *   C-default / C-eur / C-invalid / C-custom-price / C-local-energy / C-local-energy-tou  cost config variants (same note)
 *
 * Hermes watcher behaviour (H0-A7, verified in scripts/hermes-logs.ts `discover`):
 * a profile's agent.log is read from its END at the moment the watcher first sees
 * it; lines that were already there are NOT replayed. The state.db `sessions` table
 * IS read at discovery (restoreRecent) and only gives idle nodes without usage.
 * So usage reaches the UI only through lines APPENDED after the relay started:
 * `appendHermesLines` does that, and the harness calls it once the app is up.
 * Claude Code transcripts are the opposite: existing content is pre-scanned when
 * the session file is first attached, so they are written BEFORE the app starts.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaudeCall {
  model: string
  /** Prompt tokens that were not served from cache */
  input: number
  output: number
  cacheRead?: number
  /** Cache-creation tokens, 5-minute bucket */
  cacheWrite5m?: number
  /** Cache-creation tokens, 1-hour bucket */
  cacheWrite1h?: number
  /** Tool the assistant used in this turn (adds a tool_use / tool_result pair) */
  tool?: { name: string; input: Record<string, unknown>; result: string }
  /** When true no `usage` object is written (context-size estimate path, F-H) */
  noUsage?: boolean
}

export interface ClaudeSessionFixture {
  /** Fixture id, e.g. "F-A" */
  id: string
  /** Transcript file name stem; a UUID-shaped synthetic id */
  sessionId: string
  /** First user message; becomes the session label */
  prompt: string
  billing: 'api' | 'subscription' | 'unknown'
  calls: ClaudeCall[]
  /** Sub-agent transcripts written under <session>/subagents/agent-<id>.jsonl (F-I: one agent with billed usage, one without) */
  subagents?: Array<{ id: string; description: string; calls: ClaudeCall[] }>
}

export interface HermesCall {
  model: string
  provider: string
  /** Total prompt tokens (cache reads and writes are part of this) */
  input: number
  output: number
  latencySec?: number
  /** Tokens served from cache; written as `cache=<n>/<input>` */
  cacheRead?: number
  /** Tokens written to cache; written as `write=<n>` */
  cacheWrite?: number
}

export interface HermesSessionFixture {
  id: string
  profile: string
  /** Hermes session id, `YYYYMMDD_HHMMSS_<8 hex>` */
  sid: string
  title: string
  billing: 'subscription' | 'credits' | 'local' | 'unknown'
  user: string
  assistant: string
  calls: HermesCall[]
  /** Tool names logged by the tool executor, in order */
  tools: string[]
}

export const CLAUDE_SESSIONS: ClaudeSessionFixture[] = [
  {
    id: 'F-A',
    sessionId: '0a1b2c3d-0001-4000-8000-00000000f0a1',
    prompt: 'Fixture F-A: refactor the demo parser module',
    billing: 'api',
    calls: [
      { model: 'claude-sonnet-5-5', input: 4_200, output: 650, cacheRead: 0, cacheWrite5m: 18_000, tool: { name: 'Read', input: { file_path: 'src/parser.ts' }, result: 'export function parse() {}' } },
      { model: 'claude-sonnet-5-5', input: 1_100, output: 900, cacheRead: 18_000, cacheWrite5m: 2_400, tool: { name: 'Edit', input: { file_path: 'src/parser.ts', old_string: 'parse()', new_string: 'parse(input)' }, result: 'Edit applied' } },
      { model: 'claude-sonnet-5-5', input: 800, output: 1_450, cacheRead: 20_400, cacheWrite5m: 1_200 },
    ],
  },
  {
    id: 'F-C',
    sessionId: '0a1b2c3d-0003-4000-8000-00000000f0c3',
    prompt: 'Fixture F-C: summarise the demo changelog',
    billing: 'api',
    calls: [
      { model: 'claude-haiku-5-5', input: 90_000, output: 800 },
      { model: 'claude-haiku-5-5', input: 120_000, output: 1_100 },
    ],
  },
  {
    id: 'F-D',
    sessionId: '0a1b2c3d-0004-4000-8000-00000000f0d4',
    prompt: 'Fixture F-D: design review of the demo architecture',
    billing: 'subscription',
    calls: [
      { model: 'claude-fable-5-2', input: 6_000, output: 2_200, cacheRead: 0, cacheWrite5m: 30_000 },
      { model: 'claude-fable-5-2', input: 2_000, output: 3_100, cacheRead: 30_000, cacheWrite5m: 4_000, tool: { name: 'Grep', input: { pattern: 'TODO' }, result: '3 matches' } },
    ],
  },
  {
    // Mixes billing kinds in ONE session: the main agent reports usage (billed, API), its sub-agent's log reports none
    // (priced from the context size: estimated). The summary then needs a line per kind (plan shot 12, P4 review).
    id: 'F-I',
    sessionId: '0a1b2c3d-0009-4000-8000-00000000f0e9',
    prompt: 'Fixture F-I: split the demo work between two agents',
    billing: 'api',
    calls: [
      { model: 'claude-sonnet-5-5', input: 3_000, output: 700, cacheRead: 0, cacheWrite5m: 12_000, tool: { name: 'Read', input: { file_path: 'src/index.ts' }, result: 'export {}' } },
      { model: 'claude-sonnet-5-5', input: 900, output: 1_100, cacheRead: 12_000, cacheWrite5m: 1_800 },
    ],
    subagents: [
      { id: 'a1f1e2d3c4b5a697', description: 'Scan the demo logs', calls: [
        { model: 'claude-sonnet-5-5', input: 0, output: 0, noUsage: true, tool: { name: 'Grep', input: { pattern: 'ERROR' }, result: '0 matches' } },
        { model: 'claude-sonnet-5-5', input: 0, output: 0, noUsage: true },
      ] },
    ],
  },
  {
    id: 'F-H',
    sessionId: '0a1b2c3d-0008-4000-8000-00000000f0d8',
    prompt: 'Fixture F-H: agent whose log reports no usage',
    billing: 'unknown',
    calls: [
      { model: 'claude-sonnet-5-5', input: 0, output: 0, noUsage: true, tool: { name: 'Bash', input: { command: 'ls' }, result: 'a.txt' } },
      { model: 'claude-sonnet-5-5', input: 0, output: 0, noUsage: true },
    ],
  },
]

export const HERMES_SESSIONS: HermesSessionFixture[] = [
  {
    id: 'F-B',
    profile: 'sub-demo',
    sid: '20261125_090000_b0b0b0b1',
    title: 'Subscription demo plan',
    billing: 'subscription',
    user: 'Fixture F-B: draft the demo plan',
    assistant: 'Synthetic reply for fixture F-B.',
    calls: [
      { model: 'claude-opus-5-5', provider: 'claude-subscription-directsdk-experimental', input: 52_000, output: 1_800, latencySec: 12.4, cacheRead: 48_000, cacheWrite: 3_200 },
      { model: 'claude-opus-5-5', provider: 'claude-subscription-directsdk-experimental', input: 55_500, output: 2_400, latencySec: 15.1, cacheRead: 51_200, cacheWrite: 2_900 },
    ],
    tools: ['read_file', 'terminal'],
  },
  {
    id: 'F-E',
    profile: 'copilot-demo',
    sid: '20261125_090100_e0e0e0e5',
    title: 'Copilot demo audit',
    billing: 'credits',
    user: 'Fixture F-E: audit the demo repo',
    assistant: 'Synthetic reply for fixture F-E.',
    calls: [
      { model: 'claude-haiku-5.5', provider: 'copilot', input: 14_000, output: 420, latencySec: 3.1 },
      { model: 'gemini-3.8-flash', provider: 'copilot', input: 30_000, output: 900, latencySec: 4.8, cacheRead: 24_000 },
      { model: 'gpt-6.1-sol', provider: 'copilot', input: 9_500, output: 1_300, latencySec: 7.2 },
    ],
    tools: ['search_files', 'read_file'],
  },
  {
    id: 'F-F',
    profile: 'local-demo',
    sid: '20261125_090200_f0f0f0f6',
    title: 'Local model demo',
    billing: 'local',
    user: 'Fixture F-F: run the demo locally',
    assistant: 'Synthetic reply for fixture F-F.',
    calls: [
      { model: 'qwen3.5:32b', provider: 'ollama', input: 6_200, output: 640, latencySec: 41.7 },
      { model: 'qwen3.5:32b', provider: 'ollama', input: 7_100, output: 520, latencySec: 36.2 },
    ],
    tools: ['terminal'],
  },
  {
    id: 'F-G',
    profile: 'unknown-demo',
    sid: '20261125_090300_a0a0a0a7',
    title: 'Unknown model demo',
    billing: 'unknown',
    user: 'Fixture F-G: call an unpriced model',
    assistant: 'Synthetic reply for fixture F-G.',
    calls: [{ model: 'acme-xyz-9', provider: 'acme-gateway', input: 11_000, output: 700, latencySec: 5.5 }],
    tools: ['web_search'],
  },
]

/** Limits file variants (plan section 10). Inert until the limits tasks read them. */
export const LIMITS_FIXTURES: Record<string, unknown> = {
  'L-1': { five_hour: { used_percentage: 37 }, seven_day: { used_percentage: 4.2 }, fable_used: false },
  'L-2': { five_hour: { used_percentage: 37 }, seven_day: { used_percentage: 4.2 }, fable_used: true, fable_pairs: [[180, 190], [195, 200], [205, 210]], fable_u: 0.34 },
  'L-3': { five_hour: { used_percentage: 37 }, seven_day: { used_percentage: 4.2 }, fable_used: false, stale: true },
  'L-4': null,
}

/** Cost config variants (plan section 10). Inert until the config tasks read them. */
export const CONFIG_FIXTURES: Record<string, unknown> = {
  'C-default': null,
  'C-eur': { currency: { display: 'EUR', fx: { EUR: 0.92 }, fxAsOf: '2026-11-25' } },
  'C-invalid': { currency: { display: 3 }, pricing: { unknownModel: { policy: 'nonsense' } } },
  // A valid custom price: Sonnet at 6x the list in/out price (12/60 vs 2/10), so the change is visible at a glance (task P3)
  'C-custom-price': { schemaVersion: 1, pricing: { models: [{ match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 12, output: 60, cacheRead: 1.2, cacheWrite5m: 15, cacheWrite1h: 24 } }] } },
  // display.subscriptionValue = hide (Q10): subscription / credits money is not shown
  'C-hide-subscription': { schemaVersion: 1, display: { subscriptionValue: 'hide' } },
  // A PROJECT override (written to <workspace>/.agent-flow/costs.json, not ~/.agent-flow): Sonnet at 3x the list in/out price (6/30 vs 2/10).
  // Names starting with `C-project` go to the workspace; the overlay then shows the "project" badge (R1 info finding).
  'C-project-override': { schemaVersion: 1, pricing: { models: [{ match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 6, output: 30, cacheRead: 0.6, cacheWrite5m: 7.5, cacheWrite1h: 12 } }] } },
  // A string is written as is (not JSON-encoded): a file that does not parse. The settings drawer must refuse to save over it (P4 review).
  'C-broken-json': '{\n  "schemaVersion": 1,\n  "pricing": { "models": [ { "match": { "model": "claude-sonnet-*" }, "rate": { "input": 12, \n',
  // Valid JSON, but one rule fails validation: the overlay keeps the last good copy and the drawer must not edit from it.
  'C-one-bad-rule': { schemaVersion: 1, pricing: { models: [
    { match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 12, output: 60, cacheRead: 1.2, cacheWrite5m: 15, cacheWrite1h: 24 } },
    { match: { provider: 'anthropic', model: 'claude-haiku-*' }, rate: { input: -3, output: 4 } },
  ] } },
  // A hand edit made while the drawer is open (adds a rule): the drawer must notice and refuse to roll it back.
  'C-hand-edit': { schemaVersion: 1, pricing: { models: [
    { match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 12, output: 60, cacheRead: 1.2, cacheWrite5m: 15, cacheWrite1h: 24 } },
    { match: { provider: 'anthropic', model: 'claude-haiku-*' }, rate: { input: 2, output: 8 } },
  ] } },
  // Local box: 40 W idle / 220 W under load, marginal attribution, 0.18 per kWh (schema as in web/lib/costs/validate.ts)
  'C-local-energy': { schemaVersion: 1, pricing: { providers: { ollama: { billing: 'local', energyProfile: 'box' } } }, energy: { profiles: { box: { powerW: { idle: 40, load: 220 }, throughput: { genTokPerSec: 40, prefillTokPerSec: 800 } } }, tariff: { currency: 'USD', flatPerKWh: 0.18 } } },
  // The same box with a time-of-day tariff, built when it is READ so the capture is deterministic whatever the hour: a PEAK window of the
  // current UTC hour (0.35 per kWh) over the flat 0.18, so the busy minutes that just ended are priced at the peak window. The tooltip names
  // the window and the minutes in it; the editor shows it. (P5 tariff-effect shots)
  get 'C-local-energy-tou'(): unknown {
    const h = new Date().getUTCHours()
    const clock = (n: number) => `${String(n).padStart(2, '0')}:00`
    return { schemaVersion: 1, pricing: { providers: { ollama: { billing: 'local', energyProfile: 'box' } } }, energy: { profiles: { box: { powerW: { idle: 40, load: 220 }, throughput: { genTokPerSec: 40, prefillTokPerSec: 800 } } }, tariff: { currency: 'USD', flatPerKWh: 0.18, tz: 'UTC', timeOfDay: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: clock(h), to: clock(h + 1), perKWh: 0.35 },
    ] } } }
  },
}

/** The bytes a config fixture is written as: a string as is (a broken file on purpose), anything else as JSON. */
export function configFixtureText(doc: unknown): string {
  return typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n'
}

export const FIXTURE_IDS = [
  ...CLAUDE_SESSIONS.map(s => s.id),
  ...HERMES_SESSIONS.map(s => s.id),
  ...Object.keys(LIMITS_FIXTURES),
  ...Object.keys(CONFIG_FIXTURES),
]

// ─── Scenarios: which fixtures a run contains ───────────────────────────────

export interface Scenario {
  claude: string[]
  hermes: string[]
}

/** `costs` has one session of each kind the cost work needs (task H0). */
export const SCENARIOS: Record<string, Scenario> = {
  costs: { claude: ['F-A', 'F-D'], hermes: ['F-B', 'F-E', 'F-F'] },
  all: { claude: CLAUDE_SESSIONS.map(s => s.id), hermes: HERMES_SESSIONS.map(s => s.id) },
  claude: { claude: ['F-A'], hermes: [] },
  hermes: { claude: [], hermes: HERMES_SESSIONS.map(s => s.id) },
}

export function resolveScenario(name: string): Scenario {
  const s = SCENARIOS[name]
  if (!s) throw new Error(`unknown scenario "${name}" (known: ${Object.keys(SCENARIOS).join(', ')})`)
  return s
}

/** Fixtures of a scenario, looked up by id. Throws on an id that does not exist. */
export function loadScenario(name: string): { claude: ClaudeSessionFixture[]; hermes: HermesSessionFixture[] } {
  const sc = resolveScenario(name)
  const claude = sc.claude.map(id => {
    const f = CLAUDE_SESSIONS.find(s => s.id === id)
    if (!f) throw new Error(`unknown Claude fixture ${id}`)
    return f
  })
  const hermes = sc.hermes.map(id => {
    const f = HERMES_SESSIONS.find(s => s.id === id)
    if (!f) throw new Error(`unknown Hermes fixture ${id}`)
    return f
  })
  return { claude, hermes }
}

// ─── Writers ────────────────────────────────────────────────────────────────

type SqliteDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): unknown }
  close(): void
}

/** Claude Code encodes a project path as its project folder name: every non-alphanumeric becomes "-". */
export function encodeProjectDir(workspace: string): string {
  let resolved = workspace
  try { resolved = fs.realpathSync(workspace) } catch { /* not created yet */ }
  return resolved.replace(/[^a-zA-Z0-9]/g, '-')
}

export function claudeTranscriptLines(f: ClaudeSessionFixture, workspace: string, now: number): string[] {
  const lines: string[] = []
  let t = now - 120_000
  const iso = () => new Date((t += 2_000)).toISOString()
  const base = { sessionId: f.sessionId, cwd: workspace, version: 'fixture', gitBranch: 'main' }
  lines.push(JSON.stringify({
    ...base, type: 'user', uuid: `${f.sessionId}-u0`, timestamp: iso(),
    message: { role: 'user', content: f.prompt },
  }))
  f.calls.forEach((c, i) => {
    const content: unknown[] = [{ type: 'text', text: `Synthetic assistant turn ${i + 1} for ${f.id}.` }]
    const toolId = `toolu_${f.id.replace('-', '')}_${i}`
    if (c.tool) content.push({ type: 'tool_use', id: toolId, name: c.tool.name, input: c.tool.input })
    const usage = c.noUsage ? undefined : {
      input_tokens: c.input,
      output_tokens: c.output,
      cache_read_input_tokens: c.cacheRead ?? 0,
      cache_creation_input_tokens: (c.cacheWrite5m ?? 0) + (c.cacheWrite1h ?? 0),
      cache_creation: { ephemeral_5m_input_tokens: c.cacheWrite5m ?? 0, ephemeral_1h_input_tokens: c.cacheWrite1h ?? 0 },
    }
    lines.push(JSON.stringify({
      ...base, type: 'assistant', uuid: `${f.sessionId}-a${i}`, timestamp: iso(),
      message: { id: `msg_${f.id.replace('-', '')}_${i}`, role: 'assistant', model: c.model, content, ...(usage ? { usage } : {}) },
    }))
    if (c.tool) {
      lines.push(JSON.stringify({
        ...base, type: 'user', uuid: `${f.sessionId}-r${i}`, timestamp: iso(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: c.tool.result }] },
      }))
    }
  })
  return lines
}

/** A sub-agent's transcript: the same line shapes as the main one, flagged as a side chain of the parent session. */
export function subagentTranscriptLines(f: ClaudeSessionFixture, sub: NonNullable<ClaudeSessionFixture['subagents']>[number], workspace: string, now: number): string[] {
  const inner: ClaudeSessionFixture = { ...f, id: `${f.id}-${sub.id.slice(0, 4)}`, prompt: sub.description, calls: sub.calls, subagents: undefined }
  return claudeTranscriptLines(inner, workspace, now).map(l => JSON.stringify({ ...JSON.parse(l), isSidechain: true, agentId: sub.id }))
}

export function hermesLogLine(sid: string, n: number, c: HermesCall, now: number): string {
  const d = new Date(now)
  const pad = (v: number, w = 2) => String(v).padStart(w, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
  const total = c.input + c.output
  const cache = c.cacheRead !== undefined ? ` cache=${c.cacheRead}/${c.input} (${Math.round((c.cacheRead / Math.max(1, c.input)) * 100)}%)` : ''
  const write = c.cacheWrite !== undefined ? ` write=${c.cacheWrite}` : ''
  const lat = c.latencySec !== undefined ? ` latency=${c.latencySec}s` : ''
  return `${stamp} INFO [${sid}] agent.conversation_loop: API call #${n}: model=${c.model} provider=${c.provider} in=${c.input} out=${c.output} total=${total}${lat}${cache}${write} id=fixture`
}

export function hermesToolLine(sid: string, tool: string, now: number): string {
  const d = new Date(now)
  const pad = (v: number, w = 2) => String(v).padStart(w, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
  return `${stamp} INFO [${sid}] agent.tool_executor: tool ${tool} completed (0.20s, 120 chars)`
}

/** The lines a Hermes fixture appends to its agent.log once the relay is watching it. */
export function hermesLiveLines(f: HermesSessionFixture, now: number): string[] {
  const out: string[] = []
  if (f.billing === 'local') {
    // A local model's calls are one after the other (a call starts when the previous tool finished): the log line of a call is
    // written when it ENDS, `latency` seconds after it began, and the watcher reads that as its busy interval (P5). Lines that
    // all carried "now" would claim the calls ran at the same time and halve the busy time; so these end in the past, 3 s of tool time apart.
    const total = f.calls.reduce((s, c) => s + (c.latencySec ?? 0) * 1000 + 3000, 0)
    let t = now - total - 1000
    f.calls.forEach((c, i) => {
      t += (c.latencySec ?? 0) * 1000
      out.push(hermesLogLine(f.sid, i + 1, c, t))
      t += 3000
      out.push(hermesToolLine(f.sid, f.tools[i % f.tools.length], t - 2800))
    })
    return out
  }
  f.calls.forEach((c, i) => {
    const tool = f.tools[i % f.tools.length]
    out.push(hermesToolLine(f.sid, tool, now + i * 1000))
    out.push(hermesLogLine(f.sid, i + 1, c, now + i * 1000 + 500))
  })
  return out
}

function openWritable(file: string): SqliteDb {
  const Ctor = (require('node:sqlite') as { DatabaseSync: new (f: string) => SqliteDb }).DatabaseSync
  return new Ctor(file)
}

export interface Materialized {
  home: string
  workspace: string
  hermesRoot: string
  claudeFiles: string[]
  hermesLogFiles: string[]
}

/**
 * Write the files the app reads at start: Claude transcripts, Hermes profile
 * folders with an (empty) agent.log and a state.db holding the session titles.
 * Usage lines for Hermes are added later by `appendHermesLines`.
 */
export function materializeFixtures(opts: {
  home: string
  workspace: string
  scenario: string
  now?: number
  limits?: string
  config?: string
}): Materialized {
  const now = opts.now ?? Date.now()
  // Validate every name before anything is written
  if (opts.limits && !(opts.limits in LIMITS_FIXTURES)) throw new Error(`unknown limits fixture ${opts.limits}`)
  if (opts.config && !(opts.config in CONFIG_FIXTURES)) throw new Error(`unknown config fixture ${opts.config}`)
  const { claude, hermes } = loadScenario(opts.scenario)
  fs.mkdirSync(opts.workspace, { recursive: true })
  const projectDir = path.join(opts.home, '.claude', 'projects', encodeProjectDir(opts.workspace))
  fs.mkdirSync(projectDir, { recursive: true })
  const claudeFiles: string[] = []
  for (const f of claude) {
    const file = path.join(projectDir, `${f.sessionId}.jsonl`)
    fs.writeFileSync(file, claudeTranscriptLines(f, opts.workspace, now).join('\n') + '\n')
    claudeFiles.push(file)
    for (const sub of f.subagents ?? []) {
      const dir = path.join(projectDir, f.sessionId, 'subagents')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `agent-${sub.id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: sub.description }))
      fs.writeFileSync(path.join(dir, `agent-${sub.id}.jsonl`), subagentTranscriptLines(f, sub, opts.workspace, now).join('\n') + '\n')
      claudeFiles.push(path.join(dir, `agent-${sub.id}.jsonl`))
    }
  }

  const hermesRoot = path.join(opts.home, '.hermes')
  const hermesLogFiles: string[] = []
  for (const f of hermes) {
    const dir = path.join(hermesRoot, 'profiles', f.profile)
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
    const logFile = path.join(dir, 'logs', 'agent.log')
    fs.writeFileSync(logFile, '')
    fs.writeFileSync(path.join(dir, 'logs', 'gateway.log'), '')
    hermesLogFiles.push(logFile)
    const db = openWritable(path.join(dir, 'state.db'))
    try {
      db.exec('create table sessions (id text primary key, title text, started_at real, source text, display_name text, user_id text)')
      db.exec('create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_calls text, tool_call_id text, tool_name text, reasoning text, timestamp real)')
      db.prepare('insert into sessions (id, title, started_at, source, display_name, user_id) values (?, ?, ?, ?, ?, ?)')
        .run(f.sid, f.title, (now - 60_000) / 1000, 'fixture', f.user, 'fixture-user')
      const ins = db.prepare('insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)')
      ins.run(f.sid, 'user', f.user, (now - 50_000) / 1000)
      ins.run(f.sid, 'assistant', f.assistant, (now - 40_000) / 1000)
    } finally {
      db.close()
    }
  }

  const af = path.join(opts.home, '.agent-flow')
  if (opts.limits && LIMITS_FIXTURES[opts.limits] !== null) {
    if (!(opts.limits in LIMITS_FIXTURES)) throw new Error(`unknown limits fixture ${opts.limits}`)
    fs.mkdirSync(path.join(af, 'limits'), { recursive: true })
    fs.writeFileSync(path.join(af, 'limits', 'claude.json'), JSON.stringify(LIMITS_FIXTURES[opts.limits], null, 2))
  } else if (opts.limits && !(opts.limits in LIMITS_FIXTURES)) {
    throw new Error(`unknown limits fixture ${opts.limits}`)
  }
  if (opts.config && CONFIG_FIXTURES[opts.config] !== null) {
    if (!(opts.config in CONFIG_FIXTURES)) throw new Error(`unknown config fixture ${opts.config}`)
    fs.mkdirSync(af, { recursive: true })
    fs.writeFileSync(path.join(af, 'costs.json'), configFixtureText(CONFIG_FIXTURES[opts.config]))
  } else if (opts.config && !(opts.config in CONFIG_FIXTURES)) {
    throw new Error(`unknown config fixture ${opts.config}`)
  }
  return { home: opts.home, workspace: opts.workspace, hermesRoot, claudeFiles, hermesLogFiles }
}

/**
 * Rewrite `<home>/.agent-flow/costs.json` to a C-* fixture while the app runs (hot-reload shots). The write is
 * atomic (temp file + rename, like the app's own), so the watcher never sees half a file. `C-default` removes the file.
 */
export function rewriteConfigFixture(home: string, name: string, workspace?: string): void {
  if (!(name in CONFIG_FIXTURES)) throw new Error(`unknown config fixture ${name}`)
  // C-project* fixtures are the project layer: <workspace>/.agent-flow/costs.json
  const isProject = name.startsWith('C-project')
  if (isProject && !workspace) throw new Error(`${name} is a project config: the run has no workspace`)
  const af = path.join(isProject ? workspace as string : home, '.agent-flow')
  const file = path.join(af, 'costs.json')
  const doc = CONFIG_FIXTURES[name]
  if (doc === null) { fs.rmSync(file, { force: true }); return }
  fs.mkdirSync(af, { recursive: true })
  const tmp = path.join(af, `.costs.json.${process.pid}.tmp`)
  fs.writeFileSync(tmp, configFixtureText(doc), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Append the usage and tool lines of the scenario's Hermes fixtures to their agent.log (after the relay attached). */
export function appendHermesLines(m: Materialized, scenario: string, now = Date.now()): number {
  const { hermes } = loadScenario(scenario)
  let n = 0
  for (const f of hermes) {
    const logFile = path.join(m.hermesRoot, 'profiles', f.profile, 'logs', 'agent.log')
    const lines = hermesLiveLines(f, now)
    fs.appendFileSync(logFile, lines.join('\n') + '\n')
    n += lines.length
  }
  return n
}

/**
 * Claude Code: the session watcher attaches to a transcript at its END and counts billed usage only for lines
 * written afterwards (the prescan counts context tokens, not spend). So the one API-billed demo session (F-A) gets one
 * more assistant turn once the app is up; its pill then shows a BILLED figure (`$0.0xx`, no tilde) instead of an
 * estimate. Returns the number of lines appended.
 */
export function appendClaudeLiveLines(m: Materialized, scenario: string, now = Date.now()): number {
  const { claude } = loadScenario(scenario)
  let n = 0
  for (const f of claude) {
    if (f.id !== 'F-A') continue
    const file = m.claudeFiles.find(p => p.endsWith(`${f.sessionId}.jsonl`))
    if (!file) continue
    const line = JSON.stringify({
      sessionId: f.sessionId, cwd: m.workspace, version: 'fixture', gitBranch: 'main', type: 'assistant', uuid: `${f.sessionId}-live`,
      timestamp: new Date(now).toISOString(),
      message: {
        id: `msg_${f.id.replace('-', '')}_live`, role: 'assistant', model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'Synthetic live turn for F-A.' }],
        usage: { input_tokens: 3_000, output_tokens: 800, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 1_500, cache_creation: { ephemeral_5m_input_tokens: 1_500, ephemeral_1h_input_tokens: 0 } },
      },
    })
    fs.appendFileSync(file, line + '\n')
    n++
  }
  n += appendSubagentLiveLines(m, claude, now)
  return n
}

/**
 * F-I (billed main agent + estimated sub-agent). Once the watcher is attached: the main agent writes one assistant turn WITH usage
 * (billed) that also calls the Task tool, and the sub-agent's own transcript gets a turn with a tool call that has no result yet
 * (the watcher only follows a sub-agent that is still working) and no usage (priced from its context size: an estimate).
 */
function appendSubagentLiveLines(m: Materialized, claude: ClaudeSessionFixture[], now: number): number {
  let n = 0
  for (const f of claude) {
    const sub = f.subagents?.[0]
    if (!sub) continue
    const file = m.claudeFiles.find(p => p.endsWith(`${f.sessionId}.jsonl`))
    const subFile = m.claudeFiles.find(p => p.endsWith(`agent-${sub.id}.jsonl`))
    if (!file || !subFile) continue
    const base = { cwd: m.workspace, version: 'fixture', gitBranch: 'main' }
    const taskId = `toolu_${f.id.replace('-', '')}_task`
    fs.appendFileSync(file, JSON.stringify({
      ...base, sessionId: f.sessionId, type: 'assistant', uuid: `${f.sessionId}-live-task`, timestamp: new Date(now).toISOString(),
      message: {
        id: `msg_${f.id.replace('-', '')}_live`, role: 'assistant', model: 'claude-sonnet-5-5',
        content: [
          { type: 'text', text: `Synthetic live turn for ${f.id}.` },
          { type: 'tool_use', id: taskId, name: 'Task', input: { description: sub.description, subagent_type: 'general-purpose', prompt: 'Scan the demo logs for errors.' } },
        ],
        usage: { input_tokens: 2_500, output_tokens: 600, cache_read_input_tokens: 13_800, cache_creation_input_tokens: 1_000, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 } },
      },
    }) + '\n')
    fs.appendFileSync(subFile, JSON.stringify({
      ...base, sessionId: f.sessionId, isSidechain: true, agentId: sub.id, type: 'assistant', uuid: `${f.sessionId}-sub-live`, timestamp: new Date(now + 500).toISOString(),
      message: {
        id: `msg_${f.id.replace('-', '')}_sublive`, role: 'assistant', model: 'claude-sonnet-5-5',
        content: [
          { type: 'text', text: 'Synthetic sub-agent turn: scanning the demo logs for errors in every file of the demo project, one file after another.' },
          { type: 'tool_use', id: `toolu_${f.id.replace('-', '')}_sublive`, name: 'Grep', input: { pattern: 'ERROR' } },
        ],
      },
    }) + '\n')
    n += 2
  }
  return n
}

/** A fresh temp directory under the scratch dir (TMPDIR when set, else os.tmpdir()). */
export function makeTempRoot(prefix = 'shot-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
