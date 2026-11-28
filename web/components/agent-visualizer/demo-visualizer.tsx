"use client"

import { useState } from "react"
import { useDemoBridge } from "@/hooks/use-demo-bridge"
import { useViewportWidth } from "@/hooks/use-viewport-width"
import { demoPanelInset } from "@/lib/demo/demo-feed"
import { AgentVisualizerView } from "./visualizer-view"
import { DemoPanel } from "./demo-panel"

/**
 * The /demo route: the same canvas (single view and Fleet view) as the live app, fed by the synthetic event
 * source (`useDemoBridge`) instead of the relay, with a control panel to drive it. It does not call
 * `useVSCodeBridge`, so no EventSource is opened and no relay endpoint is read.
 */
export function DemoVisualizer() {
  const { bridge, demo } = useDemoBridge()
  const [panelOpen, setPanelOpen] = useState(true)
  const viewportWidth = useViewportWidth(1280)
  // The map and the Fleet controls keep clear of the open panel, as they do for the session detail panel.
  const feed = { ...demo.feed, rightInset: demoPanelInset(panelOpen, viewportWidth) }
  return (
    <>
      <AgentVisualizerView bridge={bridge} demo={feed} />
      <DemoPanel
        demo={demo} onSelectSession={bridge.selectSession} selectedSessionId={bridge.selectedSessionId}
        open={panelOpen} onOpenChange={setPanelOpen}
      />
    </>
  )
}
