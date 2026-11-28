/**
 * Position of a pointer on a scrubber track, kept pure so it can be tested without a DOM.
 *
 * @param clientX  pointer x in viewport px
 * @param left     track left edge in viewport px
 * @param width    track width in px
 * @returns        0..1 along the track; 0 for a track with no width (never NaN)
 */
export function scrubRatio(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return 0
  return Math.max(0, Math.min(1, (clientX - left) / width))
}

/** Seconds one arrow key moves the playhead. */
export const SCRUB_KEY_STEP_S = 5

/**
 * Where a key on the focused replay slider moves the playhead (ARIA slider pattern): arrows step 5 s, PageUp / PageDown
 * 10 % of the recording, Home / End the ends. Null for any other key, so the caller leaves it alone (Space still plays,
 * Tab still moves on). Clamped to 0..total; never NaN.
 */
export function scrubKeyTarget(key: string, current: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null
  const now = Number.isFinite(current) ? current : 0
  const clamp = (t: number) => Math.max(0, Math.min(total, t))
  switch (key) {
    case 'ArrowLeft': case 'ArrowDown': return clamp(now - SCRUB_KEY_STEP_S)
    case 'ArrowRight': case 'ArrowUp': return clamp(now + SCRUB_KEY_STEP_S)
    case 'PageDown': return clamp(now - total / 10)
    case 'PageUp': return clamp(now + total / 10)
    case 'Home': return 0
    case 'End': return total
    default: return null
  }
}

/** The review bar stacks into rows (scrubber on its own full-width row) below this viewport width, px. */
export const REVIEW_BAR_NARROW_PX = 480

/** The scrubber track never gets narrower than this, px. */
export const SCRUBBER_MIN_WIDTH_PX = 120
