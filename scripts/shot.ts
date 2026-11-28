/**
 * Screenshot harness. Starts the BUILT app (app/dist/app.js) on a scratch port
 * with an isolated HOME and synthetic fixture sessions, drives headless
 * /usr/bin/google-chrome over the DevTools protocol, saves PNGs and cleans up.
 *
 *   pnpm shot --task-id t_xxxx [--plan builtin:overlay|builtin:h0|<file.json>] [options]
 *   pnpm shot:smoke
 *
 * Full usage: docs/screenshots/README.md (or `pnpm shot --help`).
 *
 * No dependency beyond Node itself: Chrome is driven with a ~100 line CDP client
 * on Node's global WebSocket (Node >= 22). puppeteer-core is not installed in this repo.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'

import {
  ArgError, BUILTIN_PLANS, HOLD_MS, VIEWPORTS, assertAllowedPort, expandPlan, parseShotArgs, validatePlan,
  type ShotOptions, type ShotPlan, type Step, type Viewport,
} from './shot-lib'
import { appendClaudeLiveLines, appendHermesLines, loadScenario, materializeFixtures, resolveScenario, rewriteConfigFixture, type Materialized } from './shot-fixtures'

const REPO = path.resolve(__dirname, '..')
const APP_JS = path.join(REPO, 'app', 'dist', 'app.js')
const CHROME = process.env.AGENT_FLOW_SHOT_CHROME || '/usr/bin/google-chrome'

const USAGE = `
Usage: pnpm shot --task-id <id> [options]

  --task-id <id>        required; screenshots go to <out>/<id>/
  --plan <p>            builtin:overlay (default), builtin:h0, or a JSON file { "shots": [...] }
  --viewports <list>    desktop,phone (default both); desktop = 1440x900, phone = 390x844, scale 2
  --scenario <name>     fixture set: costs (default), all, claude, hermes
  --port <n>            scratch port (default: a free one); 3001 and 3301 are refused
  --session <label>     session tab to select first (label substring, or "none"); default: the
                        scenario's first session (Claude: "Fixture F-A", else the first Hermes title).
                        Without this the page shows whichever session's events arrived last = not stable
  --limits <L-n>        seed ~/.agent-flow/limits/claude.json from fixture L-1..L-4
  --config <C-name>     seed ~/.agent-flow/costs.json from C-default|C-eur|C-invalid|C-custom-price|C-project-override|C-local-energy|C-local-energy-tou
  --out <dir>           base folder (default docs/screenshots)
  --start-index <n>     first NN in file names (default 1)
  --no-build            do not rebuild app/dist when it exists
  --keep-temp           keep the temp HOME and print its path
  -v, --verbose         print app and browser output

One-shot instead of a plan (combine freely, steps run in the order given):
  --name <slug> --key c --click <css> --hover <css|agent:first|agent:<name>|pill:<name>|x,y>
  --tap <same targets> --wait <ms> --wait-for <css>
`

function log(msg: string): void { console.log(`[shot] ${msg}`) }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Process bookkeeping: everything started here is killed on any exit path ─

const children: ChildProcess[] = []
const tempDirs: string[] = []
let cleaning = false

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* gone */ } }
}

async function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms)
    child.once('exit', () => { clearTimeout(t); resolve(true) })
  })
}

async function cleanup(keepTemp: boolean): Promise<void> {
  if (cleaning) return
  cleaning = true
  for (const c of [...children].reverse()) killTree(c, 'SIGTERM')
  for (const c of children) {
    if (!(await waitExit(c, 4000))) { killTree(c, 'SIGKILL'); await waitExit(c, 2000) }
  }
  children.length = 0
  if (!keepTemp) for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function pickPort(requested: number): Promise<number> {
  if (requested) {
    assertAllowedPort(requested)
    return requested
  }
  for (let i = 0; i < 20; i++) {
    const p = await freePort()
    try { assertAllowedPort(p) } catch { continue }
    return p
  }
  throw new Error('could not find a free allowed port')
}

function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

async function httpGetJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
  return res.json()
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs: number, everyMs = 100): Promise<T> {
  const t0 = Date.now()
  let lastErr: unknown
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch (e) { lastErr = e }
    await sleep(everyMs)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (${(lastErr as Error).message})` : ''}`)
}

// ─── Minimal CDP client (Node global WebSocket) ─────────────────────────────

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

class Cdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners: Array<(method: string, params: unknown, sessionId?: string) => void> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId)
      }
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<Cdp> {
    if (typeof WebSocket === 'undefined') throw new Error('this Node has no global WebSocket; use Node >= 22')
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(fn: (method: string, params: unknown, sessionId?: string) => void): void { this.listeners.push(fn) }
  close(): void { try { this.ws.close() } catch { /* already closed */ } }
}

class Page {
  constructor(private cdp: Cdp, private sessionId: string, readonly targetId: string) {}

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId)
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
    )
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value as T
  }
}

async function launchChrome(userDataDir: string, verbose: boolean): Promise<{ cdp: Cdp; proc: ChildProcess }> {
  if (!fs.existsSync(CHROME)) throw new Error(`${CHROME} not found (set AGENT_FLOW_SHOT_CHROME)`)
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--hide-scrollbars', '--mute-audio', '--disable-dev-shm-usage',
    '--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none',
    'about:blank',
  ]
  if (process.env.AGENT_FLOW_SHOT_NO_SANDBOX === '1') args.unshift('--no-sandbox')
  const proc = spawn(CHROME, args, { detached: true, stdio: ['ignore', 'ignore', verbose ? 'inherit' : 'ignore'] })
  children.push(proc)
  proc.once('error', e => log(`chrome failed to start: ${e.message}`))
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  const [port, wsPath] = await waitFor('Chrome DevToolsActivePort', () => {
    if (!fs.existsSync(portFile)) return undefined
    const [p, w] = fs.readFileSync(portFile, 'utf8').split('\n')
    return p && w ? [p, w] as [string, string] : undefined
  }, 20_000, 100)
  return { cdp: await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`), proc }
}

// ─── Steps ──────────────────────────────────────────────────────────────────

interface Point { x: number; y: number }

async function resolveTarget(page: Page, target: string): Promise<Point> {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(target)
  if (m) return { x: Number(m[1]), y: Number(m[2]) }
  const agent = /^agent:(.+)$/.exec(target)
  const pill = /^pill:(.+)$/.exec(target)
  const text = /^text:(.+)$/.exec(target)
  let expr: string
  if (text) {
    // First visible button/tab whose label contains the text (e.g. text:Copilot Demo for a session tab)
    expr = `(() => { const s = ${JSON.stringify(text[1])}; const e = Array.from(document.querySelectorAll('button,[role=tab],[role=button]')).find(b => b.textContent && b.textContent.includes(s) && b.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ inline: 'center', block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
  } else if (agent || pill) {
    const fn = agent ? 'agentRect' : 'pillRect'
    const name = (agent ?? pill)![1]
    expr = `(() => { const t = window.__AF_TEST__; if (!t) return null; return t.${fn}(${JSON.stringify(name)}) })()`  // 'first' is resolved by the page hooks (first agent / first agent with a cost pill)
  } else {
    expr = `(() => { const e = document.querySelector(${JSON.stringify(target)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
  }
  const rect = await page.eval<{ x: number; y: number; w: number; h: number } | null>(expr)
  if (!rect) throw new Error(`target "${target}" not found on the page`)
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

const KEY_CODES: Record<string, { code: string; vk: number }> = {
  Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13 }, ' ': { code: 'Space', vk: 32 },
}

async function pressKey(page: Page, key: string): Promise<void> {
  const known = KEY_CODES[key]
  const printable = key.length === 1
  const code = known?.code ?? (printable && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key)
  const vk = known?.vk ?? (printable ? key.toUpperCase().charCodeAt(0) : 0)
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await page.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: key } : {}) })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** After a tab click: let the page switch sessions, put the playhead at the last event (so speech bubbles etc.
 *  do not depend on how long the page ran), then wait for the camera to settle. */
async function settleAfterSessionChange(page: Page): Promise<void> {
  await sleep(500)
  await page.eval('window.__AF_TEST__.seekEnd()')
  await sleep(300)
  await waitFor('the camera to settle after changing the session', () => page.eval<boolean>('window.__AF_TEST__.settled()'), 15_000)
}

/** Scratch HOME of the run in progress; the `config` step writes its costs.json. */
let scratchHome: string | undefined
/** Scratch workspace (the app's cwd); the `config` step writes C-project* fixtures under it. */
let scratchWorkspace: string | undefined

async function runStep(page: Page, step: Step, viewport: Viewport): Promise<void> {
  if ('config' in step) {
    if (!scratchHome) throw new Error('config step: no scratch HOME')
    rewriteConfigFixture(scratchHome, step.config, scratchWorkspace)
  } else if ('key' in step || 'press' in step) {
    await pressKey(page, ('key' in step ? step.key : (step as { press: string }).press))
  } else if ('wait' in step) {
    await sleep(step.wait)
  } else if ('waitFor' in step) {
    const sel = step.waitFor
    await waitFor(`selector ${sel}`, () => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`), 15_000)
  } else if ('eval' in step) {
    await page.eval(step.eval)
  } else if ('click' in step) {
    const p = await resolveTarget(page, step.click)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    if (step.click.startsWith('text:')) await settleAfterSessionChange(page)
  } else if ('hold' in step) {
    const p = await resolveTarget(page, step.hold)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(HOLD_MS)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  } else if ('hover' in step) {
    const p = await resolveTarget(page, step.hover)
    // A few small moves: some handlers only react to a move that follows an enter
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x - 6, y: p.y - 6 })
    await sleep(60)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await sleep(60)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 1, y: p.y + 1 })
  } else if ('tap' in step) {
    const p = await resolveTarget(page, step.tap)
    if (!viewport.mobile) throw new Error('tap steps need the phone viewport (touch emulation)')
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
    await sleep(60)
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
}

// ─── One screenshot ─────────────────────────────────────────────────────────

async function captureOne(cdp: Cdp, baseUrl: string, viewport: Viewport, steps: Step[], expectAgents: number, session: string | undefined, errors: string[], verbose: boolean): Promise<Buffer> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  const page = new Page(cdp, sessionId, targetId)
  const onEvent = (method: string, params: unknown, sid?: string) => {
    if (sid !== sessionId) return
    const p = params as { exceptionDetails?: { text: string; exception?: { description?: string } }; type?: string; args?: Array<{ value?: unknown; description?: string }> }
    if (method === 'Runtime.exceptionThrown') errors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`)
    if (method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(`console.error: ${(p.args ?? []).map(a => a.value ?? a.description).join(' ')}`)
    if (verbose && method === 'Runtime.consoleAPICalled') log(`page console.${p.type}: ${(p.args ?? []).map(a => a.value ?? a.description).join(' ')}`)
  }
  cdp.on(onEvent)
  try {
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: viewport.mobile,
    })
    if (viewport.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    // Every shot reuses one Chrome profile. The screensaver choice and the app state (open panels, LIMITS fold) are kept in localStorage, so a shot that left the screensaver on would hide the
    // top bar the next shot waits for: clear it once per page (sessionStorage guard: a reload inside the shot keeps what the user chose).
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { if (!sessionStorage.getItem('af-shot-init')) { sessionStorage.setItem('af-shot-init', '1'); localStorage.removeItem('agent-flow:screensaver:v1'); localStorage.removeItem('agent-flow:app-state:v1') } } catch (e) {}`,
    })
    await page.send('Page.navigate', { url: `${baseUrl}/?shot=1` })
    try {
      await waitFor('the top bar', () => page.eval<boolean>(`!!document.querySelector('[data-testid="top-bar"]') && !!window.__AF_TEST__`), 20_000)
    } catch (e) {
      const seen = await page.eval<string>(`JSON.stringify({ url: location.href, title: document.title, hasTest: !!window.__AF_TEST__, body: document.body.innerText.slice(0, 300) })`).catch(() => '(page not readable)')
      throw new Error(`${(e as Error).message}; page state: ${seen}; page errors: ${errors.join(' | ') || 'none'}`)
    }
    // Events arrive over SSE as one history batch; wait until the agent count is what the scenario implies and stays.
    let last = -1
    let stableSince = Date.now()
    await waitFor(`${expectAgents}+ agents on the canvas`, async () => {
      const n = await page.eval<number>('window.__AF_TEST__.agentNames().length')
      if (n !== last) { last = n; stableSince = Date.now() }
      return n >= expectAgents && Date.now() - stableSince >= 1200
    }, 30_000)
    await page.eval('window.__AF_TEST__.freeze()')
    try {
      await waitFor('the page to freeze and the camera to settle', () => page.eval<boolean>('window.__AF_TEST__.ready && window.__AF_TEST__.settled()'), 15_000)
    } catch (e) {
      const seen = await page.eval<string>('JSON.stringify({ ready: window.__AF_TEST__.ready, settled: window.__AF_TEST__.settled(), agents: window.__AF_TEST__.agentNames() })').catch(() => '(page not readable)')
      throw new Error(`${(e as Error).message}; state: ${seen}; page errors: ${errors.join(' | ') || 'none'}`)
    }
    if (session) {
      // Make the picture independent of which session's events arrived last
      await runStep(page, { click: `text:${session}` }, viewport)
    } else {
      await page.eval('window.__AF_TEST__.seekEnd()')
      await sleep(300)
      await waitFor('the camera to settle', () => page.eval<boolean>('window.__AF_TEST__.settled()'), 15_000)
    }
    for (const step of steps) await runStep(page, step, viewport)
    await sleep(250)
    const shot = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    return Buffer.from(shot.data, 'base64')
  } finally {
    try { await cdp.send('Target.closeTarget', { targetId }) } catch { /* browser may be going away */ }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** Minimum agents a scenario puts on the canvas for the page to count as loaded. */
export function expectedAgents(scenario: string): number {
  const sc = resolveScenario(scenario)
  // Claude sessions: one orchestrator each (page shows the selected session; the tab count is checked separately).
  // Hermes profiles: a main node + a child per session. The page shows one session at a time, so ask for >= 1.
  return Math.max(1, Math.min(2, sc.claude.length + sc.hermes.length))
}

/** Tab label (substring) of the session every shot starts on, so runs do not depend on event arrival order. */
export function defaultSession(scenario: string): string | undefined {
  const sc = loadScenario(scenario)
  if (sc.claude.length > 0) return `Fixture ${sc.claude[0].id}`
  return sc.hermes[0]?.title
}

function loadPlan(spec: string): ShotPlan {
  if (spec.startsWith('builtin:')) {
    const p = BUILTIN_PLANS[spec.slice('builtin:'.length)]
    if (!p) throw new ArgError(`unknown built-in plan "${spec}" (${Object.keys(BUILTIN_PLANS).map(k => `builtin:${k}`).join(', ')})`)
    return p
  }
  let raw: unknown
  try { raw = JSON.parse(fs.readFileSync(spec, 'utf8')) } catch (e) { throw new ArgError(`cannot read plan ${spec}: ${(e as Error).message}`) }
  return validatePlan(raw)
}

export async function run(argv: string[]): Promise<number> {
  const opts = parseShotArgs(argv)
  if (opts.help) { console.log(USAGE); return 0 }
  const plan: ShotPlan = opts.custom ? { shots: [opts.custom] } : loadPlan(opts.plan)
  const jobs = expandPlan(plan, opts.viewports, opts.startIndex)
  if (jobs.length === 0) throw new ArgError('nothing to capture: no shot matches --viewports')

  if (!fs.existsSync(APP_JS) || !opts.noBuild) {
    log('building the app (pnpm run build:app)...')
    execFileSync('pnpm', ['run', 'build:app'], { cwd: REPO, stdio: opts.verbose ? 'inherit' : 'ignore' })
  }
  if (!fs.existsSync(APP_JS)) throw new Error(`${APP_JS} is missing after the build`)

  const port = await pickPort(opts.port)
  if (await portInUse(port)) throw new Error(`port ${port} is already in use`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-shot-'))
  tempDirs.push(tmp)
  const home = path.join(tmp, 'home')
  const workspace = path.join(tmp, 'workspace')
  fs.mkdirSync(home, { recursive: true })
  const m: Materialized = materializeFixtures({ home, workspace, scenario: opts.scenario, limits: opts.limits, config: opts.config })
  scratchHome = home
  scratchWorkspace = workspace
  log(`scratch HOME ${home}`)

  const outDir = path.resolve(REPO, opts.outDir, opts.taskId)
  fs.mkdirSync(outDir, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    AGENT_FLOW_HERMES_ROOT: m.hermesRoot,
    AGENT_FLOW_RUNTIME: 'claude',
    AGENT_FLOW_SHOT_LIMITS_CONFIGURABLE: '1',
    DO_NOT_TRACK: '1',
    AGENT_FLOW_TELEMETRY: '0',
    NO_COLOR: '1',
  }
  const app = spawn(process.execPath, [APP_JS, '--port', String(port), '--no-open'], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  let appOut = ''
  app.stdout?.on('data', d => { appOut += String(d); if (opts.verbose) process.stdout.write(`[app] ${d}`) })
  app.stderr?.on('data', d => { appOut += String(d); if (opts.verbose) process.stderr.write(`[app] ${d}`) })
  let appExited = false
  app.once('exit', code => { appExited = true; if (!cleaning) log(`app exited early with code ${code}`) })

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitFor('the app /health', async () => {
      if (appExited) throw new Error(`app exited:\n${appOut.slice(-800)}`)
      const h = await httpGetJson(`${baseUrl}/health`) as { status?: string }
      return h.status === 'ok' ? h : undefined
    }, 20_000)
    const health = await httpGetJson(`${baseUrl}/health`) as { branch?: string; commit?: string }
    log(`app up on ${baseUrl} (build ${health.branch} @ ${health.commit})`)

    // Hermes: the watcher attaches to an agent.log at its END, so usage lines are appended now (H0-A7).
    await sleep(1800)
    const appended = appendHermesLines(m, opts.scenario)
    if (appended > 0) log(`appended ${appended} Hermes log lines`)
    const live = appendClaudeLiveLines(m, opts.scenario)
    if (live > 0) log(`appended ${live} Claude transcript line(s)`)
    await sleep(opts.scenario === 'claude' ? 500 : 3000)

    const chromeDir = path.join(tmp, 'chrome')
    fs.mkdirSync(chromeDir)
    const { cdp } = await launchChrome(chromeDir, opts.verbose)
    const errors: string[] = []
    const written: string[] = []
    try {
      const expect = expectedAgents(opts.scenario)
      const session = opts.session === 'none' ? undefined : opts.session ?? defaultSession(opts.scenario)
      for (const job of jobs) {
        const png = await captureOne(cdp, baseUrl, VIEWPORTS[job.viewport], job.shot.steps ?? [], expect, session, errors, opts.verbose)
        const file = path.join(outDir, job.file)
        fs.writeFileSync(file, png)
        written.push(file)
        log(`wrote ${path.relative(REPO, file)} (${png.length} bytes, ${VIEWPORTS[job.viewport].width}x${VIEWPORTS[job.viewport].height} @${VIEWPORTS[job.viewport].deviceScaleFactor}x)`)
      }
    } finally {
      cdp.close()
    }
    if (errors.length > 0) {
      log(`page reported ${errors.length} error(s):`)
      for (const e of [...new Set(errors)].slice(0, 10)) log(`  ${e}`)
    }
    console.log('\nScreenshots:')
    for (const f of written) console.log(f)
    return 0
  } finally {
    await cleanup(opts.keepTemp)
    if (opts.keepTemp) log(`kept temp dir ${tmp}`)
    const stillUp = await portInUse(port)
    log(stillUp ? `WARNING: port ${port} is still in use after cleanup` : `cleanup done, port ${port} closed`)
  }
}

if (require.main === module) {
  const bail = (sig: NodeJS.Signals) => () => { void cleanup(false).finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)) }
  process.on('SIGINT', bail('SIGINT'))
  process.on('SIGTERM', bail('SIGTERM'))
  run(process.argv.slice(2)).then(code => process.exit(code), async err => {
    await cleanup(false)
    if (err instanceof ArgError) console.error(`shot: ${err.message}\n(see --help)`)
    else console.error(`shot: ${(err as Error).stack ?? err}`)
    process.exit(err instanceof ArgError ? 2 : 1)
  })
}

export type { ShotOptions }
