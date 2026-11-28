/**
 * Where the demo lives. Shared by the browser entry (which view to mount) and the standalone server (which
 * paths answer with the HTML shell). No imports: both sides can load it.
 */
export const DEMO_PATH = '/demo'

/** True for `/demo` and `/demo/` (query and fragment ignored); nothing below it. */
export function isDemoPath(pathname: string): boolean {
  const cut = pathname.search(/[?#]/)
  const p = cut === -1 ? pathname : pathname.slice(0, cut)
  return p === DEMO_PATH || p === `${DEMO_PATH}/`
}
