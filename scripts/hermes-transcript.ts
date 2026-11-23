/**
 * Hermes message text, tool arguments and tool results, for the live feed.
 *
 * !! READ-ONLY ACCESS TO HERMES' DATA !!
 *
 * Hermes keeps every session's messages in `state.db` (SQLite) under each
 * profile directory: ~/.hermes/profiles/<name>/state.db, and ~/.hermes/state.db
 * for the default profile. This module reads the `messages` and `sessions`
 * tables of that file and nothing else:
 *
 *   - the database is opened with `readOnly: true`, and `PRAGMA query_only=1`
 *     is set on top of that, so a write cannot happen even by mistake;
 *   - only SELECT statements exist in this file;
 *   - nothing is created, altered, locked for writing, or deleted in Hermes'
 *     files, and no Hermes process is contacted or restarted;
 *   - the `system_prompt` column (and any other column not listed below) is
 *     never selected.
 *
 * What is read: `role`, `content`, `tool_calls`, `tool_call_id`, `tool_name`,
 * `reasoning` and `timestamp` of `messages` rows, and the existence of the
 * `sessions` row.
 *
 * Secrets: tool arguments and results can contain credentials (an `.env` that
 * was read, a command with a token in it). Every string read from Hermes passes
 * through {@link redactSecrets} before it leaves this module, so API keys,
 * tokens, passwords and private keys are replaced by a marker, never forwarded
 * to the page and never printed. The redaction is pattern based: it is a
 * safety net, not a guarantee, so treat the feed as sensitive anyway.
 *
 * Size: the one cap on this path is {@link MAX_TEXT_CHARS} per text field. It
 * exists to protect the relay's and the browser's memory from a single huge
 * tool result (a whole file or a long log). Everything shorter is passed on
 * whole.
 */

import { anonymizeMessage, anonymizeResult, anonymizeToolInput } from '../web/lib/content-privacy'

/** Minimal shape of node:sqlite's DatabaseSync, loaded at runtime. */
interface TranscriptDb {
  exec(sql: string): void
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
  close(): void
}
type TranscriptDbCtor = new (file: string, options?: { readOnly?: boolean }) => TranscriptDb

// ─── Size cap ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TEXT_CHARS = 200_000

/**
 * Longest text field (a message, one tool argument, one tool result) passed
 * through, in characters. Longer text is cut and ends with a marker that says
 * how much was left out. This is a memory cap, not a display limit: the feed
 * holds up to MAX_CONVERSATION_MESSAGES messages per agent, so one runaway
 * result must not be able to fill the page. Override with the environment
 * variable AGENT_FLOW_MAX_TEXT_CHARS (a positive number; 0 turns the cap off).
 */
export function maxTextChars(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AGENT_FLOW_MAX_TEXT_CHARS
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_TEXT_CHARS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_TEXT_CHARS
  return n === 0 ? Number.POSITIVE_INFINITY : Math.floor(n)
}

export const MAX_TEXT_CHARS = maxTextChars()

/** Index to cut at so a surrogate pair (emoji and other astral characters) is not split. */
function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1)
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

/** Cut text to `max` characters with a marker; shorter text is returned unchanged. */
export function limitText(text: string, max: number = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  const end = safeEnd(text, max)
  return `${text.slice(0, end)}\n… [${text.length - end} more characters not shown]`
}

// ─── Secret redaction ───────────────────────────────────────────────────────

const REDACTED = '[REDACTED]'

const SECRET_PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM private keys, whole block
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  // Well-known token shapes
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bsyt_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Authorization headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, (_m, scheme) => `${scheme} ${REDACTED}`],
  // Credentials inside a URL: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, (_m, head, at) => `${head}${REDACTED}${at}`],
  // name = value / "name": "value" for names that say they are secret. Only the
  // keyword and a short suffix (api_key, TOKEN_FILE, password_hash ...) are matched,
  // never an unbounded run of name characters, so long base64 text stays linear.
  [
    /((?:api[_-]?key|apikey|secret|token|passwd|password|passphrase|credential|private[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_-]{0,20})(["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;}&)]{6,})/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`,
  ],
]

/** Replace API keys, tokens, passwords, private keys and URL credentials in text. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement as string)
  }
  return out
}

/**
 * Redact then cap one string. Only the part that can be shown is scanned, plus
 * a margin so a secret that straddles the cut is still caught whole.
 */
function cleanText(text: string, max: number): string {
  if (text.length <= max) return redactSecrets(text)
  const redacted = redactSecrets(text.slice(0, max + 256))
  const end = safeEnd(redacted, Math.min(max, redacted.length))
  return `${redacted.slice(0, end)}\n… [${text.length - end} more characters not shown]`
}

/** Redact and cap every string in a JSON-like value. */
export function sanitizeDeep(value: unknown, max: number = MAX_TEXT_CHARS, depth = 0): unknown {
  if (typeof value === 'string') return cleanText(value, max)
  if (value === null || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map(v => sanitizeDeep(v, max, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeDeep(v, max, depth + 1)
  return out
}

// ─── Tool input and result ──────────────────────────────────────────────────

export interface ToolInput {
  /** One-line text for the tool card: the command, the path, the query ... in full */
  args: string
  /** Structured input in the shape Agent Flow's tool renderers know (file_path, command ...) */
  inputData: Record<string, unknown>
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Turn Hermes tool arguments (a JSON string) into Agent Flow's `args` and
 * `inputData`. Text is passed whole (redacted, and capped only by `max`).
 */
export function toolInput(hermesTool: string, argumentsJson: string, max: number = MAX_TEXT_CHARS): ToolInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return { args: cleanText(argumentsJson, max), inputData: {} }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { args: cleanText(String(argumentsJson), max), inputData: {} }
  }
  const a = sanitizeDeep(parsed, max) as Record<string, unknown>
  const compact = () => JSON.stringify(a)

  switch (hermesTool) {
    case 'terminal':
      return { args: str(a.command) || compact(), inputData: { command: str(a.command), ...(a.workdir ? { description: `in ${str(a.workdir)}` } : {}) } }
    case 'execute_code':
      return { args: str(a.code) || compact(), inputData: { command: str(a.code) } }
    case 'read_file':
      return {
        args: str(a.path) || compact(),
        inputData: { file_path: str(a.path), ...(typeof a.offset === 'number' ? { offset: a.offset } : {}), ...(typeof a.limit === 'number' ? { limit: a.limit } : {}) },
      }
    case 'write_file':
      return { args: str(a.path) || compact(), inputData: { file_path: str(a.path), content: str(a.content) } }
    case 'patch':
      return {
        args: str(a.path) || compact(),
        inputData: { file_path: str(a.path), old_string: str(a.old_string), new_string: str(a.new_string) || str(a.patch) },
      }
    case 'search_files':
      return {
        args: [str(a.pattern), a.path ? `in ${str(a.path)}` : ''].filter(Boolean).join(' ') || compact(),
        inputData: { pattern: str(a.pattern), path: str(a.path), ...(a.file_glob ? { glob: str(a.file_glob) } : {}) },
      }
    case 'web_search':
      return { args: str(a.query) || compact(), inputData: { query: str(a.query) } }
    case 'web_extract': {
      const urls = Array.isArray(a.urls) ? a.urls.filter((u): u is string => typeof u === 'string') : []
      return { args: urls.join(' ') || compact(), inputData: { url: urls.join('\n') } }
    }
    default:
      return { args: compact(), inputData: a }
  }
}

export interface ToolResult {
  text: string
  isError: boolean
}

/**
 * Turn the stored content of a Hermes tool message into result text. Hermes
 * stores most results as a JSON object; the readable part (`output`,
 * `content`) is shown, with the error and a non-zero exit code appended.
 * Anything else is passed through as it is.
 */
export function toolResult(content: string, max: number = MAX_TEXT_CHARS): ToolResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { text: cleanText(content, max), isError: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text: cleanText(content, max), isError: false }
  }
  const r = parsed as Record<string, unknown>
  const body = typeof r.output === 'string' ? r.output : typeof r.content === 'string' ? r.content : undefined
  if (body === undefined) {
    // No obvious body: show the whole object.
    const isError = Boolean(r.error) || r.success === false || r.status === 'error'
    return { text: cleanText(content, max), isError }
  }
  const error = typeof r.error === 'string' && r.error ? r.error : r.error ? JSON.stringify(r.error) : ''
  const exit = typeof r.exit_code === 'number' && r.exit_code !== 0 ? r.exit_code : undefined
  const parts = [body]
  if (error) parts.push(`[error] ${error}`)
  if (exit !== undefined) parts.push(`[exit code ${exit}]`)
  return { text: cleanText(parts.join('\n'), max), isError: Boolean(error) || r.success === false || r.status === 'error' }
}

// ─── Rows to items ──────────────────────────────────────────────────────────

/** A message row of Hermes' `messages` table, only the columns this module reads. */
export interface TranscriptRow {
  id: number
  role: string
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  reasoning: string | null
  timestamp: number
}

export type TranscriptItem =
  | { kind: 'message'; role: 'user' | 'assistant' | 'thinking'; content: string }
  | { kind: 'tool_start'; callId: string; hermesTool: string; tool: string; args: string; inputData: Record<string, unknown> }
  | { kind: 'tool_end'; callId: string; hermesTool: string; result: string; isError: boolean }

export interface ItemOptions {
  /** Maps a Hermes tool name to Agent Flow's name (Bash, Read ...) */
  displayTool: (hermesTool: string) => string
  max?: number
  /**
   * Structure only (see web/lib/content-privacy.ts): commands, edits, message
   * bodies and results are replaced by names, paths and sizes before they leave
   * this function. The text itself is not copied.
   */
  anonymize?: boolean
  /** Sender and platform of the profile's latest inbound message, for anonymized user messages */
  from?: { user?: string; platform?: string }
}

/**
 * Convert message rows into feed items, in order. `calls` carries the
 * call-id to tool-name mapping between batches, so a result that arrives in a
 * later batch than its call still gets the right tool.
 */
export function rowsToItems(rows: TranscriptRow[], calls: Map<string, string>, opts: ItemOptions): TranscriptItem[] {
  const max = opts.max ?? MAX_TEXT_CHARS
  const anon = opts.anonymize === true
  const body = (role: 'user' | 'assistant' | 'thinking', raw: string, from?: ItemOptions['from']): string =>
    anon ? anonymizeMessage(role, raw.length, from) : cleanText(raw, max)
  const items: TranscriptItem[] = []
  for (const row of rows) {
    if (row.role === 'user') {
      const text = row.content?.trim() ? body('user', row.content, opts.from) : ''
      if (text) items.push({ kind: 'message', role: 'user', content: text })
    } else if (row.role === 'assistant') {
      const thinking = row.reasoning?.trim() ? body('thinking', row.reasoning) : ''
      if (thinking) items.push({ kind: 'message', role: 'thinking', content: thinking })
      const text = row.content?.trim() ? body('assistant', row.content) : ''
      if (text) items.push({ kind: 'message', role: 'assistant', content: text })
      for (const call of parseToolCalls(row.tool_calls)) {
        calls.set(call.id, call.name)
        const input = anon ? anonymizedInput(call.name, call.arguments) : toolInput(call.name, call.arguments, max)
        items.push({ kind: 'tool_start', callId: call.id, hermesTool: call.name, tool: opts.displayTool(call.name), ...input })
      }
    } else if (row.role === 'tool') {
      const callId = row.tool_call_id ?? `row-${row.id}`
      const hermesTool = calls.get(callId) ?? row.tool_name ?? 'tool'
      const raw = row.content ?? ''
      // max=1 keeps this cheap: only isError is wanted from it when anonymizing
      const res = toolResult(raw, anon ? 1 : max)
      items.push({ kind: 'tool_end', callId, hermesTool, result: anon ? anonymizeResult(raw) : res.text, isError: res.isError })
    }
    // role 'system' (the system prompt) is deliberately skipped.
  }
  return items
}

/** Structure-only tool input: parse the arguments, keep names, paths and sizes. */
function anonymizedInput(hermesTool: string, argumentsJson: string): ToolInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return { args: `${hermesTool} · ${argumentsJson.length} chars`, inputData: {} }
  }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const out = anonymizeToolInput(hermesTool, obj)
  // A file path is structure, but it can carry a secret (a token in a URL path); redact it anyway.
  return { args: redactSecrets(out.args), inputData: sanitizeDeep(out.inputData) as Record<string, unknown> }
}

interface ParsedCall {
  id: string
  name: string
  arguments: string
}

function parseToolCalls(raw: string | null): ParsedCall[] {
  if (!raw) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: ParsedCall[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const call = c as { id?: unknown; call_id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const name = typeof call.function?.name === 'string' ? call.function.name : ''
    if (!name) continue
    const id = typeof call.call_id === 'string' && call.call_id ? call.call_id : typeof call.id === 'string' ? call.id : ''
    if (!id) continue
    const args = call.function?.arguments
    out.push({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) })
  }
  return out
}

// ─── Database reading (read-only) ───────────────────────────────────────────

export interface TranscriptBatch {
  rows: TranscriptRow[]
  /** Highest message id of the session at read time; pass it back as `afterId` */
  lastId: number
}

/** Messages replayed when the watcher first meets a session: from the last user message, at most this many. */
export const BACKLOG_MAX_ROWS = 300
/** Messages read per poll; a longer burst is read over several polls. */
export const BATCH_MAX_ROWS = 500

export type TranscriptReader = (dbFile: string, sid: string, afterId?: number) => TranscriptBatch | undefined

const COLUMNS = 'id, role, content, tool_calls, tool_call_id, tool_name, reasoning, timestamp'

/**
 * Read new messages of one Hermes session from the profile's state.db.
 *
 * READ-ONLY: opens the database with `readOnly: true` and `query_only`, runs
 * SELECTs only, and closes it again. Returns undefined when the database or the
 * session is not readable (missing file, no such session, locked), so callers
 * can fall back to log-derived events.
 *
 * Without `afterId` (first sight of a session) it returns the messages from the
 * most recent user message on, at most BACKLOG_MAX_ROWS, so the node shows what
 * the session is working on without replaying its whole history. With `afterId`
 * it returns the messages after it, at most BATCH_MAX_ROWS.
 */
export const readSessionTranscript: TranscriptReader = (dbFile, sid, afterId) => {
  let db: TranscriptDb | undefined
  try {
    const Ctor = (require('node:sqlite') as { DatabaseSync: TranscriptDbCtor }).DatabaseSync
    db = new Ctor(dbFile, { readOnly: true })
    db.exec('PRAGMA query_only = 1')
    db.exec('PRAGMA busy_timeout = 500')
    const session = db.prepare('select 1 as ok from sessions where id = ?').get(sid)
    if (!session) return undefined

    let rows: TranscriptRow[]
    if (afterId === undefined) {
      const lastUser = db.prepare("select max(id) as id from messages where session_id = ? and role = 'user'").get(sid) as { id: number | null } | undefined
      const from = lastUser?.id ?? 0
      rows = db
        .prepare(`select ${COLUMNS} from (select ${COLUMNS} from messages where session_id = ? and id >= ? order by id desc limit ?) order by id asc`)
        .all(sid, from, BACKLOG_MAX_ROWS) as unknown as TranscriptRow[]
    } else {
      rows = db
        .prepare(`select ${COLUMNS} from messages where session_id = ? and id > ? order by id asc limit ?`)
        .all(sid, afterId, BATCH_MAX_ROWS) as unknown as TranscriptRow[]
    }
    let lastId = afterId ?? 0
    if (rows.length > 0) {
      lastId = rows[rows.length - 1].id
    } else if (afterId === undefined) {
      const top = db.prepare('select max(id) as id from messages where session_id = ?').get(sid) as { id: number | null } | undefined
      lastId = top?.id ?? 0
    }
    return { rows, lastId }
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // nothing to close
    }
  }
}
