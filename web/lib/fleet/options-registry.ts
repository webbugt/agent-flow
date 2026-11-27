/**
 * Options registry: the one place that owns the client-side options of Agent Flow.
 *
 * Everything lives in ONE localStorage key (OPTIONS_KEY) as one versioned JSON object. Pure functions on an
 * injected Storage, so they are testable without a DOM. This module never touches any other key; the old
 * keys (fleet selection, timeline, cost unit, sound) are copied into it once by options-migration.ts.
 *
 * Objects are treated as immutable: `applyOptionsPatch` shares the arrays/objects it did not change with the
 * previous options, so a consumer can keep a cheap identity check (for example on `fleetDeselected`).
 *
 * Validation rules:
 * - `validateOptions` is tolerant (used on load): a bad or missing field falls back to its default, the rest is kept.
 *   A wrong or missing `version` is not understood at all: the defaults are used and the error is reported.
 * - `applyOptionsPatch` is strict (used by the panel): if any value in the patch is bad, nothing is applied
 *   and the reasons are returned. A section of the wrong shape (for example `lingerSeconds: 5`) is an error.
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

/** Cap on the stored list of hidden fleet agents/lanes (same cap the old fleet-selection key had). */
export const MAX_DESELECTED_IDS = 2000
export const MAX_DESELECTED_ID_LENGTH = 300

/** The unit the cost header toggle can show. */
export const COST_UNITS = ['money', 'kwh', 'tokens'] as const
export type CostUnit = (typeof COST_UNITS)[number]
/** What the costs config's `display.unit` can be (a toggle choice is remembered against it). */
export const COST_CONFIG_UNITS = ['auto', 'money', 'kwh', 'tokens'] as const
export type CostConfigUnit = (typeof COST_CONFIG_UNITS)[number]

/** The header toggle's choice and the config default it was chosen against (see lib/costs/overlay.ts). */
export interface CostUnitChoice {
  unit: CostUnit
  cfg: CostConfigUnit
}

export interface AgentFlowOptions {
  version: typeof OPTIONS_VERSION
  /** Seconds a block of this kind stays fully visible after its last use. 0 = hide immediately. */
  lingerSeconds: Record<ResourceKind, number>
  /** Seconds the block fades out after the linger window. 0 = hard cut. */
  fadeSeconds: number
  /** Whether blocks of this kind are shown, separately for the single-session and the fleet view. */
  show: Record<BlockView, Record<ResourceKind, boolean>>
  /** Sound effects on. Default off (muted). Was localStorage `agent-viz-sound`. */
  soundOn: boolean
  /** Fleet timeline panel shown. Default true. Was `agent-flow:fleet-timeline-visible:v1`. */
  fleetTimelineVisible: boolean
  /** Screensaver zooms the fleet map to fit every drawn node. Default true. Off: the camera stays where the user left it. */
  screensaverAutoFit: boolean
  /** Cost header unit chosen by the user, or null = follow the config default. Was `agentFlow.costUnit`. */
  costUnit: CostUnitChoice | null
  /** Ids of fleet agents/lanes hidden by the user (deselected). Default none. Was `agent-flow:fleet-selection:v1`. */
  fleetDeselected: string[]
  /** True once the old localStorage keys were copied in (options-migration.ts). Not editable in the panel. */
  legacyMigrated: boolean
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
    soundOn: false,
    fleetTimelineVisible: true,
    screensaverAutoFit: true,
    costUnit: null,
    fleetDeselected: [],
    legacyMigrated: false,
  }
}

export interface OptionsPatch {
  lingerSeconds?: Partial<Record<ResourceKind, unknown>>
  fadeSeconds?: unknown
  show?: Partial<Record<BlockView, Partial<Record<ResourceKind, unknown>>>>
  soundOn?: unknown
  fleetTimelineVisible?: unknown
  screensaverAutoFit?: unknown
  /** null = follow the config default again. */
  costUnit?: unknown
  fleetDeselected?: unknown
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

function checkCostUnit(v: unknown): string | null {
  if (v === null) return null
  if (!isRecord(v)) return 'must be null or { unit, cfg }'
  if (typeof v.unit !== 'string' || !(COST_UNITS as readonly string[]).includes(v.unit)) return `unit must be one of ${COST_UNITS.join(', ')}`
  if (typeof v.cfg !== 'string' || !(COST_CONFIG_UNITS as readonly string[]).includes(v.cfg)) return `cfg must be one of ${COST_CONFIG_UNITS.join(', ')}`
  return null
}

function checkIdList(v: unknown): string | null {
  if (!Array.isArray(v)) return 'must be a list'
  if (v.length > MAX_DESELECTED_IDS) return `must have at most ${MAX_DESELECTED_IDS} entries`
  if (!v.every(x => typeof x === 'string' && x !== '' && x.length <= MAX_DESELECTED_ID_LENGTH)) {
    return `must hold non-empty strings of at most ${MAX_DESELECTED_ID_LENGTH} characters`
  }
  return null
}

/** De-duplicated copy, first-seen order. */
function uniqueIds(v: readonly string[]): string[] {
  return [...new Set(v)]
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
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
  // A different (or missing) version is not understood: use the defaults rather than guess what the fields mean.
  if (input.version !== OPTIONS_VERSION) return { options, errors: [`version must be ${OPTIONS_VERSION}`] }

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
  if (input.soundOn !== undefined) {
    if (typeof input.soundOn !== 'boolean') errors.push('soundOn must be true or false')
    else options.soundOn = input.soundOn
  }
  if (input.fleetTimelineVisible !== undefined) {
    if (typeof input.fleetTimelineVisible !== 'boolean') errors.push('fleetTimelineVisible must be true or false')
    else options.fleetTimelineVisible = input.fleetTimelineVisible
  }
  if (input.screensaverAutoFit !== undefined) {
    if (typeof input.screensaverAutoFit !== 'boolean') errors.push('screensaverAutoFit must be true or false')
    else options.screensaverAutoFit = input.screensaverAutoFit
  }
  if (input.costUnit !== undefined) {
    const err = checkCostUnit(input.costUnit)
    if (err) errors.push(`costUnit ${err}`)
    else {
      const c = input.costUnit as CostUnitChoice | null
      options.costUnit = c === null ? null : { unit: c.unit, cfg: c.cfg }
    }
  }
  if (input.fleetDeselected !== undefined) {
    const err = checkIdList(input.fleetDeselected)
    if (err) errors.push(`fleetDeselected ${err}`)
    else options.fleetDeselected = uniqueIds(input.fleetDeselected as string[])
  }
  if (input.legacyMigrated !== undefined) {
    if (typeof input.legacyMigrated !== 'boolean') errors.push('legacyMigrated must be true or false')
    else options.legacyMigrated = input.legacyMigrated
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
 * Unknown kinds or views in the patch are errors too (a typo must not silently do nothing), and so is a
 * section of the wrong shape. `legacyMigrated` is not patchable (only the migration sets it).
 */
export function applyOptionsPatch(current: AgentFlowOptions, patch: OptionsPatch): PatchResult {
  const errors: string[] = []
  const next: AgentFlowOptions = {
    version: OPTIONS_VERSION,
    lingerSeconds: { ...current.lingerSeconds },
    fadeSeconds: current.fadeSeconds,
    show: { single: { ...current.show.single }, fleet: { ...current.show.fleet } },
    // Shared with `current` unless the patch replaces them (immutable by convention, see the file header).
    soundOn: current.soundOn,
    fleetTimelineVisible: current.fleetTimelineVisible,
    screensaverAutoFit: current.screensaverAutoFit,
    costUnit: current.costUnit,
    fleetDeselected: current.fleetDeselected,
    legacyMigrated: current.legacyMigrated,
  }
  if (patch.lingerSeconds !== undefined) {
    if (!isRecord(patch.lingerSeconds)) errors.push('lingerSeconds must be an object')
    else {
      for (const [k, v] of Object.entries(patch.lingerSeconds)) {
        if (!isResourceKind(k)) { errors.push(`unknown kind "${k}"`); continue }
        const err = checkSeconds(v, MAX_LINGER_SECONDS)
        if (err) errors.push(`lingerSeconds.${k} ${err}`)
        else next.lingerSeconds[k] = v as number
      }
    }
  }
  if (patch.fadeSeconds !== undefined) {
    const err = checkSeconds(patch.fadeSeconds, MAX_FADE_SECONDS)
    if (err) errors.push(`fadeSeconds ${err}`)
    else next.fadeSeconds = patch.fadeSeconds as number
  }
  if (patch.show !== undefined) {
    if (!isRecord(patch.show)) errors.push('show must be an object')
    else {
      for (const [view, kinds] of Object.entries(patch.show)) {
        if (view !== 'single' && view !== 'fleet') { errors.push(`unknown view "${view}"`); continue }
        if (!isRecord(kinds)) { errors.push(`show.${view} must be an object`); continue }
        for (const [k, v] of Object.entries(kinds)) {
          if (!isResourceKind(k)) { errors.push(`unknown kind "${k}"`); continue }
          if (typeof v !== 'boolean') errors.push(`show.${view}.${k} must be true or false`)
          else next.show[view][k] = v
        }
      }
    }
  }
  if (patch.soundOn !== undefined) {
    if (typeof patch.soundOn !== 'boolean') errors.push('soundOn must be true or false')
    else next.soundOn = patch.soundOn
  }
  if (patch.fleetTimelineVisible !== undefined) {
    if (typeof patch.fleetTimelineVisible !== 'boolean') errors.push('fleetTimelineVisible must be true or false')
    else next.fleetTimelineVisible = patch.fleetTimelineVisible
  }
  if (patch.screensaverAutoFit !== undefined) {
    if (typeof patch.screensaverAutoFit !== 'boolean') errors.push('screensaverAutoFit must be true or false')
    else next.screensaverAutoFit = patch.screensaverAutoFit
  }
  if (patch.costUnit !== undefined) {
    const err = checkCostUnit(patch.costUnit)
    if (err) errors.push(`costUnit ${err}`)
    else {
      const c = patch.costUnit as CostUnitChoice | null
      const cur = current.costUnit
      const same = c === null ? cur === null : cur !== null && c.unit === cur.unit && c.cfg === cur.cfg
      if (!same) next.costUnit = c === null ? null : { unit: c.unit, cfg: c.cfg }
    }
  }
  if (patch.fleetDeselected !== undefined) {
    const err = checkIdList(patch.fleetDeselected)
    if (err) errors.push(`fleetDeselected ${err}`)
    else {
      const ids = uniqueIds(patch.fleetDeselected as string[])
      if (!sameList(ids, current.fleetDeselected)) next.fleetDeselected = ids
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, options: next }
}
