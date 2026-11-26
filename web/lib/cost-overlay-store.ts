/**
 * Small client-side store of the cost overlay: the unit the header toggle selected, and the pill rectangles
 * of the last drawn frame (so pointer events can find the pill under the cursor).
 *
 * The toggle's choice lives in the options registry (`costUnit`, see lib/options-store.ts), so the options panel
 * and the header toggle edit the same value. It was localStorage `agentFlow.costUnit` before; the one-time
 * migration copies it (lib/fleet/options-migration.ts).
 *
 * The toggle's choice is a per-device override of the config's `display.unit`. It remembers the default it was
 * chosen against and stops applying when that default changes (lib/costs/overlay.ts activeUnitOverride), so the
 * drawer's "Default unit" is never silently shadowed.
 */
import { effectiveCosts, getActiveCosts } from './costs/active'
import {
  activeUnitOverride, nextUnit, resolveUnit,
  type OverlayUnit, type CostPillRect, type UnitOverride,
} from './costs/overlay'
import { getOptions, optionsVersion, subscribeOptions, updateOptions } from './options-store'

function storedOverride(): UnitOverride | null {
  const c = getOptions().costUnit
  return c ? { unit: c.unit, cfgUnit: c.cfg } : null
}

let forgetScheduled = false
/** Forget a choice that no longer applies, but not inside a render or a draw frame (it notifies subscribers). */
function scheduleForget(): void {
  if (forgetScheduled) return
  forgetScheduled = true
  queueMicrotask(() => {
    forgetScheduled = false
    const o = storedOverride()
    const active = getActiveCosts()
    if (o !== null && activeUnitOverride(o, active ? active.display.unit : null) === null) updateOptions({ costUnit: null })
  })
}

/** The toggle's choice if it still applies (the config's default unit is what it was chosen against), else null. A choice that no longer applies is forgotten shortly after. */
export function getOverlayOverride(): OverlayUnit | null {
  const o = storedOverride()
  const active = getActiveCosts()
  const live = activeUnitOverride(o, active ? active.display.unit : null)
  if (live === null && o !== null) scheduleForget()
  return live
}

/** The unit in effect: the user's toggle if it still applies, else the config's `display.unit` (auto = money). */
export function getOverlayUnit(): OverlayUnit {
  return resolveUnit(effectiveCosts(), getOverlayOverride())
}

export function setOverlayUnit(u: OverlayUnit): void {
  updateOptions({ costUnit: { unit: u, cfg: effectiveCosts().display.unit } })
}

/** Drop the toggle's choice and follow the config's default unit again. */
export function clearOverlayUnit(): void {
  updateOptions({ costUnit: null })
}

export function cycleOverlayUnit(): OverlayUnit {
  const u = nextUnit(getOverlayUnit())
  setOverlayUnit(u)
  return u
}

/** Changes whenever the options change (a superset of the unit changing); use with subscribeOverlayUnit. */
export function overlayUnitVersion(): number { return optionsVersion() }

export function subscribeOverlayUnit(fn: () => void): () => void {
  return subscribeOptions(fn)
}

/** Test helper. */
export function resetOverlayUnit(): void {
  clearOverlayUnit()
}

// ── pill rectangles of the last frame (canvas/world coordinates) ────────────

let pillRects: CostPillRect[] = []

export function setCostPillRects(rects: CostPillRect[]): void { pillRects = rects }
export function getCostPillRects(): readonly CostPillRect[] { return pillRects }
