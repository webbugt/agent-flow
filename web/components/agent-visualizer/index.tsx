"use client"

import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { AgentVisualizerView } from "./visualizer-view"

/** The live visualiser: sessions and events from the relay (SSE) or the VS Code extension. The /demo route has its own entry (demo-visualizer.tsx). */
export function AgentVisualizer() {
  const bridge = useVSCodeBridge()
  return <AgentVisualizerView bridge={bridge} />
}
