import { handleFleetRequest } from '@/lib/fleet/fleet-api'
import { readKanbanFleet } from '@/lib/fleet/kanban-source'
import { readSupermemoryFleet } from '@/lib/fleet/supermemory-source'
import { ANONYMIZE_ENV, ANONYMIZE_OVERRIDES_ENV, createAnonymizePolicy, parseOverrides } from '@/lib/content-privacy'

// Both readers open their SQLite files read-only and never return task
// bodies, results, payloads or memory content.
// Access is loopback-only unless AGENT_FLOW_FLEET_ALLOW_REMOTE=1; errors are
// logged server-side and the client gets a generic message. See lib/fleet/fleet-api.ts.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Same setting as the relay (AGENT_FLOW_ANONYMIZE_CONTENT, per profile): task titles of an
// anonymized profile are hidden. Read per request so a changed environment applies on restart only.
export function GET(req: Request) {
  return handleFleetRequest(req, {
    anonymize: createAnonymizePolicy({
      value: process.env[ANONYMIZE_ENV],
      overrides: parseOverrides(process.env[ANONYMIZE_OVERRIDES_ENV]),
    }),
    readKanban: () => readKanbanFleet({ eventLimit: 200 }),
    readSupermemory: () => readSupermemoryFleet(),
  })
}
