/**
 * Fleet map labels, pure layout rules (no canvas): how big a label is on the screen, how wide it may
 * get, and whether it fits among the labels and nodes already drawn.
 *
 * The map is drawn in world units under a camera zoom. A label drawn at a fixed world size shrinks to
 * 3-5 px when the whole fleet is fitted into a phone, and grows without the name getting longer when
 * zoomed in. So labels are sized on the SCREEN instead: between a legible minimum and a maximum, and
 * truncated by the width they may take on screen. A label that does not fit in a free spot is not
 * drawn (the selected or hovered node always gets its full name).
 */

/** Smallest label size on the screen, CSS px. Below this text turns into dashes, so it is not drawn smaller. */
export const LABEL_MIN_PX = 9
/** Largest label size on the screen, CSS px: zooming in does not keep growing the text. */
export const LABEL_MAX_PX = 13

/** Widest a label may be on the screen (CSS px) before it is cut with an ellipsis. Selected / hovered: no limit. */
export const LABEL_WIDTH_PX = { session: 120, resource: 168, task: 168 } as const

/** On-screen size of a label whose nominal size is `nominalPx` at zoom 1. */
export function labelScreenPx(nominalPx: number, zoom: number, minPx = LABEL_MIN_PX, maxPx = LABEL_MAX_PX): number {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return Math.min(Math.max(nominalPx, minPx), maxPx)
  return Math.min(Math.max(nominalPx * zoom, minPx), maxPx)
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 + pad && a.y1 + pad > b.y0
}

/** Shorten `text` with an ellipsis until `widthOf` says it fits `maxWidth`. Never returns the empty string. */
export function fitText(text: string, maxWidth: number, widthOf: (s: string) => number): string {
  if (widthOf(text) <= maxWidth) return text
  let lo = 0
  let hi = text.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (widthOf(text.slice(0, mid).trimEnd() + '\u2026') <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? text.slice(0, lo).trimEnd() + '\u2026' : '\u2026'
}

/** Rectangles that are taken (nodes, captions, labels already drawn). One per frame. */
export class LabelPlacer {
  private rects: Rect[] = []

  /** Mark an area as taken without asking (a node, or the label of a selected node). */
  reserve(r: Rect): void { this.rects.push(r) }

  /** Take the area if it is free; false when it overlaps something already taken. */
  tryPlace(r: Rect, pad = 0): boolean {
    for (const o of this.rects) if (rectsOverlap(r, o, pad)) return false
    this.rects.push(r)
    return true
  }
}
