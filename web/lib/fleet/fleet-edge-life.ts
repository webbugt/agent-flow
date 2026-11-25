/**
 * Edge lifecycle of the Fleet map: a link between a profile cloud and a resource (Kanban board,
 * Supermemory namespace) is drawn for a linger window after its last use, then fades out.
 * It does not depend on whether the profile is running.
 *
 * Pure functions on epoch milliseconds, so the draw loop and the tests share one rule.
 */

/** A link stays fully drawn this long after its last use, ms. */
export const EDGE_LINGER_MS = 90_000
/** After the linger window the link fades to nothing over this long, ms. */
export const EDGE_FADE_MS = 15_000

/** How long after its last use a link is still drawn at all (linger + fade), ms. */
export const EDGE_VISIBLE_MS = EDGE_LINGER_MS + EDGE_FADE_MS

/**
 * Visibility of a link, 0..1: 1 up to EDGE_LINGER_MS after `lastUsedAt`, then a linear fade to 0
 * over EDGE_FADE_MS. A link that was never used (`lastUsedAt` null/undefined/NaN) is not drawn.
 * A use time in the future (clock skew between the relay and the browser) counts as "just now".
 */
export function edgeAlpha(lastUsedAt: number | null | undefined, now: number): number {
  if (lastUsedAt === null || lastUsedAt === undefined || !Number.isFinite(lastUsedAt)) return 0
  const age = Math.max(now - lastUsedAt, 0)
  if (age <= EDGE_LINGER_MS) return 1
  if (age >= EDGE_VISIBLE_MS) return 0
  return 1 - (age - EDGE_LINGER_MS) / EDGE_FADE_MS
}

export function isEdgeDrawn(lastUsedAt: number | null | undefined, now: number): boolean {
  return edgeAlpha(lastUsedAt, now) > 0
}
