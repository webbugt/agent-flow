import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildViewSearch, parseViewParams, parseViewValue, resolveStartView } from './url-view'

test('parseViewValue: 1/on/true are on, 0/off/false are off, anything else is unset', () => {
  assert.equal(parseViewValue('1'), true)
  assert.equal(parseViewValue('on'), true)
  assert.equal(parseViewValue('TRUE'), true)
  assert.equal(parseViewValue(' 0 '), false)
  assert.equal(parseViewValue('off'), false)
  assert.equal(parseViewValue('false'), false)
  assert.equal(parseViewValue('yes'), undefined)
  assert.equal(parseViewValue(''), undefined)
  assert.equal(parseViewValue(null), undefined)
  assert.equal(parseViewValue(undefined), undefined)
})

test('parseViewParams reads fleet and screensaver, with or without the leading ?', () => {
  assert.deepEqual(parseViewParams('?fleet=1&screensaver=0'), { fleet: true, screensaver: false })
  assert.deepEqual(parseViewParams('screensaver=on'), { screensaver: true })
  assert.deepEqual(parseViewParams('?shot=1&stress=heavy'), {})
  assert.deepEqual(parseViewParams(''), {})
  assert.deepEqual(parseViewParams(undefined), {})
})

test('an unrecognised value is ignored, so the stored choice applies', () => {
  assert.deepEqual(parseViewParams('?fleet=maybe'), {})
  assert.deepEqual(parseViewParams('?fleet'), {})
})

test('buildViewSearch writes both parameters as 1/0 and keeps other parameters', () => {
  assert.equal(buildViewSearch('', { fleet: true, screensaver: false }), '?fleet=1&screensaver=0')
  assert.equal(buildViewSearch('?shot=1', { fleet: false, screensaver: true }), '?shot=1&fleet=0&screensaver=1')
  // an existing value is replaced, not duplicated
  assert.equal(buildViewSearch('?fleet=0&screensaver=0', { fleet: true, screensaver: true }), '?fleet=1&screensaver=1')
  assert.equal(buildViewSearch(null, { fleet: false, screensaver: false }), '?fleet=0&screensaver=0')
})

test('buildViewSearch is stable: a second call with the same state returns the same string', () => {
  const once = buildViewSearch('?shot=1', { fleet: true, screensaver: false })
  assert.equal(buildViewSearch(once, { fleet: true, screensaver: false }), once)
})

test('the URL wins over the stored choice; the stored choice fills in what the URL does not name', () => {
  const stored = { fleet: false, screensaver: true }
  assert.deepEqual(resolveStartView(stored, {}), stored)
  assert.deepEqual(resolveStartView(stored, { fleet: true }), { fleet: true, screensaver: true })
  assert.deepEqual(resolveStartView(stored, { screensaver: false }), { fleet: false, screensaver: false })
  assert.deepEqual(resolveStartView(stored, { fleet: true, screensaver: false }), { fleet: true, screensaver: false })
})
