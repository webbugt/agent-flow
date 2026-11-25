/**
 * Small client-side store of the cost overlay: the unit the header toggle selected, and the pill rectangles
 * of the last drawn frame (so pointer events can find the pill under the cursor). Lives outside lib/costs/
 * because it touches localStorage; the label logic stays pure in lib/costs/overlay.ts.
 *
 * The toggle's choice is a per-device override of the config's `display.unit`. It remembers the default it was
 * chosen against and stops applying when that default changes (lib/costs/overlay.ts activeUnitOverride), so the
 * drawer's "Default unit" is never silently shadowed.
 */
import { effectiveCosts, getActiveCosts } from './costs/active'
import {
  activeUnitOverride, nextUnit, parseUnitOverride, resolveUnit, serializeUnitOverride,
  type OverlayUnit, type CostPillRect, type UnitOverride,
} from './costs/overlay'

const KEY = 'agentFlow.costUnit'

let override: UnitOverride | null = null
let loaded = false
let version = 0
const listeners = new Set<() => void>()

function load(): void {
  if (loaded) return
  loaded = true
  try {
    override = parseUnitOverride(typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null)
  } catch { /* storage unavailable: the config default applies */ }
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (override) localStorage.setItem(KEY, serializeUnitOverride(override))
    else localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}

function emit(): void {
  version++
  for (const l of [...listeners]) l()
}

/** The toggle's choice if it still applies (the config's default unit is what it was chosen against), else null. Forgets a choice that no longer applies. */
export function getOverlayOverride(): OverlayUnit | null {
  load()
  const active = getActiveCosts()
  const live = activeUnitOverride(override, active ? active.display.unit : null)
  if (live === null && override !== null) { override = null; persist() }
  return live
}

/** The unit in effect: the user's toggle if it still applies, else the config's `display.unit` (auto = money). */
export function getOverlayUnit(): OverlayUnit {
  return resolveUnit(effectiveCosts(), getOverlayOverride())
}

export function setOverlayUnit(u: OverlayUnit): void {
  load()
  override = { unit: u, cfgUnit: effectiveCosts().display.unit }
  persist()
  emit()
}

/** Drop the toggle's choice and follow the config's default unit again. */
export function clearOverlayUnit(): void {
  load()
  if (override === null) return
  override = null
  persist()
  emit()
}

export function cycleOverlayUnit(): OverlayUnit {
  const u = nextUnit(getOverlayUnit())
  setOverlayUnit(u)
  return u
}

export function overlayUnitVersion(): number { return version }

export function subscribeOverlayUnit(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Test helper. */
export function resetOverlayUnit(): void {
  override = null
  loaded = true
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY) } catch { /* ignore */ }
  emit()
}

// ── pill rectangles of the last frame (canvas/world coordinates) ────────────

let pillRects: CostPillRect[] = []

export function setCostPillRects(rects: CostPillRect[]): void { pillRects = rects }
export function getCostPillRects(): readonly CostPillRect[] { return pillRects }
