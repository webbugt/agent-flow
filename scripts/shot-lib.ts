/**
 * Pure helpers of the screenshot harness (scripts/shot.ts): argument parsing,
 * port refusal, viewport table, output file names, plan validation. No I/O, so
 * scripts/shot.test.ts can cover them without Chrome or a server.
 */

/** Ports the harness never uses: the live relay and the live proxy. */
export const FORBIDDEN_PORTS: readonly number[] = [3001, 3301]

export type ViewportName = 'desktop' | 'phone'

export interface Viewport {
  name: ViewportName
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export const VIEWPORTS: Record<ViewportName, Viewport> = {
  desktop: { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  phone: { name: 'phone', width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
}

/** One scripted interaction. Exactly one key per step. */
export type Step =
  | { key: string }
  | { click: string }
  | { hover: string }
  | { tap: string }
  | { wait: number }
  | { waitFor: string }
  | { eval: string }
  | { press: string }
  /** Rewrite the scratch ~/.agent-flow/costs.json to a C-* fixture while the app and the page keep running (hot reload). C-default removes the file. */
  | { config: string }

export interface ShotSpec {
  /** Slug used in the file name */
  name: string
  viewports?: ViewportName[]
  steps?: Step[]
}

export interface ShotPlan {
  shots: ShotSpec[]
}

export interface ShotOptions {
  taskId: string
  /** 0 = pick a free port */
  port: number
  scenario: string
  /** `builtin:<name>` or a JSON file path */
  plan: string
  viewports: ViewportName[]
  limits?: string
  config?: string
  /** Session tab to select before the steps run: a label substring, or "none" to keep what the page chose. Default: the scenario's first session (see defaultSession). */
  session?: string
  /** Directory the `<task-id>` folder is created in */
  outDir: string
  /** First NN in file names */
  startIndex: number
  /** Custom one-shot (from --name/--hover/--click/--key) instead of a plan */
  custom?: ShotSpec
  /** Keep the temp HOME after the run (debugging) */
  keepTemp: boolean
  /** Skip `pnpm run build:app` when app/dist/app.js already exists */
  noBuild: boolean
  verbose: boolean
  help: boolean
}

export class ArgError extends Error {}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export function assertAllowedPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ArgError(`invalid port ${port}`)
  }
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new ArgError(`refusing port ${port}: it belongs to the live relay/proxy; pick another or omit --port`)
  }
}

function parseViewports(value: string): ViewportName[] {
  const out: ViewportName[] = []
  for (const part of value.split(',').map(p => p.trim()).filter(Boolean)) {
    if (part !== 'desktop' && part !== 'phone') throw new ArgError(`unknown viewport "${part}" (desktop, phone)`)
    if (!out.includes(part)) out.push(part)
  }
  if (out.length === 0) throw new ArgError('--viewports needs at least one of desktop, phone')
  return out
}

/** Parse argv (without node and script). Throws ArgError with a readable message. */
export function parseShotArgs(argv: string[]): ShotOptions {
  const opts: ShotOptions = {
    taskId: '',
    port: 0,
    scenario: 'costs',
    plan: '',
    viewports: ['desktop', 'phone'],
    outDir: 'docs/screenshots',
    startIndex: 1,
    keepTemp: false,
    noBuild: false,
    verbose: false,
    help: false,
  }
  const custom: { name?: string; steps: Step[] } = { steps: [] }
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new ArgError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--help': case '-h': opts.help = true; break
      case '--task-id': opts.taskId = need(i, a); i++; break
      case '--port': {
        const n = Number(need(i, a)); i++
        assertAllowedPort(n)
        opts.port = n
        break
      }
      case '--scenario': opts.scenario = need(i, a); i++; break
      case '--plan': opts.plan = need(i, a); i++; break
      case '--viewports': opts.viewports = parseViewports(need(i, a)); i++; break
      case '--session': opts.session = need(i, a); i++; break
      case '--limits': opts.limits = need(i, a); i++; break
      case '--config': opts.config = need(i, a); i++; break
      case '--out': opts.outDir = need(i, a); i++; break
      case '--start-index': {
        const n = Number(need(i, a)); i++
        if (!Number.isInteger(n) || n < 1 || n > 99) throw new ArgError('--start-index must be 1..99')
        opts.startIndex = n
        break
      }
      case '--keep-temp': opts.keepTemp = true; break
      case '--no-build': opts.noBuild = true; break
      case '--verbose': case '-v': opts.verbose = true; break
      case '--name': custom.name = need(i, a); i++; break
      case '--key': custom.steps.push({ key: need(i, a) }); i++; break
      case '--click': custom.steps.push({ click: need(i, a) }); i++; break
      case '--hover': custom.steps.push({ hover: need(i, a) }); i++; break
      case '--tap': custom.steps.push({ tap: need(i, a) }); i++; break
      case '--wait': {
        const n = Number(need(i, a)); i++
        if (!Number.isFinite(n) || n < 0 || n > 60_000) throw new ArgError('--wait must be 0..60000 ms')
        custom.steps.push({ wait: n })
        break
      }
      case '--wait-for': custom.steps.push({ waitFor: need(i, a) }); i++; break
      default:
        throw new ArgError(`unknown argument "${a}" (see --help)`)
    }
  }
  if (opts.help) return opts
  if (!opts.taskId) throw new ArgError('--task-id <id> is required (the folder docs/screenshots/<id>/)')
  if (!TASK_ID_RE.test(opts.taskId)) throw new ArgError(`--task-id "${opts.taskId}" must match ${TASK_ID_RE}`)
  if (custom.name || custom.steps.length > 0) {
    if (opts.plan) throw new ArgError('use either --plan or the one-shot flags (--name/--key/--click/--hover/--tap), not both')
    opts.custom = { name: slug(custom.name ?? 'custom'), steps: custom.steps }
  } else if (!opts.plan) {
    opts.plan = 'builtin:overlay'
  }
  return opts
}

export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!out) throw new ArgError(`"${s}" has no usable characters for a file name`)
  return out
}

/** True if the step list contains a hover (adds the `-hover` suffix). */
export function hasHover(steps: Step[] | undefined): boolean {
  return (steps ?? []).some(s => 'hover' in s)
}

export function shotFileName(index: number, name: string, viewport: ViewportName, steps?: Step[]): string {
  const nn = String(index).padStart(2, '0')
  return `${nn}-${slug(name)}-${viewport}${hasHover(steps) ? '-hover' : ''}.png`
}

const STEP_KEYS = ['key', 'click', 'hover', 'tap', 'wait', 'waitFor', 'eval', 'press', 'config'] as const

/** Validate a plan read from JSON; returns it typed or throws ArgError. */
export function validatePlan(raw: unknown): ShotPlan {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { shots?: unknown }).shots)) {
    throw new ArgError('plan must be an object with a "shots" array')
  }
  const shots = (raw as { shots: unknown[] }).shots
  if (shots.length === 0) throw new ArgError('plan has no shots')
  const names = new Set<string>()
  return {
    shots: shots.map((s, i) => {
      if (!s || typeof s !== 'object') throw new ArgError(`shots[${i}] must be an object`)
      const shot = s as Record<string, unknown>
      if (typeof shot.name !== 'string') throw new ArgError(`shots[${i}].name must be a string`)
      const name = slug(shot.name)
      if (names.has(name)) throw new ArgError(`shots[${i}].name "${name}" is used twice`)
      names.add(name)
      let viewports: ViewportName[] | undefined
      if (shot.viewports !== undefined) {
        if (!Array.isArray(shot.viewports)) throw new ArgError(`shots[${i}].viewports must be an array`)
        viewports = parseViewports(shot.viewports.join(','))
      }
      let steps: Step[] | undefined
      if (shot.steps !== undefined) {
        if (!Array.isArray(shot.steps)) throw new ArgError(`shots[${i}].steps must be an array`)
        steps = shot.steps.map((st, j) => {
          if (!st || typeof st !== 'object') throw new ArgError(`shots[${i}].steps[${j}] must be an object`)
          const keys = Object.keys(st as object)
          if (keys.length !== 1 || !(STEP_KEYS as readonly string[]).includes(keys[0])) {
            throw new ArgError(`shots[${i}].steps[${j}] must have exactly one of ${STEP_KEYS.join(', ')}`)
          }
          const v = (st as Record<string, unknown>)[keys[0]]
          if (keys[0] === 'wait') {
            if (typeof v !== 'number' || !(v >= 0 && v <= 60_000)) throw new ArgError(`shots[${i}].steps[${j}].wait must be 0..60000`)
          } else if (typeof v !== 'string' || v === '') {
            throw new ArgError(`shots[${i}].steps[${j}].${keys[0]} must be a non-empty string`)
          }
          return st as Step
        })
      }
      return { name, ...(viewports ? { viewports } : {}), ...(steps ? { steps } : {}) }
    }),
  }
}

/** Page script: click the cost unit toggle (money -> kWh -> tokens -> money) until the stored unit is `unit`. */
function TOGGLE_TO(unit: 'money' | 'kwh' | 'tokens'): string {
  return `(async () => {
    for (let i = 0; i < 4; i++) {
      const cur = (() => { try { return JSON.parse(localStorage.getItem('agentFlow.costUnit') || 'null').unit } catch { return null } })() || 'money'
      if (cur === ${JSON.stringify(unit)}) return cur
      document.querySelector('[data-testid="cost-unit-toggle"]').click()
      await new Promise(r => setTimeout(r, 120))
    }
    return localStorage.getItem('agentFlow.costUnit')
  })()`
}

/** P5 shots: select the local demo session and turn the cost overlay on. */
const LOCAL: Step[] = [{ click: 'text:Local Demo' }, { wait: 800 }, { key: '$' }, { wait: 300 }]
const OPEN_DRAWER: Step[] = [{ click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' }, { wait: 300 }]
function SCROLL_TO(testid: string): string { return `document.querySelector('[data-testid="${testid}"]').scrollIntoView({ block: 'start' })` }

/** Built-in plans. `h0` is the harness self-test of task H0; `overlay` is what `pnpm shot:smoke` runs. */
export const BUILTIN_PLANS: Record<string, ShotPlan> = {
  // Costs P3 hot-reload pair. Run with `--config C-default --start-index 3`. The second shot opens the page with the
  // USD config, turns the overlay on (pill in USD), THEN rewrites costs.json to C-eur in the same page without
  // restarting anything, so the EUR pill in the picture came from the live reload, not from a fresh page load.
  // C-default means no file and no ~/.agent-flow directory, which the loader can only watch by its 5 s poll, hence the long wait.
  hotreload: {
    shots: [
      { name: 'hot-reload-before-usd', viewports: ['desktop'], steps: [{ key: '$' }, { wait: 400 }] },
      { name: 'hot-reload-after-eur', viewports: ['desktop'], steps: [{ key: '$' }, { wait: 600 }, { config: 'C-eur' }, { wait: 7000 }] },
    ],
  },
  overlay: {
    shots: [
      { name: 'cost-overlay', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { wait: 300 }] },
    ],
  },
  // Costs P4: overlay per session kind (API / subscription / Copilot), provider tooltips, settings drawer, unit toggle.
  // The drawer shots drive the real inputs (native setter + input event, as React expects) and the real Save button,
  // so "settings-saved-eur" proves the whole path: drawer -> POST /costs-config -> file -> watcher -> overlay.
  p4: {
    shots: [
      { name: 'overlay-api', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { wait: 300 }] },
      { name: 'overlay-subscription-listequiv', viewports: ['desktop', 'phone'], steps: [{ click: 'text:Sub Demo' }, { wait: 500 }, { key: '$' }, { wait: 300 }] },
      { name: 'overlay-copilot', viewports: ['desktop', 'phone'], steps: [{ click: 'text:Copilot Demo' }, { wait: 500 }, { key: '$' }, { wait: 300 }] },
      { name: 'tooltip-api', viewports: ['desktop'], steps: [{ key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
      { name: 'tooltip-subscription', viewports: ['desktop'], steps: [{ click: 'text:Sub Demo' }, { wait: 500 }, { key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
      { name: 'tooltip-copilot', viewports: ['desktop'], steps: [{ click: 'text:Copilot Demo' }, { wait: 500 }, { key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
      { name: 'tooltip-tap', viewports: ['phone'], steps: [{ click: 'text:Sub Demo' }, { wait: 500 }, { key: '$' }, { tap: 'pill:first' }, { wait: 300 }] },
      { name: 'tooltip-tap-copilot', viewports: ['phone'], steps: [{ click: 'text:Copilot Demo' }, { wait: 500 }, { key: '$' }, { tap: 'pill:first' }, { wait: 300 }] },
      { name: 'settings-drawer', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { config: 'C-custom-price' }, { wait: 7000 }, { click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' }, { wait: 300 }] },
      {
        name: 'settings-drawer-error', viewports: ['desktop', 'phone'], steps: [
          { key: '$' }, { click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' },
          { eval: `(() => { const el = document.querySelector('[data-testid="field-currency"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'EUR'); el.dispatchEvent(new Event('input', { bubbles: true })) })()` },
          { wait: 400 },
        ],
      },
      {
        name: 'settings-saved-eur', viewports: ['desktop', 'phone'], steps: [
          { key: '$' }, { click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' },
          { eval: `(() => { const set = (sel, v) => { const el = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }; set('[data-testid="field-currency"]', 'EUR'); setTimeout(() => set('[data-testid="field-fx"]', '0.92'), 50) })()` },
          { wait: 500 }, { click: '[data-testid="costs-save"]' }, { waitFor: '[data-testid="costs-saved"]' }, { wait: 2500 },
          { click: '[data-testid="costs-settings-close"]' }, { wait: 500 },
        ],
      },
      // The unit choice is kept in localStorage and every shot reuses one Chrome profile, so each unit shot first clicks the
      // real toggle until it reads the wanted unit (the click path is the thing being shown), whatever the previous shot left.
      { name: 'unit-tokens', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { eval: TOGGLE_TO('tokens') }, { wait: 400 }] },
      { name: 'unit-kwh-local', viewports: ['desktop', 'phone'], steps: [{ click: 'text:Local Demo' }, { wait: 500 }, { config: 'C-local-energy' }, { wait: 2500 }, { key: '$' }, { eval: TOGGLE_TO('kwh') }, { wait: 400 }] },
      // P4-A4: display.subscriptionValue = hide takes the subscription money out of pill, panel and top-bar total
      { name: 'subscription-hidden', viewports: ['desktop'], steps: [{ click: 'text:Sub Demo' }, { wait: 500 }, { key: '$' }, { eval: TOGGLE_TO('money') }, { config: 'C-hide-subscription' }, { wait: 7000 }] },
      // LAST on purpose: the project file stays in the scratch workspace for the rest of the run. It overrides the user's
      // prices: the top bar shows a "project" badge (its title names the file) and the pill uses the project's rates.
      { name: 'project-override-badge', viewports: ['desktop', 'phone'], steps: [{ click: 'text:Fixture F-A' }, { wait: 500 }, { key: '$' }, { eval: TOGGLE_TO('money') }, { config: 'C-project-override' }, { wait: 7000 }] },
    ],
  },
  // Costs P4, second half. Run with `--scenario all --start-index <next number>`: these sessions (F-C, F-G, F-H) are not in
  // the `costs` scenario. PLAN v2 P4 shots 7-9: tier line (F-C, a 120K-token prompt), unpriced fallback (F-G), no reported usage (F-H).
  p4b: {
    shots: [
      { name: 'tooltip-haiku-tier-high', viewports: ['desktop'], steps: [{ click: 'text:Fixture F-C' }, { wait: 500 }, { key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
      { name: 'tooltip-unknown-fallback', viewports: ['desktop'], steps: [{ click: 'text:Unknown Demo' }, { wait: 500 }, { key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
      { name: 'tooltip-estimate-no-usage', viewports: ['desktop'], steps: [{ click: 'text:Fixture F-H' }, { wait: 500 }, { key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
    ],
  },
  // Costs P4 review round 1. Run with `--scenario all --start-index <next number>`. Shot 12 of the plan (a session that mixes billing
  // kinds: F-I has a billed main agent and an estimated sub-agent) and the settings drawer in the three states in which it must not
  // offer Save (broken file, invalid file with a last-good copy, file changed on disk after the drawer opened). The config steps
  // keep the file in place for the next shot, so the order matters: broken -> repaired and one bad rule -> hand edit.
  p4c: {
    shots: [
      { name: 'summary-split-by-kind', viewports: ['desktop', 'phone'], steps: [{ click: 'text:Fixture F-I' }, { wait: 1500 }, { key: '$' }, { eval: TOGGLE_TO('money') }, { wait: 600 }] },
      { name: 'drawer-broken-file', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { config: 'C-broken-json' }, { wait: 7000 }, { click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' }, { wait: 400 }] },
      { name: 'drawer-last-good', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { config: 'C-custom-price' }, { wait: 3000 }, { config: 'C-one-bad-rule' }, { wait: 3000 }, { click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' }, { wait: 400 }] },
      { name: 'drawer-file-changed', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { config: 'C-custom-price' }, { wait: 3000 }, { click: '[data-testid="cost-settings-open"]' }, { waitFor: '[data-testid="costs-settings-drawer"]' }, { wait: 400 }, { config: 'C-hand-edit' }, { wait: 3000 }] },
    ],
  },
  // Costs P5: local-model energy. Run with `--config C-local-energy --start-index <next number>`. The first shots use the flat price; then the
  // config is rewritten to the time-of-day tariff (the live reload is the thing being shown: same busy time, new price).
  p5: {
    shots: [
      // every shot is a fresh page: each one selects the local session, turns the overlay on and sets the unit itself
      { name: 'local-kwh-and-cost', viewports: ['desktop', 'phone'], steps: [...LOCAL, { eval: TOGGLE_TO('kwh') }, { wait: 500 }] },
      { name: 'local-money-unit', viewports: ['desktop'], steps: [...LOCAL, { eval: TOGGLE_TO('money') }, { wait: 500 }] },
      { name: 'tooltip-energy-formula', viewports: ['desktop'], steps: [...LOCAL, { eval: TOGGLE_TO('kwh') }, { wait: 300 }, { hover: 'pill:first' }, { wait: 400 }] },
      { name: 'tooltip-energy-formula-tap', viewports: ['phone'], steps: [...LOCAL, { eval: TOGGLE_TO('kwh') }, { wait: 300 }, { tap: 'pill:first' }, { wait: 400 }] },
      { name: 'energy-profile-editor', viewports: ['desktop', 'phone'], steps: [...LOCAL, ...OPEN_DRAWER, { eval: SCROLL_TO('profile-0') }, { wait: 400 }] },
    ],
  },
  // Costs P5, tariff effect. Run with `--config C-local-energy-tou --start-index 8`: the same fixture and busy time as p5, priced by a
  // peak window of the current hour instead of the flat price, so the tooltip's tariff row and the result differ from p5's.
  p5tou: {
    shots: [
      { name: 'tariff-tou-tooltip', viewports: ['desktop'], steps: [...LOCAL, { eval: TOGGLE_TO('kwh') }, { wait: 300 }, { hover: 'pill:first' }, { wait: 400 }] },
      { name: 'tariff-tou-tooltip-tap', viewports: ['phone'], steps: [...LOCAL, { eval: TOGGLE_TO('kwh') }, { wait: 300 }, { tap: 'pill:first' }, { wait: 400 }] },
      { name: 'tariff-tou-editor', viewports: ['desktop', 'phone'], steps: [...LOCAL, ...OPEN_DRAWER, { eval: SCROLL_TO('tariff-editor') }, { wait: 400 }] },
    ],
  },
  // Costs P6a: observed limits. Run three times, with --limits L-4 (opt-in prompt), L-1 (fresh) and L-3 (stale, "as of"), and a
  // distinct --start-index each time. The top-bar chip is in every shot; the drawer section is scrolled into view.
  p6a: {
    shots: [
      { name: 'limits-drawer', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { wait: 3000 }, ...OPEN_DRAWER, { eval: SCROLL_TO('claude-limits') }, { wait: 400 }] },
      { name: 'limits-topbar', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { wait: 3000 }] },
    ],
  },
  // Costs P6b: the LIMITS panel (bottom-right on desktop, a sheet above the control bar on a phone). Each run is one state; the
  // panel is account-wide, so it is the same whichever session tab is selected. Runs (distinct --start-index each):
  //   --scenario claude --limits L-1 --config C-limits   observed 5h / weekly, no Fable calls: NO Fable row
  //   --scenario costs  --limits L-2 --config C-limits   observed rows + Fable row (estimate icon, typed-budget basis)
  //   --scenario costs  --limits L-4 --config C-limits   estimates only: `est` tags, a tiny Fable value in per-mille
  //   --scenario costs  --limits L-5 --config C-limits   calibrated against the reading history: `cal` tag, weekly-meter Fable basis
  // The p6b_fable_tip / p6b_row_tip plans are for runs that have the element to hover (the harness cannot hover a missing one).
  p6b: {
    shots: [
      { name: 'limits-panel', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { wait: 3500 }] },
    ],
  },
  p6b_fable_tip: {
    shots: [
      { name: 'limits-fable-hover', viewports: ['desktop'], steps: [{ key: '$' }, { wait: 3500 }, { hover: '[data-testid="limits-row-fable"]' }, { wait: 400 }] },
      { name: 'limits-fable-tap', viewports: ['phone'], steps: [{ key: '$' }, { wait: 3500 }, { tap: '[data-testid="limits-row-fable"]' }, { wait: 400 }] },
    ],
  },
  p6b_row_tip: {
    shots: [
      { name: 'limits-5h-hover', viewports: ['desktop'], steps: [{ key: '$' }, { wait: 3500 }, { hover: '[data-testid="limits-row-5h"]' }, { wait: 400 }] },
    ],
  },
  h0: {
    shots: [
      { name: 'baseline-overlay-off', viewports: ['desktop'] },
      { name: 'baseline-overlay-on', viewports: ['desktop', 'phone'], steps: [{ key: '$' }, { wait: 300 }] },
      { name: 'agent-hover', viewports: ['desktop'], steps: [{ key: '$' }, { hover: 'agent:first' }, { wait: 300 }] },
      { name: 'agent-tap', viewports: ['phone'], steps: [{ tap: 'agent:first' }, { wait: 300 }] },
      { name: 'pill-hover', viewports: ['desktop'], steps: [{ key: '$' }, { hover: 'pill:first' }, { wait: 300 }] },
      { name: 'session-fable', viewports: ['desktop'], steps: [{ click: 'text:Fixture F-D' }, { wait: 500 }, { key: '$' }, { wait: 300 }] },
      { name: 'session-copilot', viewports: ['desktop'], steps: [{ click: 'text:Copilot Demo' }, { wait: 500 }, { key: '$' }, { wait: 300 }] },
      { name: 'session-local', viewports: ['desktop'], steps: [{ click: 'text:Local Demo' }, { wait: 500 }, { key: '$' }, { wait: 300 }] },
    ],
  },
}

/** Shots x viewports -> ordered file list. */
export function expandPlan(plan: ShotPlan, allowed: ViewportName[], startIndex: number): Array<{
  index: number
  file: string
  shot: ShotSpec
  viewport: ViewportName
}> {
  const out: Array<{ index: number; file: string; shot: ShotSpec; viewport: ViewportName }> = []
  let index = startIndex
  for (const shot of plan.shots) {
    const wanted = (shot.viewports ?? allowed).filter(v => allowed.includes(v))
    for (const viewport of wanted) {
      out.push({ index, file: shotFileName(index, shot.name, viewport, shot.steps), shot, viewport })
      index++
    }
  }
  return out
}
