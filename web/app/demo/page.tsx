import type { Metadata } from 'next'
import { DemoVisualizer } from '@/components/agent-visualizer/demo-visualizer'

export const metadata: Metadata = { title: 'Agent Flow demo' }

/** /demo: the visualiser on synthetic events and resources, with a control panel. Not connected to the relay. */
export default function DemoPage() {
  return <DemoVisualizer />
}
