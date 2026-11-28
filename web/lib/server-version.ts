/**
 * Auto-reload on app update. The relay (backend) announces the commit it was built from as a
 * `server-version` message, on connect and then periodically; the page compares it with the commit
 * baked into its own bundle and reloads once when they differ.
 *
 * Pure logic only (no window, no storage), so the relay builds the message and the tests exercise the
 * decision with the same code the page runs. The browser side lives in ./auto-reload.ts.
 */

export const UNKNOWN_COMMIT = 'unknown'

export interface ServerVersionMessage {
  type: 'server-version'
  commit: string
  branch: string
}

/** The message the relay sends. Anything that is not a non-empty string becomes 'unknown'. */
export function serverVersionMessage(info: { commit?: unknown; branch?: unknown }): ServerVersionMessage {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : UNKNOWN_COMMIT)
  return { type: 'server-version', commit: s(info.commit), branch: s(info.branch) }
}

/** Shape check of an incoming message; null when it is not a `server-version` message. */
export function parseServerVersion(data: unknown): ServerVersionMessage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type !== 'server-version' || typeof d.commit !== 'string') return null
  return serverVersionMessage({ commit: d.commit, branch: d.branch })
}

/** True for a real commit id; '', 'unknown' (dev / tsx run, no build info) and non-strings are not. */
export function isKnownCommit(commit: unknown): commit is string {
  return typeof commit === 'string' && commit.trim() !== '' && commit.trim().toLowerCase() !== UNKNOWN_COMMIT
}

/**
 * Reload only when both commits are known and differ, and not when this page already reloaded for this
 * very server commit (`lastReloadedFor`): a bundle that stays stale after a reload (cache, half deploy)
 * would otherwise reload forever. A newer server commit reloads again.
 */
export function shouldReload(opts: { clientCommit: unknown; serverCommit: unknown; lastReloadedFor?: string | null }): boolean {
  const { clientCommit, serverCommit, lastReloadedFor } = opts
  if (!isKnownCommit(clientCommit) || !isKnownCommit(serverCommit)) return false
  if (clientCommit.trim() === serverCommit.trim()) return false
  return lastReloadedFor?.trim() !== serverCommit.trim()
}
