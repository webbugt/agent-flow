/**
 * Config layers: merge and validate what the host (extension host or relay) read from disk. Pure, no I/O.
 *
 * The host cannot validate (extension/src must not import web/lib: tsconfig rootDir), so it ships the
 * parsed JSON of every layer and this module does the rest, once, for every surface:
 *
 *   precedence (highest first):  project .agent-flow/costs.json  >  user costs.json  >  VS Code scalars  >  catalog
 *
 *  1. Every layer is validated ALONE with validateConfig, so an error points at the file that has it.
 *  2. A layer that fails keeps its previous good content ("last good"); with no previous content it is dropped.
 *  3. The good layers are merged (objects deep-merged, arrays replaced, except `pricing.models`, which is
 *     concatenated highest layer first so a project rule wins a tie) and the result is validated again, which
 *     catches cross-layer problems (e.g. a currency with no fx entry). On failure the previous merged config stays.
 *  4. The result carries every error and warning with its layer, file and JSON pointer, for the error banner.
 *
 * Merging never reads a key that validation rejects: poisoned keys (`__proto__`, `constructor`, `prototype`)
 * fail the layer-level validation first, and merged objects are null-prototype dictionaries.
 */
import { validateConfig } from './validate'
import type { ResolvedConfig, ValidationIssue } from './types'

export type CostsLayerId = 'settings' | 'user' | 'project'
/** Lowest precedence first. */
export const LAYER_ORDER: readonly CostsLayerId[] = ['settings', 'user', 'project']

export type CostsLayerStatus = 'ok' | 'missing' | 'error'

/** One config source as the host read it. Mirror of `CostsConfigLayer` in extension/src/protocol.ts. */
export interface CostsLayer {
  id: CostsLayerId
  /** Display path (home shown as `~`); null for the VS Code settings layer. */
  path: string | null
  status: CostsLayerStatus
  /** Parsed JSON object. Present when status is `ok`, or `error` with `stale` (the host's last good copy). */
  raw?: Record<string, unknown>
  /** `raw` is the previous good content because the file now fails to read or parse. */
  stale?: boolean
  /** Host-side problem: unreadable, too large, not JSON, not an object, resolves outside its directory. */
  error?: string
  /** Host-side notes, e.g. an ignored key. */
  warnings?: string[]
}

/** The `costs-config` message body. Mirror of `CostsConfigPayload` in extension/src/protocol.ts. */
export interface CostsConfigPayload {
  version: 1
  /** Increases on every change the host publishes. */
  seq: number
  /** VS Code setting `agentVisualizer.costs.enabled`; false = built-in pricing, files ignored. */
  enabled: boolean
  layers: CostsLayer[]
}

export interface LayerIssue extends ValidationIssue {
  layer: CostsLayerId | 'merged'
  /** Display path of the file the issue belongs to (null for settings and cross-layer issues). */
  file: string | null
}

export interface CostsResolution {
  /** The config to price with; null = built-in defaults (legacy pricing path). */
  config: ResolvedConfig | null
  /** `config` when at least one layer with content produced it. */
  source: 'defaults' | 'config'
  errors: LayerIssue[]
  warnings: LayerIssue[]
  /** True when an error left some layer (or the whole config) at its previous good state. */
  usingLastGood: boolean
  /** Validated raw content per layer, kept for the next resolution. */
  goodLayers: Partial<Record<CostsLayerId, Record<string, unknown>>>
  seq: number
}

export function emptyResolution(): CostsResolution {
  return { config: null, source: 'defaults', errors: [], warnings: [], usingLastGood: false, goodLayers: {}, seq: 0 }
}

type Obj = Record<string, unknown>

function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

/** Arrays at these paths are concatenated (higher layer first) instead of replaced. */
const CONCAT_PATHS: readonly string[] = ['pricing.models']

function mergeInto(base: Obj, over: Obj, path: string): Obj {
  const out: Obj = Object.create(null)
  for (const k of Object.keys(base)) out[k] = base[k]
  for (const k of Object.keys(over)) {
    const here = path ? `${path}.${k}` : k
    const a = out[k]
    const b = over[k]
    if (isPlainObject(a) && isPlainObject(b)) out[k] = mergeInto(a, b, here)
    else if (Array.isArray(a) && Array.isArray(b) && CONCAT_PATHS.includes(here)) out[k] = [...b, ...a]
    else out[k] = b
  }
  return out
}

/** Merge raw documents, lowest precedence first. Inputs are not modified. */
export function mergeRaw(docsLowToHigh: readonly Obj[]): Obj {
  let acc: Obj = Object.create(null)
  for (const d of docsLowToHigh) acc = mergeInto(acc, d, '')
  return acc
}

function issues(layer: CostsLayerId | 'merged', file: string | null, list: readonly ValidationIssue[]): LayerIssue[] {
  return list.map(i => ({ layer, file, path: i.path, message: i.message }))
}

/**
 * Resolve a `costs-config` payload into the config to use. `prev` is the previous resolution (last good);
 * pass `emptyResolution()` the first time.
 */
export function resolveCostsLayers(payload: CostsConfigPayload, prev: CostsResolution = emptyResolution()): CostsResolution {
  if (!payload.enabled) {
    return { ...emptyResolution(), seq: payload.seq }
  }
  const errors: LayerIssue[] = []
  const warnings: LayerIssue[] = []
  const good: Partial<Record<CostsLayerId, Obj>> = {}
  let usingLastGood = false

  const byId = new Map<CostsLayerId, CostsLayer>()
  for (const l of payload.layers) byId.set(l.id, l)

  for (const id of LAYER_ORDER) {
    const layer = byId.get(id)
    if (!layer || layer.status === 'missing') continue // file deleted or never there: the layer is gone, not "last good"
    const file = layer.path
    for (const w of layer.warnings ?? []) warnings.push({ layer: id, file, path: '', message: w })
    if (layer.status === 'error') errors.push({ layer: id, file, path: '', message: layer.error ?? 'could not be read' })

    const candidate = layer.raw // `ok`, or `error` with the host's stale copy
    if (candidate !== undefined) {
      const v = validateConfig(candidate)
      for (const w of v.warnings) warnings.push({ layer: id, file, path: w.path, message: w.message })
      if (v.ok) {
        good[id] = candidate
        if (layer.stale) usingLastGood = true
        continue
      }
      errors.push(...issues(id, file, v.errors))
    }
    // No usable content now: fall back to what this layer held last time.
    const before = prev.goodLayers[id]
    if (before !== undefined) { good[id] = before; usingLastGood = true }
  }

  const ordered = LAYER_ORDER.map(id => good[id]).filter((d): d is Obj => d !== undefined)
  if (ordered.length === 0) {
    return { config: null, source: 'defaults', errors, warnings, usingLastGood, goodLayers: {}, seq: payload.seq }
  }
  const merged = mergeRaw(ordered)
  const v = validateConfig(merged)
  if (!v.ok || v.config === null) {
    // Every layer is fine alone but the combination is not (cross-layer reference): keep the previous result.
    errors.push(...issues('merged', null, v.errors))
    const keep = prev.config !== null
    return {
      config: prev.config, source: keep ? 'config' : 'defaults', errors, warnings, usingLastGood: keep || usingLastGood,
      goodLayers: keep ? prev.goodLayers : {}, seq: payload.seq,
    }
  }
  for (const w of v.warnings) {
    if (!warnings.some(x => x.path === w.path && x.message === w.message)) warnings.push({ layer: 'merged', file: null, path: w.path, message: w.message })
  }
  return { config: v.config, source: 'config', errors, warnings, usingLastGood, goodLayers: good, seq: payload.seq }
}

/** One banner line: `~/.agent-flow/costs.json /currency/display: must be ...`. */
export function describeIssue(i: LayerIssue): string {
  const where = i.file ?? (i.layer === 'settings' ? 'VS Code settings' : i.layer === 'merged' ? 'merged config' : i.layer)
  return `${where} ${i.path === '' ? '(document)' : i.path}: ${i.message}`
}
