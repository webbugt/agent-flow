/**
 * What the draw loop needs to fade a resource block on its own clock: the last use and the linger/fade of its
 * kind (already in ms), plus the pin. The scene is rebuilt only every few seconds, so the opacity is computed
 * from the wall clock at draw time (same idea as the edges), not baked into the scene.
 */
import { lifeAlpha } from './fleet-edge-life'

export interface BlockLifeView {
  /** Epoch ms of the latest use. */
  lastUsedAt: number
  lingerMs: number
  fadeMs: number
  /** Pinned: stays fully visible (a pin beats linger 0). */
  pinned: boolean
}

/** Opacity 0..1 of a block at `now`. Same rule as resource-block.blockAlpha, without the options. */
export function blockViewAlpha(view: BlockLifeView, now: number): number {
  if (view.pinned) return 1
  return lifeAlpha(view.lastUsedAt, now, view.lingerMs, view.fadeMs)
}
