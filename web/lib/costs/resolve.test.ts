import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from './validate'
import {
  BUILTIN_PROVIDERS, completeUserRate, detectProvider, findRule, globMatch, globSpecificity, providerLabel,
  providerSettings, resolveModelPricing,
} from './resolve'
import type { ResolvedConfig } from './types'

function cfg(raw: unknown): ResolvedConfig {
  const r = validateConfig(raw)
  assert.deepEqual(r.errors, [], 'test config must be valid')
  return r.config as ResolvedConfig
}
const near = (a: number, b: number, msg = '') => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`)

test('glob: * and ? , case-insensitive, "." equals "-", anchored at both ends', () => {
  assert.ok(globMatch('claude-sonnet-4-*', 'claude-sonnet-4-6'))
  assert.ok(globMatch('claude-sonnet-4-*', 'Claude-Sonnet-4-6'))
  assert.ok(globMatch('CLAUDE-*-5-5', 'claude-opus-5-5'))
  assert.ok(globMatch('claude-haiku-5.5', 'claude-haiku-5-5'))
  assert.ok(globMatch('claude-haiku-5-5', 'claude-haiku-5.5'))
  assert.ok(globMatch('qwen3.5*', 'qwen3-5:32b'))
  assert.ok(globMatch('gpt-?-mini', 'gpt-5-mini'))
  assert.ok(!globMatch('gpt-?-mini', 'gpt-55-mini'))
  assert.ok(!globMatch('claude-sonnet', 'claude-sonnet-4'), 'no implicit trailing wildcard')
  assert.ok(!globMatch('sonnet*', 'claude-sonnet-4'), 'no implicit leading wildcard')
  assert.ok(globMatch('*', ''))
  assert.ok(globMatch('*', 'anything'))
  assert.ok(globMatch('a*b*c', 'aXXbYYc'))
  assert.ok(!globMatch('a*b*c', 'aXXbYY'))
  assert.ok(globMatch('**a**', 'zzazz'))
  assert.ok(!globMatch('', 'x'))
  assert.ok(globMatch('', ''))
})

test('glob: regex metacharacters in a pattern are literal; pathological patterns stay linear', () => {
  assert.ok(globMatch('a+b', 'a+b'))
  assert.ok(!globMatch('a+b', 'aab'))
  assert.ok(globMatch('(x)[y]{z}^$|\\', '(x)[y]{z}^$|\\'))
  assert.ok(!globMatch('(x|y)', 'x'))
  assert.ok(globMatch('.*', '-*'), '"." is normalised to "-" like in model ids, the rest is literal')
  assert.ok(!globMatch('.*', 'anything'))
  const evil = '*a'.repeat(40) + 'b'
  const t0 = Date.now()
  assert.equal(globMatch(evil, 'a'.repeat(5000)), false)
  assert.ok(Date.now() - t0 < 1000, 'no catastrophic backtracking')
})

test('glob specificity: exact > longer literal prefix > shorter', () => {
  const exact = globSpecificity('claude-sonnet-4-6')
  const long = globSpecificity('claude-sonnet-4-*')
  const short = globSpecificity('claude-*')
  const any = globSpecificity('*')
  assert.ok(exact > long && long > short && short > any, JSON.stringify({ exact, long, short, any }))
})

test('findRule picks the most specific rule, ties go to the earlier one, provider globs filter', () => {
  const c = cfg({ pricing: { models: [
    { match: { model: 'claude-*' }, rate: { input: 1, output: 1 } },                            // 0
    { match: { model: 'claude-sonnet-4-*' }, rate: { input: 2, output: 2 } },                   // 1
    { match: { model: 'claude-sonnet-4-6' }, rate: { input: 3, output: 3 } },                   // 2
    { match: { model: 'claude-sonnet-4-6', provider: 'copilot' }, rate: { input: 4, output: 4 } }, // 3
    { match: { model: 'claude-sonnet-4-6' }, rate: { input: 5, output: 5 } },                   // 4 (tie with 2)
    { match: { provider: 'ollama' }, billing: 'local' },                                         // 5 provider-only
  ] } })
  assert.equal(findRule(c, 'anthropic', 'claude-sonnet-4-6'), 2, 'exact beats glob; ties go to the earlier rule')
  assert.equal(findRule(c, 'copilot', 'claude-sonnet-4-6'), 3, 'a provider-constrained rule beats an unconstrained tie')
  assert.equal(findRule(c, 'anthropic', 'claude-sonnet-4-5'), 1, 'longer prefix beats shorter')
  assert.equal(findRule(c, 'anthropic', 'claude-haiku-5-5'), 0)
  assert.equal(findRule(c, 'anthropic', 'gpt-6-sol'), -1)
  assert.equal(findRule(c, 'ollama', 'whatever'), 5)
  assert.equal(findRule(c, 'ollama', undefined), 5)
  assert.equal(findRule(c, 'anthropic', undefined), -1)
  // The rule is tested against the id as written and the catalog-normalised id (date stamp, provider prefix).
  assert.equal(findRule(c, 'anthropic', 'claude-sonnet-4-6-20250929'), 2, 'the date stamp is stripped, so the exact rule matches')
  assert.equal(findRule(c, 'anthropic', 'anthropic/claude-sonnet-4-6'), 2)
})

test('resolution order: one case per level, each beaten by the level above', () => {
  const USER_RULE = { match: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, rate: { input: 1, output: 2 } }
  const USER_PROVIDER = { anthropic: { rate: { input: 7, output: 9 } } }
  const only = (raw: unknown, model: string, provider = 'anthropic') => resolveModelPricing(cfg(raw), { provider, model })

  // 1. user model rule (beats a user provider rate and the catalog)
  const l1 = only({ pricing: { models: [USER_RULE], providers: USER_PROVIDER } }, 'claude-sonnet-5-5')
  assert.equal(l1.source, 'user-rule'); assert.equal(l1.level, 1); assert.equal(l1.ruleIndex, 0); assert.equal(l1.rate!.input, 1)
  // 2. user provider rate (beats the catalog)
  const l2 = only({ pricing: { providers: USER_PROVIDER } }, 'claude-sonnet-5-5')
  assert.equal(l2.source, 'user-provider'); assert.equal(l2.level, 2); assert.equal(l2.rate!.input, 7); assert.equal(l2.ruleIndex, null)
  // 3. catalog model (exact)
  const l3 = only({}, 'claude-sonnet-5-5')
  assert.equal(l3.source, 'catalog'); assert.equal(l3.level, 3); assert.equal(l3.rate!.input, 2); assert.equal(l3.catalogMatch, 'exact')
  // 3b. catalog, unlisted id of a known family: still the catalog level, flagged as a family match
  const l3b = only({}, 'claude-opus-9')
  assert.equal(l3b.source, 'catalog'); assert.equal(l3b.catalogMatch, 'family'); assert.equal(l3b.rate!.input, 4)
  // 4. catalog provider default: unknown model, provider has a sheet
  const l4 = only({}, 'claude-weird-9')
  assert.equal(l4.source, 'provider-default'); assert.equal(l4.level, 4); assert.equal(l4.catalogRow!.id, 'claude-sonnet-5-5'); assert.equal(l4.rate!.input, 2)
  // 5. policy: unknown model on a provider without a sheet -> flagged fallback
  const l5 = only({}, 'acme-xyz-9', 'acme')
  assert.equal(l5.source, 'fallback'); assert.equal(l5.level, 5); assert.equal(l5.catalogMatch, 'fallback'); assert.equal(l5.rate!.input, 2)
})

test('unknown-model policies: provider-default, global-rate, unpriced, zero', () => {
  const run = (policy: string, extra: object = {}, provider = 'acme', model = 'acme-xyz-9') =>
    resolveModelPricing(cfg({ pricing: { unknownModel: { policy, ...extra } } }), { provider, model })
  // provider-default on a provider WITH a sheet -> provider default; without a sheet -> fallback row
  assert.equal(run('provider-default', {}, 'anthropic').source, 'provider-default')
  assert.equal(run('provider-default', {}, 'copilot').catalogRow!.section, 'copilot')
  assert.equal(run('provider-default').source, 'fallback')
  // provider-default with a global rate and no sheet -> the user's global rate
  const g = run('provider-default', { globalRate: { input: 3, output: 15 } })
  assert.equal(g.source, 'fallback'); assert.equal(g.rate!.input, 3); assert.equal(g.catalogRow, null)
  // global-rate skips the provider default
  const gr = run('global-rate', { globalRate: { input: 5, output: 25 } }, 'anthropic')
  assert.equal(gr.source, 'fallback'); assert.equal(gr.rate!.output, 25); assert.equal(gr.policy, 'global-rate')
  near(gr.rate!.cacheRead, 0.5); near(gr.rate!.cacheWrite5m!, 6.25); near(gr.rate!.cacheWrite1h!, 10)
  // unpriced: no rate, source none
  const u = run('unpriced')
  assert.equal(u.rate, null); assert.equal(u.source, 'none'); assert.equal(u.policy, 'unpriced')
  assert.equal(run('unpriced', {}, 'anthropic').rate, null, 'unpriced also beats a provider default')
  // zero: a zero rate, still flagged fallback
  const z = run('zero')
  assert.equal(z.rate!.input, 0); assert.equal(z.source, 'fallback')
  // Known models are untouched by any policy.
  const known = resolveModelPricing(cfg({ pricing: { unknownModel: { policy: 'unpriced' } } }), { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(known.source, 'catalog')
  // No model reported at all is never silently priced as the provider default.
  assert.equal(resolveModelPricing(cfg({}), { provider: 'anthropic' }).source, 'fallback')
})

test('user rates derive the omitted cache fields: read from the matched catalog entry, writes 1.25x / 2x', () => {
  near(completeUserRate({ input: 10, output: 50 }).cacheRead, 1)
  near(completeUserRate({ input: 10, output: 50 }, 0.05).cacheRead, 0.5)
  const full = completeUserRate({ input: 10, output: 50, cacheRead: 9, cacheWrite5m: 8, cacheWrite1h: 7 })
  assert.deepEqual(full, { input: 10, output: 50, cacheRead: 9, cacheWrite5m: 8, cacheWrite1h: 7 })
  const rule = (model: string) => resolveModelPricing(cfg({ pricing: { models: [{ match: { model }, rate: { input: 10, output: 50 } }] } }), { provider: 'anthropic', model }).rate!
  const opus55 = rule('claude-opus-5-5')                 // catalog read multiplier 0.05
  near(opus55.cacheRead, 0.5); near(opus55.cacheWrite5m!, 12.5); near(opus55.cacheWrite1h!, 20)
  near(rule('claude-fable-5-2').cacheRead, 0.25)         // 0.025x
  near(rule('claude-sonnet-4-6').cacheRead, 1)           // 0.1x
  near(rule('acme-xyz-9').cacheRead, 1, 'a model unknown to the catalog uses 0.1x')
})

test('user tiers: the threshold itself is the lower tier; no promptTokens means the lowest tier', () => {
  const c = cfg({ pricing: { models: [{ match: { model: 'm' }, tiers: [{ maxPromptTokens: 100_000, rate: { input: 1, output: 2 } }, { rate: { input: 5, output: 6 } }] }] } })
  const at = (n?: number) => resolveModelPricing(c, { provider: 'x', model: 'm', promptTokens: n })
  assert.equal(at().rate!.input, 1)
  assert.equal(at(100_000).rate!.input, 1)
  assert.equal(at(100_001).rate!.input, 5)
  assert.equal(at(100_001).tierIndex, 1); assert.equal(at(100_001).tierCount, 2); assert.equal(at(100_000).tierMaxPromptTokens, 100_000)
  assert.equal(at(100_001).tierMaxPromptTokens, null)
})

test('a rule without a rate still applies billing / energy / modifiers; the rate comes from the next level', () => {
  const c = cfg({ pricing: { models: [{ match: { model: 'claude-opus-5-5' }, billing: 'subscription', modifiers: { fast: 2, batch: 0.5 } }] } })
  const r = resolveModelPricing(c, { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(r.billing, 'subscription')
  assert.equal(r.source, 'catalog')
  assert.equal(r.ruleIndex, 0)
  near(r.modifiers, 1)
  const c2 = cfg({ pricing: { models: [{ match: { model: 'claude-opus-5-5' }, modifiers: { fast: 2, dataResidency: 1.1 } }] } })
  near(resolveModelPricing(c2, { provider: 'anthropic', model: 'claude-opus-5-5' }).modifiers, 2.2)
})

test('local models have no money rate; a rule can make any model local', () => {
  const c = cfg({ pricing: { models: [{ match: { model: 'qwen3-*' }, billing: 'local', energyProfile: 'box' }] }, energy: { profiles: { box: { powerW: { idle: 40, load: 200 } } } } })
  const a = resolveModelPricing(c, { provider: 'ollama', model: 'llama3.3:70b' })
  assert.equal(a.billing, 'local'); assert.equal(a.rate, null); assert.equal(a.source, 'none'); assert.equal(a.level, 0)
  const b = resolveModelPricing(c, { provider: 'openrouter', model: 'qwen3-32b' })
  assert.equal(b.billing, 'local'); assert.equal(b.energyProfile, 'box'); assert.equal(b.rate, null)
  for (const id of ['ollama', 'llama.cpp', 'vllm', 'lmstudio', 'custom']) assert.equal(BUILTIN_PROVIDERS[id].billing, 'local', id)
})

test('provider detection: explicit, runtime default, model heuristic, unknown', () => {
  assert.equal(detectProvider({ provider: 'copilot', model: 'claude-haiku-5.5' }), 'copilot')
  assert.equal(detectProvider({ provider: ' ollama ', runtime: 'claude' }), 'ollama')
  assert.equal(detectProvider({ runtime: 'claude' }), 'anthropic')
  assert.equal(detectProvider({ runtime: 'codex' }), 'openai')
  assert.equal(detectProvider({ model: 'claude-opus-5-5' }), 'anthropic')
  assert.equal(detectProvider({ model: 'anthropic/claude-opus-5-5' }), 'anthropic')
  assert.equal(detectProvider({ model: 'gpt-6.1-sol' }), 'openai')
  assert.equal(detectProvider({ model: 'o3-mini' }), 'openai')
  assert.equal(detectProvider({ model: 'gemini-3.8-flash' }), 'google')
  assert.equal(detectProvider({ model: 'qwen3:32b' }), 'unknown')
  assert.equal(detectProvider({}), 'unknown')
  assert.equal(detectProvider({ model: 'ox-1' }), 'unknown', '"o" followed by a non-digit is not an OpenAI reasoning model')
})

test('provider settings: built-ins overlaid by the user field by field; labels', () => {
  assert.equal(providerSettings(cfg({}), 'copilot').billing, 'credits')
  assert.equal(providerSettings(cfg({}), 'copilot').implicitCacheWrite, true)
  const c = cfg({ pricing: { providers: { copilot: { implicitCacheWrite: false }, anthropic: { billing: 'subscription' } } } })
  assert.equal(providerSettings(c, 'copilot').implicitCacheWrite, false)
  assert.equal(providerSettings(c, 'copilot').billing, 'credits', 'unset fields keep the built-in value')
  assert.equal(providerSettings(c, 'anthropic').billing, 'subscription')
  assert.equal(providerSettings(c, 'anthropic').priceLike, 'anthropic')
  assert.deepEqual(providerSettings(c, 'nobody'), {})
  assert.equal(providerSettings(c, 'toString').billing, undefined, 'inherited names are not providers')
  assert.equal(providerLabel('copilot'), 'GitHub Copilot via Hermes')
  assert.equal(providerLabel('acme'), 'acme')
})

test('Copilot provider resolves in the copilot sheet; others prefer the Anthropic sheet', () => {
  const c = cfg({})
  const cp = resolveModelPricing(c, { provider: 'copilot', model: 'claude-haiku-5.5' })
  assert.equal(cp.catalogSection, 'copilot'); assert.equal(cp.billing, 'credits')
  assert.equal(cp.model, 'claude-haiku-5-5')
  assert.equal(cp.rate!.cacheWrite1h, null, 'the Copilot sheet lists no 1h write')
  const an = resolveModelPricing(c, { provider: 'anthropic', model: 'claude-haiku-5-5' })
  assert.equal(an.catalogSection, 'anthropic'); assert.equal(an.rate!.cacheWrite1h, 0.2)
  const gem = resolveModelPricing(c, { provider: 'copilot', model: 'gemini-3.8-flash' })
  assert.equal(gem.rate!.input, 0.75); assert.equal(gem.source, 'catalog')
  // A tier lookup uses promptTokens; at= picks the dated price.
  assert.equal(resolveModelPricing(c, { provider: 'copilot', model: 'claude-haiku-5-5', promptTokens: 120_000 }).rate!.input, 0.5)
  assert.equal(resolveModelPricing(c, { provider: 'copilot', model: 'gemini-4-carbon', at: '2026-11-30T23:59:59Z' }).rate!.input, 2)
  const after = resolveModelPricing(c, { provider: 'copilot', model: 'gemini-4-carbon', at: '2026-12-01T00:00:00Z' })
  assert.equal(after.rate!.input, 4); assert.equal(after.afterPromo, true)
})
