/**
 * Build identity of this bundle. app/build.js inlines the git branch and commit
 * via esbuild `define` (see scripts/build-info.js); running from source (tsx)
 * has no such constants and reports 'unknown'.
 */
export interface BuildInfo {
  branch: string
  commit: string
}

declare const AGENT_FLOW_BUILD_BRANCH: string | undefined
declare const AGENT_FLOW_BUILD_COMMIT: string | undefined

function inlined(read: () => string | undefined): string {
  try {
    const v = read()
    if (typeof v === 'string' && v) return v
  } catch { /* ReferenceError when not bundled: fall through */ }
  return 'unknown'
}

export const BUILD_INFO: BuildInfo = {
  branch: inlined(() => AGENT_FLOW_BUILD_BRANCH),
  commit: inlined(() => AGENT_FLOW_BUILD_COMMIT),
}
