/**
 * Content privacy: which Hermes profiles show their full content in the live
 * feed and the fleet view, and which show structure only.
 *
 * Setting (read once, when the relay starts):
 *
 *   AGENT_FLOW_ANONYMIZE_CONTENT=all            every profile is anonymized
 *   AGENT_FLOW_ANONYMIZE_CONTENT=none           every profile shows full content
 *   AGENT_FLOW_ANONYMIZE_CONTENT=hestia,sophia  only the listed profiles are anonymized
 *
 * and the relay flags `--anonymize-content=<value>` (same values; bare
 * `--anonymize-content` means `all`) and `--show-content` (means `none`).
 * A flag wins over the environment variable, the environment variable over the
 * default. Profiles that are not in a list follow {@link DEFAULT_ANONYMIZE}.
 * Per-profile overrides (relay config `anonymizeOverrides`, or the environment
 * variable AGENT_FLOW_ANONYMIZE_OVERRIDES=`hestia=on,sophia=off`) win over
 * everything above for the profile they name.
 *
 * What anonymized means (structure only, applied in the relay, so the full
 * text never reaches the browser):
 *   - a Bash command becomes its command name and character count
 *   - an edit or write becomes the file path and line counts
 *   - a message body becomes sender / platform (when known), role and length
 *   - a tool result becomes its size
 *   - a Kanban task title in the fleet view becomes its id and length
 * Whatever the setting, strings that look like secrets (API keys, tokens,
 * Bearer headers, password=...) are redacted from content that is shown; see
 * redactSecrets in scripts/hermes-transcript.ts.
 *
 * Unknown profile names (a name that is in the list but is not a Hermes
 * profile on this machine) never crash anything: they match no profile, so
 * every real profile keeps following the default, and a warning is logged.
 */

/**
 * Default for profiles the setting does not name. NOTE: the operator notes for
 * this task disagreed (one said default none = full content, another said
 * default ON); 'none' follows the one that states it replaces the earlier rule.
 * Changing this one value flips the default everywhere.
 */
export const DEFAULT_ANONYMIZE: 'all' | 'none' = 'none'

export const ANONYMIZE_ENV = 'AGENT_FLOW_ANONYMIZE_CONTENT'
export const ANONYMIZE_OVERRIDES_ENV = 'AGENT_FLOW_ANONYMIZE_OVERRIDES'

export interface AnonymizePolicy {
  /** 'all' | 'none' | 'list' */
  mode: 'all' | 'none' | 'list'
  /** Lower-cased profile names, for mode 'list' */
  profiles: ReadonlySet<string>
  /** Per-profile overrides (lower-cased name to anonymized on/off) */
  overrides: ReadonlyMap<string, boolean>
  /** What a profile not named by the setting does */
  defaultOn: boolean
}

export interface PolicyInput {
  /** The value of the setting (flag or env var); undefined or empty means the default */
  value?: string
  /** Per-profile overrides from the relay config */
  overrides?: Record<string, boolean>
  /** Warning sink; defaults to console.warn */
  warn?: (message: string) => void
}

const norm = (name: string) => name.trim().toLowerCase()

/** Parse `a=on,b=off` (also on/off/true/false/1/0/yes/no) into overrides. */
export function parseOverrides(raw: string | undefined, warn: (m: string) => void = console.warn): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const part of (raw ?? '').split(',')) {
    const item = part.trim()
    if (!item) continue
    const [name, flag] = item.split('=').map(s => s.trim())
    const on = /^(on|true|1|yes)$/i.test(flag ?? '')
    const off = /^(off|false|0|no)$/i.test(flag ?? '')
    if (!name || (!on && !off)) {
      warn(`[agent-flow] ignoring ${ANONYMIZE_OVERRIDES_ENV} entry "${item}": expected name=on or name=off`)
      continue
    }
    out[norm(name)] = on
  }
  return out
}

export function createAnonymizePolicy(input: PolicyInput = {}): AnonymizePolicy {
  const warn = input.warn ?? console.warn
  const defaultOn = DEFAULT_ANONYMIZE === 'all'
  const overrides = new Map<string, boolean>()
  for (const [k, v] of Object.entries(input.overrides ?? {})) overrides.set(norm(k), v)

  const tokens = (input.value ?? '').split(',').map(norm).filter(Boolean)
  let mode: AnonymizePolicy['mode'] = defaultOn ? 'all' : 'none'
  const profiles = new Set<string>()
  if (tokens.length > 0) {
    if (tokens.includes('all')) {
      mode = 'all'
      if (tokens.length > 1) warn('[agent-flow] AGENT_FLOW_ANONYMIZE_CONTENT: "all" combined with other values, using "all"')
    } else {
      const names = tokens.filter(t => t !== 'none')
      if (names.length === 0) {
        mode = 'none'
      } else {
        mode = 'list'
        for (const n of names) profiles.add(n)
        if (names.length !== tokens.length) warn('[agent-flow] AGENT_FLOW_ANONYMIZE_CONTENT: "none" combined with profile names, ignoring "none"')
      }
    }
  }
  return { mode, profiles, overrides, defaultOn }
}

/** True if this profile's content is shown as structure only. */
export function isAnonymized(policy: AnonymizePolicy, profile: string): boolean {
  const name = norm(profile)
  const override = policy.overrides.get(name)
  if (override !== undefined) return override
  if (policy.mode === 'all') return true
  if (policy.mode === 'none') return false
  return policy.profiles.has(name) ? true : policy.defaultOn
}

/**
 * Warn about names in the setting (or in the overrides) that are not Hermes
 * profiles on this machine. They match nothing and change nothing. Returns
 * the unknown names. Call once, after the profiles are known.
 */
export function warnUnknownProfiles(policy: AnonymizePolicy, known: Iterable<string>, warn: (m: string) => void = console.warn): string[] {
  const have = new Set([...known].map(norm))
  const named = [...policy.profiles, ...policy.overrides.keys()]
  const unknown = [...new Set(named)].filter(n => !have.has(n))
  if (unknown.length > 0) {
    warn(
      `[agent-flow] anonymize: unknown Hermes profile${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')} ` +
        `(known: ${[...have].sort().join(', ') || 'none'}); ${unknown.length > 1 ? 'they follow' : 'it follows'} the default (${policy.defaultOn ? 'anonymized' : 'full content'})`,
    )
  }
  return unknown
}

/** Describe the active policy in one line, for the relay's start-up log. */
export function describePolicy(policy: AnonymizePolicy): string {
  const base =
    policy.mode === 'all' ? 'all profiles anonymized'
    : policy.mode === 'none' ? 'full content for all profiles'
    : `anonymized: ${[...policy.profiles].join(', ')}; others ${policy.defaultOn ? 'anonymized' : 'full content'}`
  const ov = [...policy.overrides].map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ')
  return ov ? `${base}; overrides: ${ov}` : base
}

// ─── Structure-only views ───────────────────────────────────────────────────

const chars = (n: number) => `${n} char${n === 1 ? '' : 's'}`
const lines = (text: string) => (text === '' ? 0 : text.split('\n').length)

/** `git`, `pnpm`, ... from a shell command: the first word that is not an env assignment. */
export function commandName(command: string): string {
  for (const word of command.trim().split(/\s+/)) {
    if (!word || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    const base = word.replace(/^.*\//, '')
    return /^[A-Za-z0-9._+-]{1,40}$/.test(base) ? base : 'command'
  }
  return 'command'
}

export interface Structured {
  args: string
  inputData: Record<string, unknown>
}

/** Structure-only view of a tool call. Never copies a command, pattern, query or file body. */
export function anonymizeToolInput(hermesTool: string, input: Record<string, unknown>): Structured {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (hermesTool) {
    case 'terminal':
    case 'execute_code': {
      const text = s('command') || s('code')
      const label = hermesTool === 'terminal' ? `${commandName(text)} · ${chars(text.length)}` : `code · ${chars(text.length)}`
      return { args: label, inputData: { command: label } }
    }
    case 'patch': {
      const oldS = s('old_string')
      const newS = s('new_string') || s('patch')
      return {
        args: s('path'),
        inputData: { file_path: s('path'), old_string: `(${lines(oldS)} lines removed)`, new_string: `(${lines(newS)} lines added)` },
      }
    }
    case 'write_file': {
      const body = s('content')
      return { args: s('path'), inputData: { file_path: s('path'), content: `(${lines(body)} lines, ${chars(body.length)})` } }
    }
    case 'read_file':
      return { args: s('path'), inputData: { file_path: s('path') } }
    case 'search_files': {
      const label = `search · ${chars(s('pattern').length)}`
      return { args: label, inputData: { pattern: label, path: s('path') } }
    }
    default: {
      // Unknown tool: keep the shape, replace every string value by its length.
      const out: Record<string, unknown> = {}
      let total = 0
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string') {
          total += v.length
          out[k] = `(${chars(v.length)})`
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          out[k] = v
        } else {
          out[k] = '(structured value)'
        }
      }
      return { args: `${hermesTool} · ${chars(total)}`, inputData: out }
    }
  }
}

/** Structure-only view of a tool result: its size. */
export function anonymizeResult(text: string): string {
  return `(${lines(text)} line${lines(text) === 1 ? '' : 's'}, ${chars(text.length)})`
}

/** Structure-only view of a message body: who, where, how long. */
export function anonymizeMessage(role: string, length: number, from?: { user?: string; platform?: string }): string {
  const who = from?.user ? ` from ${from.user}${from.platform ? ` via ${from.platform}` : ''}` : ''
  return `${role} message${who} · ${chars(length)}`
}

/** Structure-only Kanban task title for the fleet view. */
export function anonymizeTaskTitle(taskId: string, title: string | null): string {
  return title === null ? taskId : `${taskId} (title hidden, ${chars(title.length)})`
}
