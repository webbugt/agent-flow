/**
 * The Fleet view and the screensaver mode, read from and written to the URL query string:
 *
 *   ?fleet=1        Fleet view on        ?fleet=0        Fleet view off
 *   ?screensaver=1  screensaver on       ?screensaver=0  screensaver off
 *
 * When the URL names one of them, that value wins over the browser's stored choice (localStorage) at load.
 * Otherwise the stored choice applies, as before. After load the URL is kept in sync with both views, so
 * the address bar always shows the current state and can be bookmarked or shared. Other query parameters
 * (`shot`, `stress`) are left as they are.
 *
 * Pure functions on a search string (`location.search`, with or without the leading `?`), so they are
 * testable without a DOM. Anything that is not a recognised value is ignored (the stored choice applies).
 */

export const FLEET_PARAM = 'fleet'
export const SCREENSAVER_PARAM = 'screensaver'

export interface ViewParams {
  /** true / false when the URL names the view, undefined when it does not (or the value is not recognised). */
  fleet?: boolean
  screensaver?: boolean
}

export interface ViewState {
  fleet: boolean
  screensaver: boolean
}

const TRUE_VALUES: ReadonlySet<string> = new Set(['1', 'on', 'true'])
const FALSE_VALUES: ReadonlySet<string> = new Set(['0', 'off', 'false'])

/** Reads one boolean query value. Case-insensitive; `1/on/true` and `0/off/false` are recognised, all else is undefined. */
export function parseViewValue(raw: string | null | undefined): boolean | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  if (TRUE_VALUES.has(v)) return true
  if (FALSE_VALUES.has(v)) return false
  return undefined
}

/** The view parameters the URL names. Only `fleet` and `screensaver` are read here. */
export function parseViewParams(search: string | null | undefined): ViewParams {
  const out: ViewParams = {}
  if (!search) return out
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const fleet = parseViewValue(params.get(FLEET_PARAM))
  if (fleet !== undefined) out.fleet = fleet
  const screensaver = parseViewValue(params.get(SCREENSAVER_PARAM))
  if (screensaver !== undefined) out.screensaver = screensaver
  return out
}

/**
 * The search string with both view parameters set to the current state (`1` or `0`). Other parameters keep
 * their order and value. Returns the input unchanged when it already says the same.
 */
export function buildViewSearch(search: string | null | undefined, view: ViewState): string {
  const raw = search ?? ''
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
  params.set(FLEET_PARAM, view.fleet ? '1' : '0')
  params.set(SCREENSAVER_PARAM, view.screensaver ? '1' : '0')
  const next = params.toString()
  return next ? `?${next}` : ''
}

/** The view to start from: what the URL names wins, the stored value fills in what it does not. */
export function resolveStartView(stored: ViewState, fromUrl: ViewParams): ViewState {
  return {
    fleet: fromUrl.fleet ?? stored.fleet,
    screensaver: fromUrl.screensaver ?? stored.screensaver,
  }
}
