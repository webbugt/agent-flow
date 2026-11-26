import { useRef, useState, useEffect, useCallback } from 'react'
import { getOptions, updateOptions } from '@/lib/options-store'
import { useOptions } from '@/hooks/use-options'
import { AudioEngine } from '@/lib/audio-engine'
import type { Agent, ToolCallNode } from '@/lib/agent-types'
import { detectStateChanges } from '@/components/agent-visualizer/canvas/detect-state-changes'

export function useAudioEffects(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  isReviewing: boolean,
) {
  const audioRef = useRef<AudioEngine | null>(null)
  const [isMuted, setIsMuted] = useState(true)
  const seekingRef = useRef(false)
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())

  // The sound preference lives in the options registry (`soundOn`), shared with the options panel.
  const soundOn = useOptions().soundOn

  // Audio engine lifecycle
  useEffect(() => {
    const engine = new AudioEngine()
    audioRef.current = engine
    return () => { audioRef.current?.dispose(); audioRef.current = null }
  }, [])

  // Follow the preference: the stored value after load, a change in the options panel or in another tab.
  useEffect(() => {
    audioRef.current?.setMuted(!soundOn)
    setIsMuted(!soundOn)
  }, [soundOn])

  // Detect tool/agent state transitions and play sounds (live mode only)
  useEffect(() => {
    if (seekingRef.current || !audioRef.current || isReviewing) return
    const audio = audioRef.current

    const { transitions, newAgentStates, newToolStates } = detectStateChanges(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates

    for (const t of transitions) {
      switch (t.kind) {
        case 'agent_spawn':   audio.playAgentSpawn(); break
        case 'agent_complete': audio.playAgentComplete(); break
        case 'tool_start':    audio.playToolStart(); break
        case 'tool_complete': audio.playToolEnd(); break
        case 'tool_error':    audio.playError(); break
      }
    }
  }, [agents, toolCalls, isReviewing])

  const handleToggleMute = useCallback(() => {
    // Unmute right here (inside the click) so the browser accepts the audio context; the options store then
    // keeps it and the effect above confirms it.
    const nowOn = !getOptions().soundOn
    audioRef.current?.setMuted(!nowOn)
    setIsMuted(!nowOn)
    updateOptions({ soundOn: nowOn })
  }, [])

  return { isMuted, seekingRef, handleToggleMute }
}
