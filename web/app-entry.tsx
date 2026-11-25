// First import: with ?shot=1 it seeds Math.random and installs window.__AF_TEST__ (no-op otherwise)
import './lib/shot-mode'
import { createRoot } from 'react-dom/client'
import { AgentVisualizer } from './components/agent-visualizer'
import './app/globals.css'

// Standalone CLI entry — no VS Code API, connects to relay via SSE
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
root.render(<AgentVisualizer />)
