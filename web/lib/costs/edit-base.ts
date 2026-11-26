/**
 * Which version of the user's costs.json the settings drawer may edit from (P4 review, finding 1).
 *
 * The drawer writes the WHOLE document back. If it started from anything but the file's current, valid content,
 * a Save would erase or roll back what is on disk:
 *   - the file does not parse           -> the resolution has no `goodLayers.user`; a Save would write a bare `{}`
 *   - the file parses but fails checks  -> the resolution keeps the previous GOOD copy; a Save would drop what was added since
 *   - costs are turned off in settings  -> nothing is loaded; a Save would write a bare `{}`
 *   - the file changed after the drawer opened (see `isBaseChanged`)
 * So the drawer edits only from a layer that is `ok`, valid and fingerprinted, and says why when it cannot.
 * The host repeats the version check on every write (a stale page cannot win a race). Pure, no I/O.
 */
import type { SourceInfo } from './overlay'
import type { ValidationIssue } from './types'

type Obj = Record<string, unknown>

/** What the host calls a file that does not exist (extension/src/costs-config.ts MISSING_FINGERPRINT). */
export const MISSING_FINGERPRINT = 'missing'

export type EditBlockKind = 'not-loaded' | 'unreadable' | 'invalid' | 'not-in-use' | 'no-fingerprint'

export type EditBase =
  | { ok: true; doc: Obj | undefined; fingerprint: string }
  | { ok: false; kind: EditBlockKind; reason: string }

/**
 * @param userSource  the host's report of the user file (`undefined` until the first `costs-config` message)
 * @param userIssues  validation errors that belong to the user layer (layer `user`)
 * @param goodUser    the validated content the resolution holds for the user layer
 */
export function editBase(userSource: SourceInfo | undefined, userIssues: readonly ValidationIssue[], goodUser: Obj | undefined): EditBase {
  if (!userSource) return { ok: false, kind: 'not-loaded', reason: 'The costs file has not been read yet, so there is nothing safe to edit. Wait for the app to connect, then reopen the settings.' }
  if (userSource.status === 'missing') return { ok: true, doc: undefined, fingerprint: MISSING_FINGERPRINT }
  if (userSource.status === 'error') {
    return {
      ok: false, kind: 'unreadable',
      reason: `The costs file cannot be used right now${userSource.error ? ` (${userSource.error})` : ''}. Save is off so the drawer cannot overwrite it; fix the file, and the drawer picks up the fixed version.`,
    }
  }
  if (userIssues.length > 0) {
    const first = userIssues[0]
    return {
      ok: false, kind: 'invalid',
      reason: `The costs file has ${userIssues.length} problem${userIssues.length === 1 ? '' : 's'} (${first.path ? `${first.path}: ` : ''}${first.message}). The overlay is using the last good copy, so Save is off: it would overwrite your latest edits with that older copy. Fix the file, and the drawer picks up the fixed version.`,
    }
  }
  if (goodUser === undefined) return { ok: false, kind: 'not-in-use', reason: 'The costs file is not in use (cost settings are turned off in the VS Code settings, or it has not been applied yet), so the drawer cannot safely edit it.' }
  if (!userSource.fingerprint) return { ok: false, kind: 'no-fingerprint', reason: 'The host did not report which version of the costs file this is (an older host), so a save could not be checked against newer edits.' }
  return { ok: true, doc: goodUser, fingerprint: userSource.fingerprint }
}

/**
 * True when the file on disk is no longer the version the drawer's draft is based on. `known` lists the versions
 * that are ours: the one the draft was loaded from and, right after a save, the one before it (the file watcher
 * can announce the new content a moment after the save answered, which is not a conflict).
 */
export function isBaseChanged(current: EditBase, known: readonly string[]): boolean {
  return current.ok && !known.includes(current.fingerprint)
}
