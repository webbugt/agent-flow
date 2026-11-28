/**
 * Setting for the relay's periodic `server-version` announcement. Kept out of relay.ts (which pulls in
 * the `vscode` shim and cannot be imported by a plain test run).
 */

/** How often the build commit is re-announced to connected pages (they also get it on connect). */
export const DEFAULT_VERSION_BROADCAST_MS = 60_000
export const VERSION_BROADCAST_ENV = 'AGENT_FLOW_VERSION_BROADCAST_MS'

/** Interval in ms from an explicit option, then the env var, then 60 s; 0 turns the periodic broadcast off.
 *  Anything negative or not a number falls back to the default. */
export function resolveVersionBroadcastMs(
  explicit?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const fromEnv = env[VERSION_BROADCAST_ENV]
  const raw = explicit ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? Number(fromEnv) : DEFAULT_VERSION_BROADCAST_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_VERSION_BROADCAST_MS
}
