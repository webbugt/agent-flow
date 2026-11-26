/**
 * Options registry: the one place that owns the client-side options of Agent Flow.
 *
 * Everything lives in ONE localStorage key (OPTIONS_KEY) as one versioned JSON object. Pure functions on an
 * injected Storage, so they are testable without a DOM. This module never touches any other key; the old
 * keys (fleet selection, timeline, cost unit, sound) are migrated into it by a later card.
 *
 * Validation rules:
 * - `validateOptions` is tolerant (used on load): a bad or missing field falls back to its default, the rest is kept.
 * - `applyOptionsPatch` is strict (used by the panel): if any value in the patch is bad, nothing is applied
 *   and the reasons are returned.
 * - `saveOptions` never writes an invalid object.
 */

export const OPTIONS_KEY = 'agentflow.options.v1'
export const OPTIONS_VERSION = 1

export const RESOURCE_KINDS = ['kanban', 'memory', 'bash', 'subsystem'] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]
export type BlockView = 'single' | 'fleet'
export const BLOCK_VIEWS: readonly BlockView[] = ['single', 'fleet']

export function isResourceKind(v: unknown): v is ResourceKind {
  return typeof v === 'string' && (RESOURCE_KINDS as readonly string[]).includes(v)
}

/** Upper bounds (seconds), so a typo cannot keep a block on screen for days. */
export const MAX_LINGER_SECONDS = 3600
export const MAX_FADE_SECONDS = 600

/** Default linger per kind, seconds. 0 means "hide immediately". */
export const DEFAULT_LINGER_SECONDS: Readonly<Record<ResourceKind, number>> = {
  kanban: 90,
  memory: 60,
  bash: 20,
  subsystem: 45,
}
/** Default fade after the linger window, seconds. */
export const DEFAULT_FADE_SECONDS = 15

export interface AgentFlowOptions {
  version: typeof OPTIONS_VERSION
  /** Seconds a block of this kind stays fully visible after its last use. 0 = hide immediately. */
  lingerSeconds: Record<ResourceKind, number>
  /** Seconds the block fades out after the linger window. 0 = hard cut. */
  fadeSeconds: number
  /** Whether blocks of this kind are shown, separately for the single-session and the fleet view. */
  show: Record<BlockView, Record<ResourceKind, boolean>>
}

function perKind<T>(value: (k: ResourceKind) => T): Record<ResourceKind, T> {
  return { kanban: value('kanban'), memory: value('memory'), bash: value('bash'), subsystem: value('subsystem') }
}

/** A fresh defaults object (never shared, so a caller cannot mutate the defaults). */
export function defaultOptions(): AgentFlowOptions {
  return {
    version: OPTIONS_VERSION,
    lingerSeconds: perKind(k => DEFAULT_LINGER_SECONDS[k]),
    fadeSeconds: DEFAULT_FADE_SECONDS,
    show: { single: perKind(() => true), fleet: perKind(() => true) },
  }
}

export interface OptionsPatch {
  lingerSeconds?: Partial<Record<ResourceKind, unknown>>
  fadeSeconds?: unknown
  show?: Partial<Record<BlockView, Partial<Record<ResourceKind, unknown>>>>
}

export interface ValidationResult {
  options: AgentFlowOptions
  /** One message per rejected value. Empty when everything was valid. */
  errors: string[]
}

function checkSeconds(v: unknown, max: number): string | null {
  if (typeof v !== 'number') return 'must be a number'
  if (!Number.isFinite(v)) return 'must be a finite number'
  if (v < 0) return 'must not be negative'
  if (v > max) return `must be at most ${max}`
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Build a valid options object from untrusted input. Bad values fall back to the defaults and are reported
 * in `errors`; unknown fields are dropped. `null`/`undefined` is "nothing stored": defaults, no errors.
 */
export function validateOptions(input: unknown): ValidationResult {
  const options = defaultOptions()
  const errors: string[] = []
  if (input === null || input === undefined) return { options, errors }
  if (!isRecord(input)) return { options, errors: ['options must be an object'] }
  if (input.version !== OPTIONS_VERSION) errors.push(`version must be ${OPTIONS_VERSION}`)

  if (input.lingerSeconds !== undefined) {
    if (!isRecord(input.lingerSeconds)) errors.push('lingerSeconds must be an object')
    else {
      for (const k of RESOURCE_KINDS) {
        const v = input.lingerSeconds[k]
        if (v === undefined) continue
        const err = checkSeconds(v, MAX_LINGER_SECONDS)
        if (err) errors.push(`lingerSeconds.${k} ${err}`)
        else options.lingerSeconds[k] = v as number
      }
    }
  }
  if (input.fadeSeconds !== undefined) {
    const err = checkSeconds(input.fadeSeconds, MAX_FADE_SECONDS)
    if (err) errors.push(`fadeSeconds ${err}`)
    else options.fadeSeconds = input.fadeSeconds as number
  }
  if (input.show !== undefined) {
    if (!isRecord(input.show)) errors.push('show must be an object')
    else {
      for (const view of BLOCK_VIEWS) {
        const sv = input.show[view]
        if (sv === undefined) continue
        if (!isRecord(sv)) { errors.push(`show.${view} must be an object`); continue }
        for (const k of RESOURCE_KINDS) {
          const v = sv[k]
          if (v === undefined) continue
          if (typeof v !== 'boolean') errors.push(`show.${view}.${k} must be true or false`)
          else options.show[view][k] = v
        }
      }
    }
  }
  return { options, errors }
}

/** Parse the stored string. Anything malformed yields the defaults. */
export function parseOptions(raw: string | null | undefined): AgentFlowOptions {
  if (!raw) return defaultOptions()
  try {
    return validateOptions(JSON.parse(raw)).options
  } catch {
    return defaultOptions()
  }
}

export function serializeOptions(options: AgentFlowOptions): string {
  return JSON.stringify(options)
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function loadOptions(storage: StorageLike | null | undefined): AgentFlowOptions {
  if (!storage) return defaultOptions()
  try {
    return parseOptions(storage.getItem(OPTIONS_KEY))
  } catch {
    return defaultOptions()
  }
}

/**
 * Write the options under OPTIONS_KEY. Returns false when the object is invalid (nothing is written) or the
 * write failed (quota, private mode); the options still work in memory.
 */
export function saveOptions(storage: StorageLike | null | undefined, options: AgentFlowOptions): boolean {
  if (!storage) return false
  if (validateOptions(options).errors.length > 0) return false
  try {
    storage.setItem(OPTIONS_KEY, serializeOptions(options))
    return true
  } catch {
    return false
  }
}

export type PatchResult = { ok: true; options: AgentFlowOptions } | { ok: false; errors: string[] }

/**
 * Strict update for the panel: apply `patch` on top of `current` only if every value in it is valid.
 * Unknown kinds or views in the patch are errors too (a typo must not silently do nothing).
 */
export function applyOptionsPatch(current: AgentFlowOptions, patch: OptionsPatch): PatchResult {
  const errors: string[] = []
  const next: AgentFlowOptions = {
    version: OPTIONS_VERSION,
    lingerSeconds: { ...current.lingerSeconds },
    fadeSeconds: current.fadeSeconds,
    show: { single: { ...current.show.single }, fleet: { ...current.show.fleet } },
  }
  if (patch.lingerSeconds !== undefined) {
    for (const [k, v] of Object.entries(patch.lingerSeconds)) {
      if (!isResourceKind(k)) { errors.push(`unknown kind "${k}"`); continue }
      const err = checkSeconds(v, MAX_LINGER_SECONDS)
      if (err) errors.push(`lingerSeconds.${k} ${err}`)
      else next.lingerSeconds[k] = v as number
    }
  }
  if (patch.fadeSeconds !== undefined) {
    const err = checkSeconds(patch.fadeSeconds, MAX_FADE_SECONDS)
    if (err) errors.push(`fadeSeconds ${err}`)
    else next.fadeSeconds = patch.fadeSeconds as number
  }
  if (patch.show !== undefined) {
    for (const [view, kinds] of Object.entries(patch.show)) {
      if (view !== 'single' && view !== 'fleet') { errors.push(`unknown view "${view}"`); continue }
      for (const [k, v] of Object.entries(kinds ?? {})) {
        if (!isResourceKind(k)) { errors.push(`unknown kind "${k}"`); continue }
        if (typeof v !== 'boolean') errors.push(`show.${view}.${k} must be true or false`)
        else next.show[view][k] = v
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, options: next }
}
