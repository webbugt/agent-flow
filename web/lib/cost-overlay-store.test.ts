import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  clearOverlayUnit, cycleOverlayUnit, getOverlayOverride, getOverlayUnit, overlayUnitVersion, resetOverlayUnit, setOverlayUnit,
  subscribeOverlayUnit,
} from './cost-overlay-store'
import { getOptions, resetOptions } from './options-store'

// In node there is no window.localStorage, so the options store keeps everything in memory: this tests the
// store logic (registry-backed), not the browser storage (covered by options-store.test.ts).

test('the header toggle writes the choice into the options registry and reads it back', () => {
  resetOptions()
  assert.equal(getOverlayOverride(), null)
  setOverlayUnit('kwh')
  assert.equal(getOverlayOverride(), 'kwh')
  assert.equal(getOverlayUnit(), 'kwh')
  assert.equal(getOptions().costUnit?.unit, 'kwh')
})

test('cycling goes money -> kWh -> tokens -> money', () => {
  resetOptions()
  const seen = [getOverlayUnit(), cycleOverlayUnit(), cycleOverlayUnit(), cycleOverlayUnit()]
  assert.deepEqual(seen, ['money', 'kwh', 'tokens', 'money'])
})

test('clearing follows the config default again, and subscribers hear about every change', () => {
  resetOptions()
  let calls = 0
  const off = subscribeOverlayUnit(() => { calls++ })
  const v0 = overlayUnitVersion()
  setOverlayUnit('tokens')
  clearOverlayUnit()
  assert.equal(getOverlayOverride(), null)
  assert.equal(getOptions().costUnit, null)
  assert.equal(calls, 2)
  assert.ok(overlayUnitVersion() > v0)
  off()
  resetOverlayUnit()
  assert.equal(calls, 2)
})

test('a change made in the options panel (a patch of the registry) is seen by the header at once', async () => {
  resetOptions()
  const { updateOptions } = await import('./options-store')
  assert.equal(updateOptions({ costUnit: { unit: 'tokens', cfg: 'auto' } }).ok, true)
  assert.equal(getOverlayUnit(), 'tokens')
})
