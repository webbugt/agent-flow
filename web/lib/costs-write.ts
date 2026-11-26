/**
 * Save the costs document from the settings drawer. One entry point for both hosts:
 *  - VS Code webview: a message to the extension host (`write-costs-config`), which writes the file.
 *  - standalone page: `POST /costs-config` on the app server (same origin) or the relay (dev, NEXT_PUBLIC_RELAY_PORT).
 * Either way the host writes the file; the page learns the new config from the normal `costs-config` message
 * (file watcher), so the overlay changes exactly as it would after an edit in a text editor.
 *
 * `base` is the fingerprint of the file version the document was edited from (`edit-base.ts`). The host refuses
 * the write, with `conflict: true`, when the file on disk is no longer that version, so a drawer that was opened
 * before an edit on disk cannot roll that edit back.
 */
import { vscodeBridge } from './vscode-bridge'
import type { CostsSaveResult } from './bridge-types'

export type { CostsSaveResult }

export async function saveCostsConfig(layer: 'user' | 'project', doc: unknown, base: string): Promise<CostsSaveResult> {
  try {
    if (vscodeBridge?.isVSCode) return await vscodeBridge.writeCostsConfig(layer, doc, base)
    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const origin = relayPort ? `http://127.0.0.1:${relayPort}` : ''
    const res = await fetch(`${origin}/costs-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer, doc, base }),
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; conflict?: boolean; fingerprint?: string } | null
    if (res.ok && body?.ok === true) return { ok: true, ...(typeof body.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}) }
    return { ok: false, error: body?.error ?? `the server answered ${res.status}`, ...(res.status === 409 || body?.conflict === true ? { conflict: true } : {}) }
  } catch {
    return { ok: false, error: 'could not reach the server' }
  }
}
