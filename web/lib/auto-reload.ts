/**
 * Browser side of the auto-reload (decision logic: ./server-version.ts). Called for every `server-version`
 * message the relay sends over SSE.
 */
import { parseServerVersion, shouldReload } from './server-version'

/** sessionStorage key: the server commit this tab last reloaded for (survives the reload, not the tab). */
export const RELOAD_GUARD_KEY = 'agent-flow:reloaded-for:v1'

/** The commit baked into this bundle (build-time define / Next public env); 'unknown' when not built with one. */
export function clientCommit(): string {
  try {
    return process.env.NEXT_PUBLIC_BUILD_COMMIT || 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface ReloadDeps {
  clientCommit: string
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  reload: () => void
}

function browserDeps(): ReloadDeps {
  let storage: Storage | null = null
  try { storage = window.sessionStorage } catch { /* storage blocked: no guard, so no reload */ }
  return { clientCommit: clientCommit(), storage, reload: () => window.location.reload() }
}

/** Returns true when it asked the page to reload. */
export function handleServerVersion(data: unknown, deps: ReloadDeps = browserDeps()): boolean {
  const msg = parseServerVersion(data)
  if (!msg) return false
  let last: string | null = null
  try { last = deps.storage?.getItem(RELOAD_GUARD_KEY) ?? null } catch { /* ignore */ }
  if (!shouldReload({ clientCommit: deps.clientCommit, serverCommit: msg.commit, lastReloadedFor: last })) return false
  // Without a working guard store a reload could loop: only reload once the guard is written.
  if (!deps.storage) return false
  try { deps.storage.setItem(RELOAD_GUARD_KEY, msg.commit) } catch { return false }
  deps.reload()
  return true
}
