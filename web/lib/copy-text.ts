/**
 * Copy text to the clipboard. The async Clipboard API only exists in a secure
 * context (https or localhost), and the app is also opened over plain http on
 * a tailnet address, so fall back to a hidden textarea and execCommand there.
 * Returns whether the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // permission denied or document not focused: try the textarea route below
    }
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  const active = document.activeElement as HTMLElement | null
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(area)
  active?.focus?.()
  return ok
}
