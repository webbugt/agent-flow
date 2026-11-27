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

/** The review bar stacks into rows (scrubber on its own full-width row) below this viewport width, px. */
export const REVIEW_BAR_NARROW_PX = 480

/** The scrubber track never gets narrower than this, px. */
export const SCRUBBER_MIN_WIDTH_PX = 120
