/**
 * The Fleet view, the screensaver mode and the resource-anchor mode, read from and written to the URL query string:
 *
 *   ?fleet=1        Fleet view on        ?fleet=0        Fleet view off
 *   ?screensaver=1  screensaver on       ?screensaver=0  screensaver off
 *   ?anchorMode=1   anchors mode on      ?anchorMode=0   anchors mode off
 *
 * When the URL names one of them, that value wins over the browser's stored choice (localStorage) at load.
 * Otherwise the stored choice applies, as before, and is appended to the URL, so the address bar always shows the
 * current state and can be bookmarked or shared. Other query parameters (`shot`, `stress`) are left as they are.
 *
 * `fleet` and `screensaver` also accept `on/off/true/false` (kept from the first version). `anchorMode` takes the
 * standard values `0` and `1` only; anything else (`yes`, `2`, empty) is ignored, the stored choice applies, and
 * nothing errors.
 *
 * The rules live in ONE helper (url-sync.ts); this file holds the specs (which keys, which values) for the app's
 * view options. Pure functions on a search string (`location.search`, with or without the leading `?`), so they are
 * testable without a DOM.
 */
import {
  buildUrlSearch, readUrlState, resolveUrlState, syncOnLoad,
  type PersistMap, type UrlParam, type UrlParamSpecs,
} from './url-sync'

export const FLEET_PARAM = 'fleet'
export const SCREENSAVER_PARAM = 'screensaver'
export const ANCHOR_MODE_PARAM = 'anchorMode'

export interface ViewParams {
  /** true / false when the URL names the view, undefined when it does not (or the value is not recognised). */
  fleet?: boolean
  screensaver?: boolean
  anchorMode?: boolean
}

export interface ViewState {
  fleet: boolean
  screensaver: boolean
  anchorMode: boolean
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

/** Reads a strict `0` / `1` query value. Everything else (`yes`, `2`, `true`, empty) is undefined. */
export function parseBinaryValue(raw: string | null | undefined): boolean | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  if (v === '1') return true
  if (v === '0') return false
  return undefined
}

const formatBinary = (v: boolean): string => (v ? '1' : '0')
const looseBoolean = (param: string): UrlParam<boolean> => ({ param, parse: parseViewValue, format: formatBinary })

/** Where each view option lives in the query string. Add an option here to put it under the sync rule. */
export const VIEW_URL_SPECS: UrlParamSpecs<ViewState> = {
  fleet: looseBoolean(FLEET_PARAM),
  screensaver: looseBoolean(SCREENSAVER_PARAM),
  anchorMode: { param: ANCHOR_MODE_PARAM, parse: parseBinaryValue, format: formatBinary },
}

/** The view parameters the URL names. Only `fleet`, `screensaver` and `anchorMode` are read here. */
export function parseViewParams(search: string | null | undefined): ViewParams {
  return readUrlState<ViewState>(search, VIEW_URL_SPECS)
}

/**
 * The search string with every view parameter set to the current state (`1` or `0`). Other parameters keep
 * their order and value. Returns the input unchanged when it already says the same.
 */
export function buildViewSearch(search: string | null | undefined, view: ViewState): string {
  return buildUrlSearch<ViewState>(search, view, VIEW_URL_SPECS)
}

/** The view to start from: what the URL names wins, the stored value fills in what it does not. */
export function resolveStartView(stored: ViewState, fromUrl: ViewParams): ViewState {
  return resolveUrlState(stored, fromUrl)
}

/**
 * Load step for one view option: the URL value wins over `stored`, a URL value that differs from `stored` is
 * saved through `persist` (so storage matches what is shown), and the active value is returned. A missing or
 * unrecognised URL value leaves `stored` as the active value.
 */
export function restoreViewOption<K extends keyof ViewState>(
  search: string | null | undefined,
  key: K,
  stored: ViewState[K],
  persist: (value: ViewState[K]) => void,
): ViewState[K] {
  const specs = { [key]: VIEW_URL_SPECS[key] } as UrlParamSpecs<Pick<ViewState, K>>
  const persistMap = { [key]: persist } as PersistMap<Pick<ViewState, K>>
  return syncOnLoad(search, { [key]: stored } as Pick<ViewState, K>, specs, persistMap)[key]
}
