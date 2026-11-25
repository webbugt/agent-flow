/**
 * extension/costs.schema.json (editor autocomplete, wired through contributes.jsonValidation) must not drift from
 * web/lib/costs/validate.ts. extension/src cannot import web/lib (rootDir), so the test reads the validator's
 * SOURCE and compares: every key list it passes to warnUnknown/parseBudget, the forbidden keys, the enums and the
 * TIER_BOUNDARIES membership rule. Adding a key to validate.ts without the schema (or the reverse) fails here.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ext = path.resolve(__dirname, '..')
const web = path.resolve(ext, '..', 'web', 'lib', 'costs')
const schema = JSON.parse(fs.readFileSync(path.join(ext, 'costs.schema.json'), 'utf8')) as Schema
const validateSrc = fs.readFileSync(path.join(web, 'validate.ts'), 'utf8')
const typesSrc = fs.readFileSync(path.join(web, 'types.ts'), 'utf8')
const tiersSrc = fs.readFileSync(path.join(web, 'tiers.ts'), 'utf8')

interface Schema {
  properties?: Record<string, Schema>
  propertyNames?: { not?: { enum?: string[] } }
  additionalProperties?: boolean | Schema
  required?: string[]
  enum?: unknown[]
  oneOf?: Schema[]
  items?: Schema
  $ref?: string
  $defs?: Record<string, Schema>
  [k: string]: unknown
}

const strings = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map(m => m[1])
const sorted = (a: readonly unknown[]) => [...a].map(String).sort()

/** `const NAME ... = [ 'a', 'b' ]` in a source text. */
function constList(src: string, name: string): string[] {
  const m = new RegExp(`const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(src)
  assert.ok(m, `${name} not found; update this test with the validator`)
  return strings(m[1])
}

/** Every object schema in the document (including $defs), each with its property key set. */
function objectNodes(): { where: string; node: Schema }[] {
  const out: { where: string; node: Schema }[] = []
  const walk = (n: unknown, where: string) => {
    if (typeof n !== 'object' || n === null) return
    if (Array.isArray(n)) { n.forEach((x, i) => walk(x, `${where}[${i}]`)); return }
    const s = n as Schema
    if (s.properties && typeof s.properties === 'object') out.push({ where, node: s })
    for (const [k, v] of Object.entries(s)) walk(v, `${where}/${k}`)
  }
  walk(schema, '#')
  return out.filter(o => o.node.properties)
}

/** All key lists validate.ts treats as the known keys of some object (the rest is an "unknown key" warning). */
function validatorKeyLists(): { label: string; keys: string[] }[] {
  const lists: { label: string; keys: string[] }[] = []
  const consts: Record<string, string[]> = { RATE_KEYS: constList(validateSrc, 'RATE_KEYS'), FAMILIES: constList(validateSrc, 'FAMILIES') }
  for (const m of validateSrc.matchAll(/warnUnknown\((\w+(?:\.\w+)*), (\[[^\]]*\]|[A-Z_]+), /g)) {
    const keys = m[2].startsWith('[') ? strings(m[2]) : consts[m[2]]
    assert.ok(keys, `cannot resolve the key list ${m[2]}`)
    lists.push({ label: `warnUnknown(${m[1]}, ${m[2]})`, keys })
  }
  for (const m of validateSrc.matchAll(/parseBudget\([^;\n]*?, I, (\[[^\]]*\])\)/g)) lists.push({ label: `parseBudget(${m[1]})`, keys: strings(m[1]) })
  return lists
}

describe('costs.schema.json vs web/lib/costs/validate.ts', () => {
  it('the top-level keys equal the keys validate.ts knows (the drift guard)', () => {
    const m = /warnUnknown\(raw, (\[[^\]]*\]), \[\], I\)/.exec(validateSrc)
    assert.ok(m, 'top-level warnUnknown(raw, [...], [], I) not found in validate.ts')
    assert.deepEqual(sorted(Object.keys(schema.properties ?? {})), sorted(strings(m[1])))
  })

  it('every key list validate.ts uses for an object matches the property set of some schema object', () => {
    const nodes = objectNodes().map(o => ({ where: o.where, keys: sorted(Object.keys(o.node.properties ?? {})) }))
    const lists = validatorKeyLists()
    assert.ok(lists.length >= 20, `found only ${lists.length} key lists; the extraction regex is stale`)
    for (const l of lists) {
      const want = sorted(l.keys)
      assert.ok(nodes.some(n => JSON.stringify(n.keys) === JSON.stringify(want)),
        `${l.label} lists [${want.join(', ')}] but no schema object has exactly those properties`)
    }
  })

  it('every schema object has a property set that validate.ts also lists (no invented keys)', () => {
    const lists = validatorKeyLists().map(l => JSON.stringify(sorted(l.keys)))
    // `tier` has maxPromptTokens + rate; `codex` is a placeholder property (a warning in validate.ts), so sets are compared per object.
    for (const o of objectNodes()) {
      const keys = JSON.stringify(sorted(Object.keys(o.node.properties ?? {})))
      assert.ok(lists.includes(keys), `${o.where} has properties ${keys}, which validate.ts never lists`)
    }
  })

  it('forbidden keys are rejected on every object and map schema', () => {
    const forbidden = constList(validateSrc, 'FORBIDDEN_KEYS')
    assert.deepEqual(sorted(forbidden), ['__proto__', 'constructor', 'prototype'])
    const missing: string[] = []
    const walk = (n: unknown, where: string) => {
      if (typeof n !== 'object' || n === null) return
      if (Array.isArray(n)) { n.forEach((x, i) => walk(x, `${where}[${i}]`)); return }
      const s = n as Schema
      if (s.type === 'object') {
        const banned = s.propertyNames?.not?.enum
        if (!banned || JSON.stringify(sorted(banned)) !== JSON.stringify(sorted(forbidden))) missing.push(where)
      }
      for (const [k, v] of Object.entries(s)) walk(v, `${where}/${k}`)
    }
    walk(schema, '#')
    assert.deepEqual(missing, [], 'object schemas without the forbidden-key rule')
  })

  it('enums equal the validator enums', () => {
    const defs = schema.$defs as Record<string, Schema>
    const p = schema.properties as Record<string, Schema>
    const at = (n: Schema, ...keys: string[]): Schema => keys.reduce((s, k) => (s.properties as Record<string, Schema>)[k], n)
    assert.deepEqual(defs.billing.enum, constList(typesSrc, 'BILLING_MODES'))
    assert.deepEqual(at(p.pricing, 'unknownModel', 'policy').enum, constList(typesSrc, 'UNKNOWN_MODEL_POLICIES'))
    assert.deepEqual(defs.weekday.enum, constList(typesSrc, 'WEEKDAYS'))
    assert.deepEqual((at(defs.claudeLimits, 'plan').enum as unknown[]).filter(x => x !== null), constList(typesSrc, 'CLAUDE_PLANS'))
    assert.deepEqual(at(p.display, 'unit').enum, strings(/oneOf<DisplayUnit>\([^,]*, (\[[^\]]*\])/.exec(validateSrc)?.[1] ?? ''))
    assert.deepEqual(at(p.display, 'subscriptionValue').enum, strings(/d\.subscriptionValue, (\[[^\]]*\])/.exec(validateSrc)?.[1] ?? ''))
    assert.deepEqual(defs.provider.properties?.priceLike.enum, strings(/oneOf\(v\.priceLike, (\[[^\]]*\])/.exec(validateSrc)?.[1] ?? ''))
    assert.deepEqual(at(defs.energyProfile, 'attribution').enum, strings(/oneOf\(v\.attribution, (\[[^\]]*\])/.exec(validateSrc)?.[1] ?? ''))
    assert.deepEqual((at(defs.claudeLimits, 'sources').items as Schema).enum, strings(/oneOf\(x, (\[[^\]]*\]) as const, \[\.\.\.path, 'sources'/.exec(validateSrc)?.[1] ?? ''))
    assert.deepEqual(sorted(Object.keys(at(defs.claudeLimits, 'weights').properties ?? {})), sorted(constList(validateSrc, 'FAMILIES')))
    assert.deepEqual(p.schemaVersion.const, 1)
  })

  it('tier maxPromptTokens is limited to the TIER_BOUNDARIES members, and the last tier is open-ended', () => {
    const m = /TIER_BOUNDARIES[^=]*=\s*\[([^\]]*)\]/.exec(tiersSrc)
    assert.ok(m, 'TIER_BOUNDARIES not found')
    const boundaries = m[1].split(',').map(s => Number(s.replace(/_/g, '').trim())).filter(n => Number.isFinite(n) && n > 0)
    assert.ok(boundaries.length >= 3)
    const tier = (schema.$defs as Record<string, Schema>).tier
    assert.deepEqual(tier.properties?.maxPromptTokens.enum, boundaries)
    assert.deepEqual(tier.required, ['rate'], 'maxPromptTokens must stay optional: the last tier omits it')
    assert.match(String(tier.properties?.maxPromptTokens.description), /omit it on the last tier/)
  })

  it('numeric bounds match the validator constants (rates, multiplier)', () => {
    const num = (name: string) => Number(new RegExp(`const ${name} = ([0-9_]+)`).exec(validateSrc)?.[1].replace(/_/g, ''))
    const defs = schema.$defs as Record<string, Schema>
    const rateProps = defs.rate.properties as Record<string, { maximum?: number }>
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) assert.equal(rateProps[k].maximum, num('RATE_MAX'), k)
    const mult = (schema.properties as Record<string, Schema>).pricing.properties?.multiplier as { maximum?: number }
    assert.equal(mult.maximum, num('MULTIPLIER_MAX'))
    assert.equal((schema.properties as Record<string, Schema>).pricing.properties?.providers.maxProperties, num('MAX_PROVIDERS'))
  })
})

describe('extension/package.json wiring', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8')) as {
    contributes: { jsonValidation?: { fileMatch: string | string[]; url: string }[] }
  }

  it('contributes.jsonValidation maps **/.agent-flow/costs.json to a schema file that exists and ships in the vsix', () => {
    const entry = pkg.contributes.jsonValidation?.find(e => [e.fileMatch].flat().includes('**/.agent-flow/costs.json'))
    assert.ok(entry, 'no jsonValidation entry for **/.agent-flow/costs.json')
    assert.equal(entry.url, './costs.schema.json')
    assert.ok(fs.existsSync(path.join(ext, entry.url)))
    const ignore = fs.readFileSync(path.join(ext, '.vscodeignore'), 'utf8').split('\n').map(l => l.trim())
    assert.ok(!ignore.some(l => l === 'costs.schema.json' || l === '*.json' || l === '**/*.json'), '.vscodeignore would drop the schema from the package')
  })
})
