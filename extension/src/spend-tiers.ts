/**
 * Prompt-size buckets for per-request pricing tiers. Zero imports on purpose: extension/tsconfig.json
 * has rootDir "src", so this file cannot import web/lib/costs/tiers.ts. It is a COPY; the unit test
 * scripts/costs-boundaries.test.ts fails when the two copies (or a catalog threshold) diverge.
 */
export const TIER_BOUNDARIES: readonly number[] = [100_000, 200_000, 272_000]

export type PromptBucket = 'le100000' | 'le200000' | 'le272000' | 'gt272000'

/** Bucket of one request's prompt size (input + cache read + cache write tokens). */
export function promptBucket(promptTokens: number): PromptBucket {
  if (promptTokens <= 100_000) return 'le100000'
  if (promptTokens <= 200_000) return 'le200000'
  if (promptTokens <= 272_000) return 'le272000'
  return 'gt272000'
}
