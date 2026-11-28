// First import: with ?shot=1 it seeds Math.random and installs window.__AF_TEST__ (no-op otherwise)
import './lib/shot-mode'
import { createRoot } from 'react-dom/client'
import { AgentVisualizer } from './components/agent-visualizer'
import { DemoVisualizer } from './components/agent-visualizer/demo-visualizer'
import { isDemoPath } from './lib/demo/demo-route'
import './app/globals.css'

// Standalone CLI entry — no VS Code API, connects to relay via SSE
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
// /demo mounts the synthetic demo (no relay connection); every other path is the live app.
root.render(isDemoPath(window.location.pathname) ? <DemoVisualizer /> : <AgentVisualizer />)
