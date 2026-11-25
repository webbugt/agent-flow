/**
 * Boundary test: web/lib/costs/ stays pure (PLAN v2 section 5: "pure, UI-free modules"). Non-test
 * files may import only from sibling costs/ files and the pricing/agent-types shims; they must not
 * touch the file system, network, process, DOM, React or the clock-less globals that would make
 * results host-dependent. Tests may use node:*.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : []
  })
}
const files = sources(DIR)
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('costs/ has the P1 modules', () => {
  const names = files.map(f => f.slice(DIR.length + 1))
  for (const n of ['types.ts', 'validate.ts', 'resolve.ts', 'price.ts', 'format.ts', 'tooltip.ts', 'limits.ts', 'tiers.ts', 'catalog/index.ts']) {
    assert.ok(names.includes(n), `missing ${n}`)
  }
})

test('non-test costs/ modules import only relative costs/ files (and the agent-types data types)', () => {
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'))
    const specs = [...src.matchAll(/^(?:import|export\s+(?:\{|\*))[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map(m => m[1])
    for (const spec of specs) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f}: bare import "${spec}"`)
      assert.ok(!/node:|^fs|^path|^os$|react|next\//.test(spec), `${f}: forbidden import "${spec}"`)
      const target = resolve(dirname(f), spec)
      const inside = target === DIR || target.startsWith(DIR + sep)
      assert.ok(inside || target === resolve(DIR, '..', 'agent-types'), `${f}: import "${spec}" leaves costs/`)
    }
    assert.ok(!/^\s*import\s*\(/m.test(src) && !/\bimport\(/.test(src), `${f}: dynamic import`)
  }
})

test('non-test costs/ modules use no I/O, process, DOM or timer globals', () => {
  const banned: [RegExp, string][] = [
    [/\bprocess\./, 'process'], [/\brequire\s*\(/, 'require'], [/\bfetch\s*\(/, 'fetch'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bdocument\./, 'document'], [/\bwindow\./, 'window'], [/\blocalStorage\b/, 'localStorage'], [/\bsetTimeout\s*\(/, 'setTimeout'],
    [/\bsetInterval\s*\(/, 'setInterval'], [/\bMath\.random\b/, 'Math.random'], [/\bconsole\./, 'console'], [/\beval\s*\(/, 'eval'],
    [/\bnew Function\b/, 'new Function'], [/\bfs\./, 'fs'], [/\bchild_process\b/, 'child_process'],
  ]
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8')).replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    for (const [re, name] of banned) assert.ok(!re.test(src), `${f}: uses ${name}`)
  }
})

test('the clock is only read in one place: resolve/catalog take `at`, nothing calls Date.now() except the limits default', () => {
  const users = files.filter(f => /\bDate\.now\s*\(|new Date\(\s*\)/.test(strip(readFileSync(f, 'utf8')))).map(f => f.slice(DIR.length + 1))
  for (const u of users) assert.ok(['limits.ts', 'catalog/index.ts', 'catalog.ts'].includes(u), `unexpected clock read in ${u}`)
})
