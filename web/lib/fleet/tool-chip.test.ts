import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CHIP_VERB_MAX, toolChip } from './tool-chip'
import { drawToolCalls } from '@/components/agent-visualizer/canvas/draw-tool-calls'
import type { ToolCallNode } from '@/lib/agent-types'

test('known tools get a short verb and an icon (Claude, Codex and Hermes names)', () => {
  const verbs: Array<[string, string]> = [
    ['Read', 'Read'], ['read_file', 'Read'],
    ['Edit', 'Edit'], ['MultiEdit', 'Edit'], ['patch', 'Edit'], ['apply_patch', 'Edit'],
    ['Write', 'Write'], ['write_file', 'Write'],
    ['Bash', 'Bash'], ['terminal', 'Bash'], ['execute_code', 'Bash'], ['exec_command', 'Bash'],
    ['Grep', 'Search'], ['Glob', 'Search'], ['search_files', 'Search'],
    ['WebSearch', 'Web search'], ['web_search', 'Web search'], ['WebFetch', 'Fetch'], ['web_extract', 'Fetch'],
    ['Task', 'Delegate'], ['delegate_task', 'Delegate'],
    ['TodoWrite', 'Plan'], ['todo_list', 'Plan'],
    ['browser_exec', 'Browser'], ['browser_snapshot', 'Browser'],
    ['kanban_show', 'Kanban'], ['kanban_complete', 'Kanban'],
  ]
  for (const [tool, verb] of verbs) assert.equal(toolChip(tool).verb, verb, tool)
})

test('memory tools: writes and reads are told apart', () => {
  for (const t of ['memory', 'supermemory_store', 'supermemory-save', 'supermemory_forget', 'omh_memory']) {
    assert.deepEqual(toolChip(t), { verb: 'Memory write', icon: 'memory' }, t)
  }
  for (const t of ['supermemory_search', 'supermemory-search', 'supermemory_profile', 'supermemory-profile']) {
    assert.deepEqual(toolChip(t), { verb: 'Memory read', icon: 'memory' }, t)
  }
})

test('unknown and MCP tools get a short humanized verb, never the raw long name', () => {
  assert.equal(toolChip('mcp__github__create_issue').verb, 'Create issue')
  assert.equal(toolChip('SomethingNew').verb, 'Something new')
  assert.equal(toolChip('').verb, 'Tool')
  const long = toolChip('a_really_quite_long_tool_name_that_goes_on_and_on')
  assert.ok(long.verb.length <= CHIP_VERB_MAX, long.verb)
  assert.equal(long.icon, 'generic')
})

// ─── Rendering: the chip vs the verbose card ───────────────────────────────────

/** A recording 2D context: no DOM needed, it only remembers the text that was drawn. */
function recordingCtx() {
  const texts: string[] = []
  const rects: number[][] = []
  const state: Record<string, unknown> = {}
  const ctx: unknown = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'fillText') return (text: string) => { texts.push(text) }
      if (prop === 'roundRect') return (...a: number[]) => { rects.push(a) }
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 5 })
      if (prop === 'getTransform') return () => ({ a: 1 })
      if (prop in state) return state[prop]
      return () => undefined
    },
    set(_t, prop: string, value) { state[prop] = value; return true },
  })
  return { ctx: ctx as CanvasRenderingContext2D, texts, rects }
}

const LONG_OUTPUT = 'for f in $(find / -name "*.log"); do echo "$f"; cat "$f" | grep -i error | sort | uniq -c | sort -rn | head -50; done'
function bashFixture(): Map<string, ToolCallNode> {
  const tool: ToolCallNode = {
    id: 't1', agentId: 'a1', toolName: 'Bash', state: 'complete', args: LONG_OUTPUT,
    result: 'x'.repeat(5000), tokenCost: 1234, x: 0, y: 0, startTime: 0, opacity: 1,
  }
  return new Map([[tool.id, tool]])
}

test('screensaver: a Bash call with a long command and output is ONE short chip', () => {
  const { ctx, texts } = recordingCtx()
  drawToolCalls(ctx, bashFixture(), 0, null, 0, true)
  assert.deepEqual(texts, ['Bash'])
})

test('screensaver: a failed call is still one short chip', () => {
  const { ctx, texts } = recordingCtx()
  const tools = bashFixture()
  const t = tools.get('t1') as ToolCallNode
  tools.set('t1', { ...t, state: 'error', errorMessage: 'e'.repeat(2000) })
  drawToolCalls(ctx, tools, 0, null, 0, true)
  assert.deepEqual(texts, ['Bash'])
})

test('screensaver: a chip fits its verb, not the command (small footprint)', () => {
  const { ctx, rects } = recordingCtx()
  drawToolCalls(ctx, bashFixture(), 0, null, 0, true)
  assert.equal(rects.length, 1)
  assert.ok(rects[0][2] < 70, `chip is ${rects[0][2]} wide`)
  const verbose = recordingCtx()
  drawToolCalls(verbose.ctx, bashFixture(), 0, null, 0)
  assert.ok(verbose.rects[0][2] > rects[0][2], 'the verbose card is wider')
})

test('normal view is unchanged: the verbose card still shows the command and token cost', () => {
  const { ctx, texts } = recordingCtx()
  drawToolCalls(ctx, bashFixture(), 0, null, 0)
  assert.equal(texts.length, 2)
  assert.ok(texts[0].startsWith('Bash: for f in'), texts[0])
  assert.equal(texts[1], '1234 tok')
  const again = recordingCtx()
  drawToolCalls(again.ctx, bashFixture(), 0, null, 0, false)
  assert.deepEqual(again.texts, texts, 'chips=false is the same as the old call')
})

test('screensaver chip keeps its icon but drops the verb when the text would be illegible (zoomed-out fleet map)', () => {
  const { ctx, texts } = recordingCtx()
  // zoom is read from ctx.getTransform().a / dpr; the stub gives 1, so ask for a minimum text size that 9 px at zoom 1 cannot meet
  drawToolCalls(ctx, bashFixture(), 0, null, 40, true)
  assert.deepEqual(texts, [])
})
