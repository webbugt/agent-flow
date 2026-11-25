'use client'

import { Z } from '@/lib/agent-types'
import { useViewportWidth } from '@/hooks/use-viewport-width'
import { COLORS } from '@/lib/colors'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { describeIssue } from '@/lib/costs/layers'
import { dismissCostsErrors, type CostsStatus } from '@/lib/costs-runtime'

const MAX_LINES = 3

/** Which price set is in use while the config has errors, in one sentence. */
export function fallbackSentence(r: CostsStatus['resolution']): string {
  if (r.usingLastGood) return 'Showing prices from the last good config.'
  if (r.config) return 'Showing prices from the valid parts of the config.'
  return 'Showing the built-in prices.'
}

/**
 * Error banner for the costs config: shown while any layer (file, VS Code settings, or the merge of them) fails
 * validation. The overlay keeps pricing with the last good config, so the numbers stay usable; this says why a
 * saved edit did not take effect and where the problem is. Dismiss hides it until the errors change.
 */
export function CostsConfigBanner({ status }: { status: CostsStatus }) {
  const { resolution, dismissed } = status
  const narrow = useViewportWidth(1280) < 640 // the top bar wraps to two rows on a phone
  if (resolution.errors.length === 0 || dismissed) return null
  const lines = resolution.errors.slice(0, MAX_LINES).map(describeIssue)
  const more = resolution.errors.length - lines.length
  const canOpen = vscodeBridge?.isVSCode === true
  return (
    <div
      role="alert"
      data-testid="costs-config-banner"
      className="absolute left-1/2 -translate-x-1/2 font-mono text-[11px] rounded"
      style={{
        top: `calc(${narrow ? '4.6rem' : '3.25rem'} + env(safe-area-inset-top, 0px))`, width: 'min(640px, calc(100vw - 24px))', zIndex: Z.info + 1,
        background: 'rgba(40, 10, 18, 0.92)', border: `1px solid ${COLORS.error}99`, color: '#ffd0d6',
        boxShadow: `0 0 18px ${COLORS.error}33`, padding: '8px 10px', backdropFilter: 'blur(8px)',
      }}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden style={{ color: COLORS.error, fontWeight: 700 }}>!</span>
        <div className="min-w-0 flex-1">
          <div style={{ color: COLORS.error, fontWeight: 700 }}>
            Costs config has {resolution.errors.length === 1 ? 'an error' : `${resolution.errors.length} errors`}
          </div>
          <ul className="mt-1 space-y-0.5" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {lines.map((l, i) => <li key={i} className="break-words">{l}</li>)}
            {more > 0 && <li style={{ opacity: 0.7 }}>and {more} more</li>}
          </ul>
          <div className="mt-1" style={{ opacity: 0.75 }}>{fallbackSentence(resolution)}</div>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          {canOpen && (
            <button type="button" onClick={() => vscodeBridge?.openCostsConfig()} className="underline" style={{ color: '#ffd0d6' }}>
              Open file
            </button>
          )}
          <button type="button" onClick={dismissCostsErrors} aria-label="Dismiss costs config errors" className="underline" style={{ color: '#ffd0d6' }}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
