import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIELD, applyDraft, checkDoc, draftFromDoc, issuesAt, newRule, otherIssues, providerIds } from './settings-edit'

type Obj = Record<string, unknown>

test('an empty document gives a USD draft with the built-in providers and no rules', () => {
  const d = draftFromDoc(undefined)
  assert.equal(d.currency, 'USD')
  assert.equal(d.fx, '')
  assert.equal(d.unit, 'auto')
  assert.equal(d.subscriptionValue, 'show')
  assert.deepEqual(d.rules, [])
  assert.ok(d.providers['anthropic'] && d.providers['copilot'])
})

test('draft -> document -> draft round-trips currency, display, provider billing and rate rules', () => {
  const doc: Obj = {
    schemaVersion: 1,
    currency: { display: 'EUR', fx: { EUR: 0.92 }, fxAsOf: '2026-11-25' },
    display: { unit: 'tokens', subscriptionValue: 'hide' },
    pricing: {
      providers: { copilot: { billing: 'credits' } },
      models: [{ match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 } }],
    },
  }
  assert.ok(checkDoc(doc).ok)
  const d = draftFromDoc(doc)
  assert.equal(d.currency, 'EUR')
  assert.equal(d.fx, '0.92')
  assert.equal(d.unit, 'tokens')
  assert.equal(d.providers['copilot'].billing, 'credits')
  assert.equal(d.rules[0].input, '3')
  assert.deepEqual(applyDraft(doc, d), doc)
})

test('applying a draft keeps keys the drawer does not edit', () => {
  const doc: Obj = { $schema: 'x', schemaVersion: 1, energy: { pue: 1.2 }, limits: { note: 1 }, currency: { display: 'EUR', fx: { EUR: 0.9, CHF: 0.8 } } }
  const d = draftFromDoc(doc)
  d.fx = '0.95'
  const out = applyDraft(doc, d)
  assert.deepEqual(out.energy, { pue: 1.2 })
  assert.deepEqual(out.limits, { note: 1 })
  assert.equal(out.$schema, 'x')
  assert.deepEqual((out.currency as Obj).fx, { EUR: 0.95, CHF: 0.8 })
})

test('applyDraft never mutates its input', () => {
  const doc: Obj = { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.9 } } }
  const before = JSON.stringify(doc)
  const d = draftFromDoc(doc)
  d.currency = 'GBP'; d.fx = '0.8'
  applyDraft(doc, d)
  assert.equal(JSON.stringify(doc), before)
})

test('choosing USD drops the display currency instead of writing a pointless fx entry', () => {
  const doc: Obj = { schemaVersion: 1, currency: { display: 'EUR', fx: { EUR: 0.9 } } }
  const d = draftFromDoc(doc)
  d.currency = 'usd'
  const out = applyDraft(doc, d)
  assert.equal((out.currency as Obj | undefined)?.display, undefined)
  assert.ok(checkDoc(out).ok)
})

test('a currency without an exchange rate is rejected with a pointer the drawer can show at the field', () => {
  const d = draftFromDoc(undefined)
  d.currency = 'EUR'
  const check = checkDoc(applyDraft(undefined, d))
  assert.equal(check.ok, false)
  assert.ok(check.errors.length > 0)
  const mine = [...issuesAt(check.errors, FIELD.currency), ...issuesAt(check.errors, '/currency/fx')]
  assert.ok(mine.length > 0, JSON.stringify(check.errors))
  assert.equal(otherIssues(check.errors, d).length, 0)
})

test('a typed price becomes a number; text stays text so the validator names the field', () => {
  const d = draftFromDoc(undefined)
  const r = newRule('anthropic', 'claude-sonnet-*')
  r.input = '3.5'; r.output = 'abc'
  d.rules = [r]
  const doc = applyDraft(undefined, d)
  const rate = ((doc.pricing as Obj).models as Obj[])[0].rate as Obj
  assert.equal(rate.input, 3.5)
  assert.equal(rate.output, 'abc')
  const check = checkDoc(doc)
  assert.equal(check.ok, false)
  assert.ok(issuesAt(check.errors, FIELD.ruleField(0, 'output')).length > 0, JSON.stringify(check.errors))
  assert.equal(issuesAt(check.errors, FIELD.ruleField(0, 'input')).length, 0)
})

test('a negative price is an error at that field; cache fields left empty are omitted (derived from input)', () => {
  const d = draftFromDoc(undefined)
  const r = newRule('anthropic', 'claude-x')
  r.input = '-1'; r.output = '5'
  d.rules = [r]
  const doc = applyDraft(undefined, d)
  const rate = ((doc.pricing as Obj).models as Obj[])[0].rate as Obj
  assert.deepEqual(Object.keys(rate).sort(), ['input', 'output'])
  assert.ok(issuesAt(checkDoc(doc).errors, FIELD.ruleField(0, 'input')).length > 0)
})

test('a rule with price tiers is locked: its rate is not rewritten, only provider and model can change', () => {
  const doc: Obj = {
    schemaVersion: 1,
    pricing: { models: [{ match: { provider: 'anthropic', model: 'claude-haiku-*' }, tiers: [{ maxPromptTokens: 200000, rate: { input: 1, output: 5 } }, { maxPromptTokens: null, rate: { input: 2, output: 10 } }] }] },
  }
  assert.ok(checkDoc(doc).ok, JSON.stringify(checkDoc(doc).errors))
  const d = draftFromDoc(doc)
  assert.equal(d.rules[0].locked, true)
  d.rules[0].model = 'claude-haiku-5'
  const out = applyDraft(doc, d)
  const rule = (out.pricing as Obj).models as Obj[]
  assert.equal((rule[0].match as Obj).model, 'claude-haiku-5')
  assert.deepEqual(rule[0].tiers, (doc.pricing as Obj).models && ((doc.pricing as Obj).models as Obj[])[0].tiers)
  assert.equal(rule[0].rate, undefined)
  assert.ok(checkDoc(out).ok)
})

test('removing every rule and every provider setting leaves no empty pricing block', () => {
  const doc: Obj = { schemaVersion: 1, pricing: { providers: { copilot: { billing: 'credits' } }, models: [{ match: { model: 'x' }, rate: { input: 1, output: 1 } }] } }
  const d = draftFromDoc(doc)
  d.rules = []
  d.providers['copilot'].billing = ''
  const out = applyDraft(doc, d)
  assert.equal(out.pricing, undefined)
  assert.ok(checkDoc(out).ok)
})

test('forbidden keys are never written, whatever the drawer is given', () => {
  const d = draftFromDoc(undefined)
  d.providers['__proto__'] = { billing: 'api', implicitCacheWrite: null, energyProfile: '' }
  const out = applyDraft(undefined, d)
  assert.equal(JSON.stringify(out).includes('__proto__'), false)
  assert.equal(({} as Obj).billing, undefined)
  assert.ok(!providerIds({ pricing: { providers: JSON.parse('{"__proto__": {"billing": "api"}}') } }).includes('__proto__'))
})

test('providerIds lists built-in, file and seen providers once each', () => {
  const ids = providerIds({ pricing: { providers: { anthropic: {}, mycloud: { billing: 'api' } } } }, ['ollama', 'mycloud'])
  assert.equal(new Set(ids).size, ids.length)
  for (const want of ['anthropic', 'copilot', 'mycloud', 'ollama']) assert.ok(ids.includes(want), want)
})

test('JSON pointer segments are escaped: a currency or provider with / or ~ cannot hit the wrong field', () => {
  assert.equal(FIELD.provider('a/b', 'billing'), '/pricing/providers/a~1b/billing')
  assert.equal(FIELD.provider('a~b', 'billing'), '/pricing/providers/a~0b/billing')
  assert.equal(FIELD.ruleField(2, 'cacheWrite'), '/pricing/models/2/rate/cacheWrite5m')
})
