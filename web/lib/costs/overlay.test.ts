import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceAgent } from './agent-cost'
import type { AgentSpendInput } from './agent-cost'
import { defaultConfig, validateConfig } from './validate'
import {
  BADGE_LABEL, blendedPerMillion, buildAgentTooltip, buildCostSummary, buildPillLabel, buildToolBreakdown, buildTopBarCost,
  costToggleLabel, describeSources, findCostPillAt, flavorOf, nextUnit, pillGeometry, placeSummaryPanel, resolveUnit,
  tooltipPlainText, NARROW_CANVAS_PX,
} from './overlay'
import type { ResolvedConfig } from './types'

const cfg = defaultConfig()
function custom(doc: Record<string, unknown>): ResolvedConfig {
  const r = validateConfig({ schemaVersion: 1, ...doc })
  assert.ok(r.ok && r.config, JSON.stringify(r.errors))
  return r.config
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })

const API: AgentSpendInput = { tokensUsed: 40_000, model: 'claude-sonnet-5-5', runtime: 'claude', spend: { ...usage(30_000, 2_000), model: 'claude-sonnet-5-5', provider: 'anthropic' } }
const SUB: AgentSpendInput = { tokensUsed: 40_000, model: 'claude-sonnet-5-5', runtime: 'claude', spend: { ...usage(30_000, 2_000), model: 'claude-sonnet-5-5', provider: 'claude-subscription-directsdk-experimental' } }
const NO_USAGE: AgentSpendInput = { tokensUsed: 50_000, model: 'claude-sonnet-5-5', runtime: 'claude' }
const COPILOT: AgentSpendInput = { tokensUsed: 40_000, model: 'claude-sonnet-5-5', runtime: 'copilot', spend: { ...usage(30_000, 2_000), model: 'claude-sonnet-5-5', provider: 'copilot' } }

test('units: auto means money, an override wins, the toggle cycles money -> kWh -> tokens', () => {
  assert.equal(resolveUnit(cfg, null), 'money')
  assert.equal(resolveUnit(custom({ display: { unit: 'tokens' } }), null), 'tokens')
  assert.equal(resolveUnit(custom({ display: { unit: 'tokens' } }), 'kwh'), 'kwh')
  assert.equal(nextUnit('money'), 'kwh')
  assert.equal(nextUnit('kwh'), 'tokens')
  assert.equal(nextUnit('tokens'), 'money')
})

test('toggle label follows the display currency: $Cost, €Cost, kWh Cost, tok Cost', () => {
  assert.equal(costToggleLabel('money', cfg), '$Cost')
  const eur = custom({ currency: { display: 'EUR', fx: { EUR: 0.92 } } })
  assert.equal(costToggleLabel('money', eur), '€Cost')
  assert.equal(costToggleLabel('kwh', cfg), 'kWh Cost')
  assert.equal(costToggleLabel('tokens', cfg), 'tok Cost')
})

test('billed usage on an API provider: plain figure with the billed badge', () => {
  const c = priceAgent(cfg, API)
  assert.equal(flavorOf(c), 'billed')
  const l = buildPillLabel(c, API.tokensUsed, 'money', cfg)!
  assert.equal(l.badge, 'billed')
  assert.match(l.text, /^\$\d/)
  assert.ok(!l.text.includes('~') && !l.text.includes('sub'))
})

test('subscription usage is list-equivalent: "sub" suffix and the list-equiv badge', () => {
  const c = priceAgent(cfg, SUB)
  assert.equal(flavorOf(c), 'list-equivalent')
  const l = buildPillLabel(c, SUB.tokensUsed, 'money', cfg)!
  assert.equal(l.badge, 'list-equiv')
  assert.match(l.text, /^\$\d[\d.]* sub$/)
})

test('context-size estimate (no usage report) is marked estimated with a tilde', () => {
  const c = priceAgent(cfg, NO_USAGE)
  const l = buildPillLabel(c, NO_USAGE.tokensUsed, 'money', cfg)!
  assert.equal(l.flavor, 'estimated')
  assert.equal(l.badge, BADGE_LABEL.estimated)
  assert.match(l.text, /^~\$/)
})

test('Copilot usage is billed in credits and is labelled with its own kind, not as an API figure', () => {
  const c = priceAgent(cfg, COPILOT)
  const l = buildPillLabel(c, COPILOT.tokensUsed, 'money', cfg)!
  assert.ok(l.badge && ['billed', 'est', 'list-equiv'].includes(l.badge), l.badge ?? 'null')
  const t = buildAgentTooltip(c, cfg)
  assert.ok(tooltipPlainText(t).toLowerCase().includes('copilot'), 'the tooltip names the provider')
})

test('tokens unit: compact token counts, no money, no kind badge', () => {
  const c = priceAgent(cfg, API)
  const l = buildPillLabel(c, 5_300, 'tokens', cfg)!
  assert.equal(l.text, '5.3k tok')
  assert.equal(l.badge, null)
  assert.equal(buildPillLabel(c, 0, 'tokens', cfg), null)
})

test('kWh unit: only local models get a pill; a cloud agent gets none', () => {
  assert.equal(buildPillLabel(priceAgent(cfg, API), API.tokensUsed, 'kwh', cfg), null)
})

test('subscription value = hide: the pill shows tokens with a hidden badge instead of a figure', () => {
  const hid = custom({ display: { subscriptionValue: 'hide' } })
  const c = priceAgent(hid, SUB)
  assert.equal(flavorOf(c), 'hidden')
  const l = buildPillLabel(c, SUB.tokensUsed, 'money', hid)!
  assert.equal(l.badge, 'hidden')
  assert.match(l.text, /tok$/)
})

test('no pill below the minimum visible cost', () => {
  const c = priceAgent(cfg, { tokensUsed: 1, model: 'claude-sonnet-5-5', runtime: 'claude', spend: { ...usage(1, 0), model: 'claude-sonnet-5-5', provider: 'anthropic' } })
  assert.equal(buildPillLabel(c, 1, 'money', cfg), null)
})

test('summary splits totals by kind and never mixes billed with list-equivalent', () => {
  const items = [
    { name: 'api', cost: priceAgent(cfg, API), tokens: API.tokensUsed },
    { name: 'sub', cost: priceAgent(cfg, SUB), tokens: SUB.tokensUsed },
    { name: 'est', cost: priceAgent(cfg, NO_USAGE), tokens: NO_USAGE.tokensUsed },
  ]
  const s = buildCostSummary(items, 'money', cfg)
  assert.deepEqual(s.lines.map(l => l.flavor), ['billed', 'list-equivalent', 'estimated'])
  assert.ok(s.lines[1].text.endsWith(' sub'))
  assert.ok(s.lines[2].text.startsWith('~'))
  assert.equal(s.rows.length, 3)
  assert.equal(s.rows[0].ratio, 1, 'the biggest row fills the bar')
  assert.equal(s.tokensText, '130k tokens')
  // top bar: the same figures in one line
  assert.equal(buildTopBarCost(items, 'money', cfg), s.lines.map(l => l.text).join(' · '))
})

test('summary in the tokens unit: the token total is the headline, there is no money', () => {
  const items = [{ name: 'api', cost: priceAgent(cfg, API), tokens: 128_000 }]
  const s = buildCostSummary(items, 'tokens', cfg)
  assert.deepEqual(s.lines, [{ flavor: 'neutral', text: '128k', label: 'tokens' }])
  assert.equal(s.rows[0].text, '128k tok')
  assert.equal(buildTopBarCost(items, 'tokens', cfg), '')
})

test('summary in the kWh unit says kWh is for local models when there are none', () => {
  const s = buildCostSummary([{ name: 'api', cost: priceAgent(cfg, API), tokens: 1000 }], 'kwh', cfg)
  assert.equal(s.lines.length, 0)
  assert.match(s.notes[0], /local models/)
})

test('hidden subscription agents are counted in a note, not silently dropped', () => {
  const hid = custom({ display: { subscriptionValue: 'hide' } })
  const s = buildCostSummary([{ name: 'sub', cost: priceAgent(hid, SUB), tokens: 1000 }], 'money', hid)
  assert.ok(s.notes.some(n => n.includes('hidden')))
})

test('display currency: pills and totals use the symbol and the converted amount', () => {
  const eur = custom({ currency: { display: 'EUR', fx: { EUR: 0.5 } } })
  const usd = priceAgent(cfg, API)
  const e = priceAgent(eur, API)
  assert.ok(Math.abs(e.amount - usd.amount * 0.5) < 1e-9)
  assert.match(buildPillLabel(e, API.tokensUsed, 'money', eur)!.text, /^€/)
})

test('tool breakdown prices tool tokens at the owning agent rate (a custom price changes it) and is always an estimate', () => {
  const tools = [{ agentId: 'a', toolName: 'Read', tokens: 500_000 }, { agentId: 'a', toolName: 'Bash', tokens: 100_000 }]
  const base = buildToolBreakdown(tools, () => blendedPerMillion(cfg, { model: 'claude-sonnet-5-5', runtime: 'claude', spend: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }), 'money', cfg)
  assert.equal(base[0].name, 'Read')
  assert.ok(base[0].text.startsWith('~'))
  const pricey = custom({ pricing: { models: [{ match: { provider: 'anthropic', model: 'claude-sonnet-*' }, rate: { input: 100, output: 500 } }] } })
  const rate = blendedPerMillion(pricey, { model: 'claude-sonnet-5-5', runtime: 'claude', spend: { provider: 'anthropic', model: 'claude-sonnet-5-5' } })
  assert.ok(rate > blendedPerMillion(cfg, { model: 'claude-sonnet-5-5', runtime: 'claude', spend: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }))
  const tok = buildToolBreakdown(tools, () => 1, 'tokens', cfg)
  assert.deepEqual(tok.map(r => r.text), ['500k tok', '100k tok'])
  assert.deepEqual(buildToolBreakdown(tools, () => 1, 'kwh', cfg), [])
})

test('tooltip states provider, billing kind, rate source and formula', () => {
  for (const [input, kind] of [[API, 'billed'], [SUB, 'list'], [NO_USAGE, 'estimat']] as const) {
    const text = tooltipPlainText(buildAgentTooltip(priceAgent(cfg, input), cfg)).toLowerCase()
    assert.ok(text.includes('provider'), 'provider row')
    assert.ok(text.includes(kind), `${kind} named in: ${text}`)
    assert.ok(text.includes('formula'), 'formula row')
    assert.ok(/rate|source/.test(text), 'rate source row')
  }
})

test('tooltip of an agent with several prompt-size tiers sums tokens and keeps one formula per tier', () => {
  const tiered: AgentSpendInput = {
    tokensUsed: 600_000, model: 'claude-sonnet-5-5', runtime: 'claude',
    spend: { ...usage(300_000, 3_000), model: 'claude-sonnet-5-5', provider: 'anthropic', byBucket: { le100000: usage(100_000, 1_000), gt272000: usage(200_000, 2_000) } },
  }
  const c = priceAgent(cfg, tiered)
  const t = buildAgentTooltip(c, cfg)
  const formula = t.rows.find(r => r.id === 'formula')!.value
  assert.equal(formula.split('\n').length, c.results.length)
})

test('hit test: the topmost pill wins, slop widens the target, a miss is null', () => {
  const rects = [{ id: 'a', x: 10, y: 10, w: 40, h: 16 }, { id: 'b', x: 30, y: 12, w: 40, h: 16 }]
  assert.equal(findCostPillAt(35, 15, rects), 'b')
  assert.equal(findCostPillAt(15, 15, rects), 'a')
  assert.equal(findCostPillAt(8, 15, rects), 'a')
  assert.equal(findCostPillAt(200, 200, rects), null)
  assert.equal(findCostPillAt(8, 15, rects, 0), null)
})

test('pill geometry adds the badge chip to the width only when there is a badge', () => {
  const measure = (t: string) => t.length * 5
  const plain = pillGeometry({ text: '$1.00', badge: null, flavor: 'billed' }, measure)
  const badged = pillGeometry({ text: '$1.00', badge: 'billed', flavor: 'billed' }, measure)
  assert.ok(badged.w > plain.w)
  assert.equal(plain.badgeW, 0)
})

test('summary panel: normal place under the top bar on wide screens, bottom-right above the controls on a phone', () => {
  const wide = placeSummaryPanel(1200, 800, 220, 200, 12, 60)
  assert.deepEqual([wide.x, wide.y, wide.compact], [968, 60, false])
  const phone = placeSummaryPanel(NARROW_CANVAS_PX - 250, 700, 220, 200, 12, 60)
  assert.equal(phone.compact, true)
  assert.ok(phone.y > 60 && phone.y + 200 < 700)
  assert.ok(phone.maxRows < wide.maxRows)
})

test('config sources: a project file in use is reported as an override of the user file', () => {
  const none = describeSources([{ id: 'settings', path: null, status: 'missing', inUse: false }])
  assert.equal(none.projectOverrides, false)
  assert.match(none.text, /built-in/)
  const both = describeSources([
    { id: 'user', path: '~/.agent-flow/costs.json', status: 'ok', inUse: true },
    { id: 'project', path: '.agent-flow/costs.json', status: 'ok', inUse: true },
  ])
  assert.equal(both.projectOverrides, true)
  assert.match(both.text, /overrides user/)
  const userOnly = describeSources([
    { id: 'user', path: '~/.agent-flow/costs.json', status: 'ok', inUse: true },
    { id: 'project', path: null, status: 'missing', inUse: false },
  ])
  assert.equal(userOnly.projectOverrides, false)
})
