/**
 * The prompt-size bucket list exists twice: web/lib/costs/tiers.ts and extension/src/spend-tiers.ts (the
 * extension's rootDir is `src`, so it cannot import from web/). This test fails when the copies diverge
 * from each other or from the catalog's tier thresholds (PLAN v2 section 4.2, P1-A5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIER_BOUNDARIES as WEB_BOUNDARIES, promptBucket as webBucket } from '../web/lib/costs/tiers'
import { TIER_BOUNDARIES as EXT_BOUNDARIES, promptBucket as extBucket } from '../extension/src/spend-tiers'
import { ALL_ROWS } from '../web/lib/costs/catalog'

test('both TIER_BOUNDARIES copies are identical', () => {
  assert.deepEqual([...EXT_BOUNDARIES], [...WEB_BOUNDARIES])
})

test('both promptBucket copies agree on and around every boundary', () => {
  const probes = new Set<number>([0, 1])
  for (const b of WEB_BOUNDARIES) for (const d of [-1, 0, 1]) probes.add(b + d)
  probes.add(1_000_000)
  for (const n of probes) assert.equal(extBucket(n), webBucket(n), `prompt ${n}`)
  // Boundaries are inclusive upper bounds.
  assert.equal(extBucket(100_000), 'le100000')
  assert.equal(extBucket(100_001), 'le200000')
  assert.equal(extBucket(272_001), 'gt272000')
})

test('every catalog tier threshold is a member of TIER_BOUNDARIES', () => {
  for (const row of ALL_ROWS) {
    for (const t of row.tiers) {
      if (t.maxPromptTokens === null) continue
      assert.ok(EXT_BOUNDARIES.includes(t.maxPromptTokens), `${row.section}/${row.id} threshold ${t.maxPromptTokens} is not in extension/src/spend-tiers.ts`)
    }
  }
})
