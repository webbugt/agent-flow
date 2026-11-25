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
