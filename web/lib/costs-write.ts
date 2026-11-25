/**
 * Save the costs document from the settings drawer. One entry point for both hosts:
 *  - VS Code webview: a message to the extension host (`write-costs-config`), which writes the file.
 *  - standalone page: `POST /costs-config` on the app server (same origin) or the relay (dev, NEXT_PUBLIC_RELAY_PORT).
 * Either way the host writes the file; the page learns the new config from the normal `costs-config` message
 * (file watcher), so the overlay changes exactly as it would after an edit in a text editor.
 */
import { vscodeBridge } from './vscode-bridge'

export type CostsSaveResult = { ok: true } | { ok: false; error: string }

export async function saveCostsConfig(layer: 'user' | 'project', doc: unknown): Promise<CostsSaveResult> {
  try {
    if (vscodeBridge?.isVSCode) return await vscodeBridge.writeCostsConfig(layer, doc)
    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const base = relayPort ? `http://127.0.0.1:${relayPort}` : ''
    const res = await fetch(`${base}/costs-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer, doc }),
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (res.ok && body?.ok === true) return { ok: true }
    return { ok: false, error: body?.error ?? `the server answered ${res.status}` }
  } catch {
    return { ok: false, error: 'could not reach the server' }
  }
}
