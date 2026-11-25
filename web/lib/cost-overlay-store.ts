/**
 * Small client-side store of the cost overlay: the unit the header toggle selected, and the pill rectangles
 * of the last drawn frame (so pointer events can find the pill under the cursor). Lives outside lib/costs/
 * because it touches localStorage; the label logic stays pure in lib/costs/overlay.ts.
 */
import { effectiveCosts } from './costs/active'
import { resolveUnit, nextUnit, OVERLAY_UNITS, type OverlayUnit, type CostPillRect } from './costs/overlay'

const KEY = 'agentFlow.costUnit'

let override: OverlayUnit | null = null
let loaded = false
let version = 0
const listeners = new Set<() => void>()

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    if (v && (OVERLAY_UNITS as readonly string[]).includes(v)) override = v as OverlayUnit
  } catch { /* storage unavailable: the config default applies */ }
}

function emit(): void {
  version++
  for (const l of [...listeners]) l()
}

/** The unit in effect: the user's toggle if they used it, else the config's `display.unit` (auto = money). */
export function getOverlayUnit(): OverlayUnit {
  load()
  return resolveUnit(effectiveCosts(), override)
}

export function setOverlayUnit(u: OverlayUnit): void {
  load()
  override = u
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, u) } catch { /* ignore */ }
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
  emit()
}

// ── pill rectangles of the last frame (canvas/world coordinates) ────────────

let pillRects: CostPillRect[] = []

export function setCostPillRects(rects: CostPillRect[]): void { pillRects = rects }
export function getCostPillRects(): readonly CostPillRect[] { return pillRects }
