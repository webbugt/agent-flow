import { handleFleetRequest } from '@/lib/fleet/fleet-api'
import { readKanbanFleet } from '@/lib/fleet/kanban-source'
import { readSupermemoryFleet } from '@/lib/fleet/supermemory-source'

// Both readers open their SQLite files read-only and never return task
// bodies, results, payloads or memory content.
// Access is loopback-only unless AGENT_FLOW_FLEET_ALLOW_REMOTE=1; errors are
// logged server-side and the client gets a generic message. See lib/fleet/fleet-api.ts.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(req: Request) {
  return handleFleetRequest(req, {
    readKanban: () => readKanbanFleet({ eventLimit: 200 }),
    readSupermemory: () => readSupermemoryFleet(),
  })
}
