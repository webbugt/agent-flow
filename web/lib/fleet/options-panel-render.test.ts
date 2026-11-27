import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OptionsPanel } from '@/components/agent-visualizer/options-panel'

// Server render: the first render sees the default options (getServerOptions), as in hydration.
const selection = { off: new Set<string>(), selectAll: () => {} } as never

test('options panel renders the screensaver toggle, labelled, checked by default (screensaverAutoFit default true)', () => {
  const html = renderToStaticMarkup(createElement(OptionsPanel, { selection, onClose: () => {} }))
  assert.match(html, /data-testid="options-screensaver-autofit"/)
  assert.match(html, /Screensaver: zoom to fit all nodes/)
  const input = html.match(/<input[^>]*data-testid="options-screensaver-autofit"[^>]*>/)![0]
  assert.match(input, /type="checkbox"/)
  assert.match(input, /checked/)
})
