/**
 * Plan names as DATA (PLAN v1 section 11: "keep plan ids as user-visible labels + numeric multiplier, not hard-coded
 * constants"). Anthropic renames plans and changes their multiples at its own discretion, so nothing in the estimator
 * branches on a label or a multiplier; the config's `planLabel` and `planMultiplierOfPro` override the text and the
 * number shown, and `traits` say which meters a plan family has.
 */
import type { ClaudeLimitsConfig, ClaudePlan } from './types'

export interface PlanTraits {
  /** Has a rolling 5-hour limit (Ultra reportedly has only a weekly one). */
  fiveHour: boolean
  /** Has a separate weekly Fable limit (Max and Ultra; on Pro Fable is paid by usage credits). */
  fableLimit: boolean
  /** The plan has usage limits to show at all. */
  limits: boolean
}

export interface PlanInfo {
  /** Default user-visible text. */
  label: string
  /** Weekly capacity as a multiple of Pro (documented: Max 5x = 5, Ultra = 10); null when it is not a fixed multiple. */
  multiplierOfPro: number | null
  traits: PlanTraits
}

export const PLAN_INFO: Readonly<Record<ClaudePlan, PlanInfo>> = {
  pro: { label: 'Claude Pro', multiplierOfPro: 1, traits: { fiveHour: true, fableLimit: false, limits: true } },
  max5x: { label: 'Claude Max 5x', multiplierOfPro: 5, traits: { fiveHour: true, fableLimit: true, limits: true } },
  ultra: { label: 'Claude Ultra', multiplierOfPro: 10, traits: { fiveHour: false, fableLimit: true, limits: true } },
  custom: { label: 'Custom plan', multiplierOfPro: null, traits: { fiveHour: true, fableLimit: true, limits: true } },
  api: { label: 'Claude API (pay per token, no plan limits)', multiplierOfPro: null, traits: { fiveHour: false, fableLimit: false, limits: false } },
}

export interface PlanDescription {
  plan: ClaudePlan
  /** The user's `planLabel`, else the table's text. */
  label: string
  /** The user's `planMultiplierOfPro`, else the table's number; null when neither exists. */
  multiplierOfPro: number | null
  traits: PlanTraits
  /** `Claude Max 5x · 5x Pro` */
  text: string
}

/** The plan of a limits config as shown to the person; null when no plan is configured. */
export function describePlan(cfg: Pick<ClaudeLimitsConfig, 'plan' | 'planLabel' | 'planMultiplierOfPro'>): PlanDescription | null {
  if (cfg.plan === null) return null
  const info = PLAN_INFO[cfg.plan]
  const label = cfg.planLabel && cfg.planLabel.trim() ? cfg.planLabel.trim() : info.label
  const multiplierOfPro = cfg.planMultiplierOfPro ?? info.multiplierOfPro
  const mult = multiplierOfPro === null ? '' : ` · ${Number(multiplierOfPro.toPrecision(4))}x Pro`
  return { plan: cfg.plan, label, multiplierOfPro, traits: info.traits, text: `${label}${mult}` }
}
