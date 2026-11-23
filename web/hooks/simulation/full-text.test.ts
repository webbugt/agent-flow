import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent } from '@/lib/agent-types'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage } from './handle-message-events'
import { handleSubagentDispatch, handleSubagentReturn } from './handle-subagent-events'
import { appendConversation, MAX_BUBBLES, MAX_CONVERSATION_MESSAGES, MAX_EVENT_LOG } from './types'
import type { MutableEventState, ProcessEventContext } from './process-event'

// Long text: far past the old 25 / 30 / 40 / 120 / 200 character label limits.
const LONG = Array.from({ length: 400 }, (_, i) => `sentence ${i} of a long Hermes message.`).join(' ')

function setup() {
  const agent = { name: 'orch', isMain: true, toolCalls: 0, tokensUsed: 0, messageBubbles: [], state: 'idle' } as unknown as Agent
  const state: MutableEventState = {
    agents: new Map([['orch', agent]]),
    toolCalls: new Map(), particles: [], edges: [], discoveries: [],
    fileAttention: new Map(),
    timelineEntries: new Map([['orch', { agentName: 'orch', blocks: [], models: [] } as never]]),
    conversations: new Map(),
  }
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000, blockIdCounter: { current: 0 }, skipForceSync: false,
  }
  return { state, ctx }
}

test('a long tool command and result reach the particles, timeline, conversation and node whole', () => {
  const { state, ctx } = setup()
  const command = 'echo ' + LONG
  handleToolCallStart({ agent: 'orch', tool: 'Bash', toolUseId: 't1', args: command, inputData: { command } }, 1, state, ctx)
  handleToolCallEnd({ agent: 'orch', tool: 'Bash', toolUseId: 't1', result: LONG }, 2, state, ctx)

  const tool = [...state.toolCalls.values()][0]
  assert.equal(tool.args, command)
  assert.equal((tool.inputData as { command: string }).command, command)
  assert.equal(tool.result, LONG)

  const labels = state.particles.map(p => p.label)
  assert.ok(labels.includes(`Bash ${command}`), 'outgoing particle label is the whole call')
  assert.ok(labels.includes(LONG), 'return particle label is the whole result')

  const timeline = state.timelineEntries.get('orch')!.blocks.find(b => b.type === 'tool_call')
  assert.equal(timeline?.label, `Bash: ${command}`)

  const convo = state.conversations.get('orch')!
  assert.equal(convo[0].content, `> Bash ${command}`)
  assert.equal(convo[1].content, `< ${LONG}`)
})

test('a long message keeps its whole text in the bubble, the conversation, the agent name and task', () => {
  const { state } = setup()
  handleMessage({ agent: 'orch', role: 'user', content: LONG }, 1, state)
  handleMessage({ agent: 'orch', role: 'thinking', content: LONG + ' thinking' }, 2, state)
  handleMessage({ agent: 'orch', role: 'assistant', content: LONG + ' answer' }, 3, state)

  const agent = state.agents.get('orch')!
  assert.deepEqual(agent.messageBubbles.map(b => b.text), [LONG, LONG + ' thinking', LONG + ' answer'])
  assert.equal(agent.task, LONG)
  assert.equal(agent.name, LONG)
  assert.deepEqual(state.conversations.get('orch')!.map(m => m.content), [LONG, LONG + ' thinking', LONG + ' answer'])
})

test('a long dispatched task and returned summary reach the particle labels whole', () => {
  const { state } = setup()
  handleSubagentDispatch({ parent: 'orch', child: 'worker', task: LONG }, 1, state)
  handleSubagentReturn({ parent: 'orch', child: 'worker', summary: LONG + ' done' }, 2, state)
  assert.deepEqual(state.particles.map(p => p.label), [LONG, LONG + ' done'])
})

test('the memory caps keep the newest items and are sized for a long live session', () => {
  assert.ok(MAX_BUBBLES >= 40 && MAX_CONVERSATION_MESSAGES >= 2000 && MAX_EVENT_LOG >= 20000)
  const conversations = new Map<string, import('./types').ConversationMessage[]>()
  for (let i = 0; i < MAX_CONVERSATION_MESSAGES + 10; i++) {
    appendConversation(conversations, 'a', { type: 'assistant', content: `m${i}`, timestamp: i })
  }
  const kept = conversations.get('a')!
  assert.equal(kept.length, MAX_CONVERSATION_MESSAGES)
  assert.equal(kept[0].content, 'm10')

  const { state } = setup()
  for (let i = 0; i < MAX_BUBBLES + 5; i++) handleMessage({ agent: 'orch', role: 'assistant', content: `b${i}` }, i, state)
  const bubbles = state.agents.get('orch')!.messageBubbles
  assert.equal(bubbles.length, MAX_BUBBLES)
  assert.equal(bubbles[bubbles.length - 1].text, `b${MAX_BUBBLES + 4}`)
})
