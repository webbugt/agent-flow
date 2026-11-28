/**
 * D5: the demo event source is not wired to the live relay or its SSE stream.
 *
 * Static guard over the demo files: they must not import the live bridge modules, open connections, or name the
 * relay's endpoints. Plus a module-graph walk, so a forbidden module pulled in through a helper is caught too.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const WEB = path.resolve(__dirname, '..', '..')

/** Files that make up the demo source (entry, hook, reducer, panel, helpers). */
const DEMO_FILES = [
  'lib/demo/demo-state.ts',
  'lib/demo/demo-feed.ts',
  'lib/demo/demo-presets.ts',
  'lib/demo/demo-route.ts',
  'hooks/use-demo-bridge.ts',
  'hooks/bridge-hook-result.ts',
  'components/agent-visualizer/demo-visualizer.tsx',
  'components/agent-visualizer/demo-panel.tsx',
  'app/demo/page.tsx',
]

/** Live-path modules the demo source must never reach. */
const FORBIDDEN_MODULES = [
  'hooks/use-vscode-bridge',
  'lib/vscode-bridge',
  'lib/auto-reload',
  'lib/costs-write',
  'hooks/use-fleet-sources',
]

/** Text that means a connection to, or knowledge of, the relay. */
const FORBIDDEN_TEXT: Array<[string, RegExp]> = [
  ['EventSource (SSE)', /\bEventSource\b/],
  ['fetch()', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['/events endpoint', /['"`]\/events\b/],
  ['/api/fleet endpoint', /\/api\/fleet/],
  ['/health endpoint', /['"`]\/health\b/],
  ['costs-config endpoint', /costs-config/],
  ['relay port env', /RELAY_PORT/],
  ['relay port 3001', /\b3001\b/],
  ['proxy port 3301', /\b3301\b/],
  ['acquireVsCodeApi', /acquireVsCodeApi/],
  ['window message listener', /addEventListener\s*\(\s*['"]message['"]/],
]

function read(rel: string): string {
  return readFileSync(path.join(WEB, rel), 'utf8')
}

/** Strip comments, so a sentence that explains the rule does not trip the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function importsOf(src: string): string[] {
  const out: string[] = []
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code(src)))) out.push(m[1])
  return out
}

/** Resolve a web-local import to a repo-relative file without extension, or null for packages. */
function resolveLocal(spec: string, fromRel: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = spec.slice(2)
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  else return null
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(path.join(WEB, base + ext))) return base + ext
  }
  return null
}

function reachable(entries: string[]): Map<string, string> {
  const seen = new Map<string, string>()
  const queue: Array<[string, string]> = entries.map(e => [e, '(entry)'])
  while (queue.length) {
    const [file, via] = queue.shift()!
    if (seen.has(file)) continue
    seen.set(file, via)
    for (const spec of importsOf(read(file))) {
      const next = resolveLocal(spec, file)
      if (next) queue.push([next, file])
    }
  }
  return seen
}

const strip = (f: string) => f.replace(/\.(tsx?|\/index\.tsx?)$/, '')

describe('demo isolation (D5)', () => {
  it('every demo file exists (the list below is not stale)', () => {
    for (const f of DEMO_FILES) assert.ok(existsSync(path.join(WEB, f)), `${f} missing: update DEMO_FILES`)
  })

  for (const f of DEMO_FILES) {
    it(`${f} opens no connection and names no relay endpoint`, () => {
      const src = code(read(f))
      for (const [what, re] of FORBIDDEN_TEXT) assert.ok(!re.test(src), `${f} must not use ${what}`)
    })
  }

  it('the demo files do not import the live bridge or its siblings, directly or through any local module', () => {
    // demo-visualizer / the route page are left out of the walk: they mount the shared view, which is checked below.
    const graph = reachable(DEMO_FILES.filter(f => !f.startsWith('app/') && !f.endsWith('demo-visualizer.tsx')))
    const hit = [...graph.entries()].filter(([f]) => FORBIDDEN_MODULES.includes(strip(f)))
    assert.deepEqual(hit.map(([f, via]) => `${f} (via ${via})`), [])
  })

  it('the demo reducer and hook stay out of the visualiser view\'s live-only modules', () => {
    // The view itself imports the live fleet hook (the live path), so the graph of the pure demo files must not contain the view.
    const graph = reachable(['lib/demo/demo-state.ts', 'hooks/use-demo-bridge.ts', 'lib/demo/demo-feed.ts'])
    const view = [...graph.keys()].filter(f => strip(f).startsWith('components/agent-visualizer/visualizer-view'))
    assert.deepEqual(view, [])
  })

  it('the demo entry does not call the live bridge hook', () => {
    const entry = code(read('components/agent-visualizer/demo-visualizer.tsx'))
    assert.ok(!/useVSCodeBridge/.test(entry))
    assert.ok(/useDemoBridge/.test(entry))
  })

  it('the view turns off every live read when it is the demo', () => {
    const view = code(read('components/agent-visualizer/visualizer-view.tsx'))
    assert.ok(/shouldPollLiveFleet\(/.test(view), 'the Fleet poll is gated by shouldPollLiveFleet')
    assert.ok(!/useVSCodeBridge/.test(view), 'the view takes its bridge as a prop; it never calls the live hook itself')
    // The settings drawer saves through the relay (/costs-config): it must stay closed in the demo.
    assert.ok(/!sv\s*&&\s*!demo\s*&&\s*showCostSettings/.test(view), 'the costs settings drawer is gated by !demo')
    // The only network use of the view's own code is the gated Fleet poll.
    // (not "window message listener": the view's limits/costs hooks listen passively; not "costs-config": a file name there)
    for (const [what, re] of FORBIDDEN_TEXT.filter(([w]) => w !== 'window message listener' && w !== 'costs-config endpoint')) {
      assert.ok(!re.test(view), `the view itself must not use ${what}`)
    }
  })

  it('the only module the view reaches that fetches or posts is on the known list, and each is gated or passive in the demo', () => {
    const graph = reachable(['components/agent-visualizer/visualizer-view.tsx'])
    const net = /\bfetch\s*\(|\bEventSource\b|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b/
    const found = [...graph.keys()].filter(f => !f.endsWith('.test.ts') && net.test(code(read(f)))).sort()
    // use-fleet-sources: polled only when shouldPollLiveFleet() (false in the demo); costs-write: only from the drawer (not mounted in the demo).
    assert.deepEqual(found, ['hooks/use-fleet-sources.ts', 'lib/costs-write.ts'])
  })

  it('the live entry still uses the live bridge, and does not know the demo source', () => {
    const live = code(read('components/agent-visualizer/index.tsx'))
    assert.ok(/useVSCodeBridge/.test(live))
    assert.ok(!/demo/i.test(live))
  })

  it('the live bridge hook does not import the demo source', () => {
    const graph = reachable(['hooks/use-vscode-bridge.ts'])
    const demo = [...graph.keys()].filter(f => /(^|\/)(use-demo-bridge|demo-[a-z]+)\./.test(f))
    assert.deepEqual(demo, [])
  })
})
