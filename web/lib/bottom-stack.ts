/**
 * Geometry shared by the panels that sit at the bottom or below the top bar.
 *
 * The control bar, the LIMITS panel and the top bar each publish where their edge is as a CSS variable on <html>
 * (see `publishInset`). Every bottom panel (timelines, node card, resource blocks) sits above the highest of the
 * two bottom variables, so they form ONE stack instead of drawing over each other, and no panel is taller than the
 * space between the top bar and that stack (landscape phones are 390 px high: a fixed 300 px panel used to put its
 * title row, and the only close control, above the screen).
 *
 * Plain strings and numbers only: the unit tests read them without a DOM.
 */

/** CSS variable: distance from the bottom of the screen to the TOP of the control bar, px. */
export const VAR_BAR_TOP = '--af-bar-top'
/** CSS variable: distance from the bottom of the screen to the TOP of the LIMITS panel while it is stacked above the bar, px (0 = not stacked). */
export const VAR_LIMITS_TOP = '--af-limits-top'
/** CSS variable: distance from the top of the screen to the BOTTOM of the top bar, px (published by the top bar). */
export const VAR_TOP_BAR_BOTTOM = '--af-top-bar-bottom'

/** Where the control bar's top edge is before it has measured itself: 16 px margin + a one-row bar. */
export const DEFAULT_BAR_TOP_PX = 72
/** Gap between two stacked panels, px. */
export const STACK_GAP_PX = 8

/** `bottom:` of a panel that sits on the stack: above the control bar and, when stacked, the LIMITS panel. */
export const STACK_BOTTOM = `calc(max(var(${VAR_BAR_TOP}, ${DEFAULT_BAR_TOP_PX}px), var(${VAR_LIMITS_TOP}, 0px)) + ${STACK_GAP_PX}px)`

/** `top:` of a sheet that opens below the top bar and its tab rows (36 px when the bar has not measured itself). */
export const BELOW_TOP_BAR = `max(36px, calc(var(${VAR_TOP_BAR_BOTTOM}, 0px) + 4px))`

/** Smallest height a capped panel keeps (title row + a few rows of content), px. */
export const MIN_PANEL_HEIGHT_PX = 140

/**
 * `max-height` of a bottom panel: the free height between the top bar and the stack. Never below
 * MIN_PANEL_HEIGHT_PX, so the title row, the legend and a little content always fit.
 */
export const STACK_PANEL_MAX_HEIGHT = `max(${MIN_PANEL_HEIGHT_PX}px, calc(100dvh - var(${VAR_TOP_BAR_BOTTOM}, 48px) - ${STACK_BOTTOM} - ${STACK_GAP_PX}px))`

/** Viewport width below which the LIMITS panel folds itself when another bottom panel is open. */
export const LIMITS_AUTO_FOLD_PX = 768

/** The LIMITS panel (300 px, right aligned, 16 px margin) and the control bar (680 px, centred) overlap below this width. */
export const LIMITS_STACK_PX = 1312

/** True when the LIMITS panel must sit above the control bar instead of beside it. */
export function limitsStacked(viewportWidth: number): boolean {
  return viewportWidth < LIMITS_STACK_PX
}

/** True when the LIMITS panel must fold to its one line: a small screen with another bottom panel open. */
export function limitsAutoFolded(viewportWidth: number, otherBottomPanelOpen: boolean): boolean {
  return viewportWidth < LIMITS_AUTO_FOLD_PX && otherBottomPanelOpen
}

/** Set (px) or clear (null) one of the published variables on <html>. */
export function publishInset(name: string, px: number | null): void {
  if (typeof document === 'undefined') return
  const style = document.documentElement.style
  if (px === null) style.removeProperty(name)
  else style.setProperty(name, `${Math.max(0, Math.round(px))}px`)
}
