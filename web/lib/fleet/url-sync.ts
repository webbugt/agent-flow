/**
 * Generic URL <-> stored-choice sync for app options. One helper, used by every option that lives in the
 * query string (`fleet`, `screensaver`, `anchorMode`; see url-view.ts for the specs). The rule:
 *
 *  a. On load the URL wins over localStorage. A key present (and valid) in the URL is applied; a missing or
 *     invalid key is filled from the stored value.
 *  b. Keys missing from the URL are appended from the active state, so the address bar always shows it.
 *  c. On every change the new value is written to the URL (history.replaceState, no reload, no new history
 *     entry) and to storage (each option's owner persists it; `persist` below).
 *  d. After load, storage matches the URL: a value the URL set is saved when it differs from the stored one.
 *
 * Pure functions on a search string and an injected window-like target, so they are testable without a DOM.
 * Other query parameters (`shot`, `stress`, ...) keep their order and value.
 */

/** How one option is written to and read from the query string. */
export interface UrlParam<T> {
  /** The query key. */
  param: string
  /** The value for a raw query value, or undefined when it is not a recognised value (it is then ignored). */
  parse(raw: string | null | undefined): T | undefined
  /** The query value for a state value. */
  format(value: T): string
}

/** One spec per option name; an option without a spec is not touched. */
export type UrlParamSpecs<S> = { [K in keyof S]?: UrlParam<NonNullable<S[K]>> }

/** Saves one option to its own storage. Called with the value the URL set (on load) or the new value. */
export type PersistMap<S> = { [K in keyof S]?: (value: NonNullable<S[K]>) => void }

function paramsOf(search: string | null | undefined): URLSearchParams {
  const raw = search ?? ''
  return new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
}

function keysOf<S>(specs: UrlParamSpecs<S>): (keyof S)[] {
  return Object.keys(specs) as (keyof S)[]
}

/** The option values the URL names. Unknown, missing and unrecognised values are left out (never an error). */
export function readUrlState<S>(search: string | null | undefined, specs: UrlParamSpecs<S>): Partial<S> {
  const out: Partial<S> = {}
  if (!search) return out
  const params = paramsOf(search)
  for (const key of keysOf(specs)) {
    const spec = specs[key]
    if (!spec) continue
    const value = spec.parse(params.get(spec.param))
    if (value !== undefined) out[key] = value as S[typeof key]
  }
  return out
}

/** The state to start from: what the URL names wins, the stored value fills in what it does not. */
export function resolveUrlState<S>(stored: S, fromUrl: Partial<S>): S {
  const out = { ...stored }
  for (const key of Object.keys(fromUrl) as (keyof S)[]) {
    if (fromUrl[key] !== undefined) out[key] = fromUrl[key] as S[typeof key]
  }
  return out
}

/**
 * Load step. Reads the URL, resolves the start state (URL wins, storage fills the rest) and saves every value
 * the URL set that differs from the stored one, so storage matches what is shown. Returns the start state.
 */
export function syncOnLoad<S>(
  search: string | null | undefined,
  stored: S,
  specs: UrlParamSpecs<S>,
  persist: PersistMap<S> = {},
): S {
  const fromUrl = readUrlState(search, specs)
  for (const key of Object.keys(fromUrl) as (keyof S)[]) {
    const value = fromUrl[key]
    if (value === undefined || value === stored[key]) continue
    persist[key]?.(value as NonNullable<S[typeof key]>)
  }
  return resolveUrlState(stored, fromUrl)
}

/**
 * The search string with every option in `state` written as its spec formats it (missing keys are appended,
 * existing ones replaced in place). An option whose value is undefined is left as it is in the URL.
 * Returns the empty string when there is nothing to write.
 */
export function buildUrlSearch<S>(search: string | null | undefined, state: S, specs: UrlParamSpecs<S>): string {
  const params = paramsOf(search)
  for (const key of keysOf(specs)) {
    const spec = specs[key]
    const value = state[key]
    if (!spec || value === undefined || value === null) continue
    params.set(spec.param, spec.format(value as NonNullable<S[typeof key]>))
  }
  const next = params.toString()
  return next ? `?${next}` : ''
}

/** The parts of `window` the sync touches (so a test can pass a plain object). */
export interface UrlTarget {
  location: { pathname: string; search: string; hash: string }
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void }
}

/**
 * Writes the state to the address bar with replaceState (no reload, no new history entry; the state Next.js
 * attaches to the entry is kept, hash and other parameters too). Returns true when the URL changed.
 */
export function replaceUrlState<S>(target: UrlTarget, state: S, specs: UrlParamSpecs<S>): boolean {
  const current = target.location.search
  const next = buildUrlSearch(current, state, specs)
  if (next === (current || '')) return false
  target.history.replaceState(target.history.state, '', `${target.location.pathname}${next}${target.location.hash}`)
  return true
}

/**
 * One option changed: save it to its own storage, then write the whole state to the URL. `state` already holds
 * the new value. Returns whether the URL changed.
 */
export function commitChange<S, K extends keyof S>(
  target: UrlTarget,
  state: S,
  key: K,
  specs: UrlParamSpecs<S>,
  persist: PersistMap<S> = {},
): boolean {
  const value = state[key]
  if (value !== undefined && value !== null) persist[key]?.(value as NonNullable<S[K]>)
  return replaceUrlState(target, state, specs)
}
