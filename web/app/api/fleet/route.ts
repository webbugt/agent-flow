import { NextResponse } from 'next/server'
import { readKanbanFleet } from '@/lib/fleet/kanban-source'
import { readSupermemoryFleet } from '@/lib/fleet/supermemory-source'

// Both readers open their SQLite files read-only and never return task
// bodies, results, payloads or memory content.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET() {
  try {
    const kanban = readKanbanFleet({ eventLimit: 200 })
    const supermemory = readSupermemoryFleet()
    return NextResponse.json({ readAt: Date.now(), kanban: kanban.nodes, supermemory: supermemory.nodes })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'fleet read failed' }, { status: 500 })
  }
}
