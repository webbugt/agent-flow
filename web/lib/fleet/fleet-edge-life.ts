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
 * Visibility 0..1 for any resource with a configurable window: 1 up to `lingerMs` after `lastUsedAt`,
 * then a linear fade to 0 over `fadeMs`. This is the one rule shared by edges and resource blocks.
 *
 * - Never used (`lastUsedAt` null/undefined/NaN) -> 0.
 * - A use time in the future (clock skew between the relay and the browser) counts as "just now".
 * - `lingerMs <= 0` (or not finite) means "hide immediately": 0 at every age, and the fade is skipped.
 * - `fadeMs <= 0` (or not finite) is a hard cut at the end of the linger window.
 */
export function lifeAlpha(lastUsedAt: number | null | undefined, now: number, lingerMs: number, fadeMs: number): number {
  if (lastUsedAt === null || lastUsedAt === undefined || !Number.isFinite(lastUsedAt)) return 0
  if (!Number.isFinite(lingerMs) || lingerMs <= 0) return 0
  const fade = Number.isFinite(fadeMs) && fadeMs > 0 ? fadeMs : 0
  const age = Math.max(now - lastUsedAt, 0)
  if (age <= lingerMs) return 1
  if (fade === 0 || age >= lingerMs + fade) return 0
  return 1 - (age - lingerMs) / fade
}

/**
 * Visibility of a link, 0..1: 1 up to EDGE_LINGER_MS after `lastUsedAt`, then a linear fade to 0
 * over EDGE_FADE_MS. A link that was never used (`lastUsedAt` null/undefined/NaN) is not drawn.
 * A use time in the future (clock skew between the relay and the browser) counts as "just now".
 */
export function edgeAlpha(lastUsedAt: number | null | undefined, now: number): number {
  return lifeAlpha(lastUsedAt, now, EDGE_LINGER_MS, EDGE_FADE_MS)
}

export function isEdgeDrawn(lastUsedAt: number | null | undefined, now: number): boolean {
  return edgeAlpha(lastUsedAt, now) > 0
}
