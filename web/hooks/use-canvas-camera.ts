import { useRef, useEffect, useCallback, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM, NODE } from '@/lib/agent-types'
import { SHOT_MODE } from '@/lib/shot-mode'
import { cloudGeometries, type CloudView } from '@/lib/fleet/fleet-cloud-geometry'
import { zoomAt } from '@/lib/fleet/fleet-camera'
import { fitToNodes, pickFitAgents, screensaverCameraPlan, screensaverCameraStep, type ScreensaverCameraPlan } from '@/lib/fleet/screensaver-fit'
import { INITIAL_CAMERA_STATE, transition, type CameraAction, type CameraEvent, type CameraInputKind, type CameraState } from '@/lib/fleet/camera-state'
import { CAMERA } from '@/lib/canvas-constants'
import { BUBBLE_HOLD, BUBBLE_FADE_OUT, BUBBLE_MAX_W, TOOL_CARD_W, TOOL_CARD_H, DISC_BOUNDS_HALF_W, DISC_BOUNDS_HALF_H } from '@/lib/canvas-constants'

/** Extra padding added to agent node radii for auto-fit bounding box */
const AUTOFIT_AGENT_PADDING = 22

/** Room under a cloud halo for its caption, world units (fleet map). */
const AUTOFIT_CLOUD_CAPTION = 48

/** Screensaver fit: screen margin kept free around the active nodes, px. */
const SCREENSAVER_FIT_MARGIN_PX = 80
/** Screensaver fit: room under a node for its label, world units. */
const SCREENSAVER_FIT_LABEL_ROOM = 44
/** Screensaver fit: zoom-out floor. Lower than the user's (CAMERA.minZoom): keeping every drawn node in sight comes first. */
const SCREENSAVER_FIT_MIN_SCALE = 0.05
/** Screensaver fit: a lone drawn node is not zoomed beyond this. */
const SCREENSAVER_FIT_MAX_SCALE = 2

export interface Transform {
  x: number
  y: number
  scale: number
}

interface CameraOptions {
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
    /** Fleet map only: agent clouds; the fit keeps every halo and its caption in view. */
    clouds?: CloudView[]
    /** Fleet map: ids of nodes that are leaving (drawn, but not worth keeping in view). */
    ghosts?: ReadonlySet<string>
    dimensions: { width: number; height: number }
    selectedAgentId: string | null
    pauseAutoFit?: boolean
    isDragging: boolean
  }>
  simTimeRef: MutableRefObject<number>
  dimensions: { width: number; height: number }
  agentCount: number
  zoomToFitTrigger?: number
  selectedAgentId: string | null
  /**
   * Fleet map: selecting a node neither focuses the camera on it nor re-engages auto-fit,
   * so a click never undoes the user's zoom or pan.
   */
  fleetView?: boolean
  /**
   * Fleet map in screensaver mode: the view is the auto-view. It keeps every DRAWN node in sight (see
   * lib/fleet/screensaver-fit.ts) and the user's own zoom or pan does not switch it off.
   */
  screensaver?: boolean
  /**
   * The `screensaverAutoFit` option. Off: the screensaver does not zoom by itself and the camera stays where the
   * user left it (zoom and pan work as before). Default true.
   */
  screensaverAutoFit?: boolean
}

export function useCanvasCamera({
  mainCanvasRef,
  drawPropsRef,
  simTimeRef,
  dimensions,
  agentCount,
  zoomToFitTrigger,
  selectedAgentId,
  fleetView = false,
  screensaver = false,
  screensaverAutoFit = true,
}: CameraOptions) {
  const activeFit = fleetView && screensaver && screensaverAutoFit
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 })
  const userHasNavigatedRef = useRef(false)
  // Camera state machine (intro -> interrupted -> user control); userHasNavigatedRef mirrors its flag.
  const cameraStateRef = useRef<CameraState>(INITIAL_CAMERA_STATE)
  const targetTransformRef = useRef<Transform | null>(null)
  const panVelocityRef = useRef({ vx: 0, vy: 0, active: false })

  // Cache for computeFitTransform — avoids O(n) iteration every frame.
  // Invalidates on collection reference change (React creates new Map/array on state updates).
  const fitCacheRef = useRef<{
    agents: Map<string, Agent> | null
    toolCalls: Map<string, ToolCallNode> | null
    discoveries: Discovery[] | null
    selectedAgentId: string | null
    result: Transform | null
  }>({ agents: null, toolCalls: null, discoveries: null, selectedAgentId: null, result: null })

  // Initialize transform centered on first agents
  useEffect(() => {
    if (agentCount > 0 && transformRef.current.x === 0 && transformRef.current.y === 0) {
      transformRef.current = { x: dimensions.width / 2, y: dimensions.height / 2, scale: 1 }
    }
  }, [agentCount, dimensions])

  // Collect an agent and all its descendants (BFS)
  const getDescendantIds = useCallback((agents: Map<string, Agent>, rootId: string): Set<string> => {
    const ids = new Set<string>([rootId])
    const queue = [rootId]
    while (queue.length > 0) {
      const parentId = queue.shift()!
      for (const [id, agent] of agents) {
        if (agent.parentId === parentId && !ids.has(id)) {
          ids.add(id)
          queue.push(id)
        }
      }
    }
    return ids
  }, [])

  const computeFitTransform = useCallback((): Transform | null => {
    const { agents, toolCalls, discoveries, clouds, dimensions, selectedAgentId } = drawPropsRef.current
    if (agents.size === 0) return null

    // Screensaver (fleet map): every drawn node, node radius and a screen margin included. Not cached
    // (the cache below is for the normal fit): it is cheap, and the nodes move a little every frame.
    if (activeFit) {
      const nodes = pickFitAgents(agents.values(), drawPropsRef.current.ghosts).map(a => ({
        x: a.x, y: a.y, r: (a.isMain ? NODE.radiusMain : NODE.radiusSub) + AUTOFIT_AGENT_PADDING,
      }))
      return fitToNodes(nodes, dimensions, {
        marginPx: SCREENSAVER_FIT_MARGIN_PX, labelRoom: SCREENSAVER_FIT_LABEL_ROOM,
        minScale: SCREENSAVER_FIT_MIN_SCALE, maxScale: SCREENSAVER_FIT_MAX_SCALE,
      })
    }

    // Return cached result if inputs haven't changed (reference equality —
    // React creates new Map/array objects on state updates, so same ref = same data)
    const cache = fitCacheRef.current
    if (cache.agents === agents
      && cache.toolCalls === toolCalls
      && cache.discoveries === discoveries
      && cache.selectedAgentId === selectedAgentId) {
      return cache.result
    }

    // Determine focus scope: if a non-main agent is selected, focus on it + descendants
    let focusScope: Set<string> | null = null
    if (selectedAgentId && !fleetView) {
      const selected = agents.get(selectedAgentId)
      if (selected && !selected.isMain) {
        focusScope = getDescendantIds(agents, selectedAgentId)
      }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [id, agent] of agents) {
      if (focusScope && !focusScope.has(id)) continue
      const r = (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AUTOFIT_AGENT_PADDING
      minX = Math.min(minX, agent.x - r)
      maxX = Math.max(maxX, agent.x + r)
      minY = Math.min(minY, agent.y - r)
      maxY = Math.max(maxY, agent.y + r)
      if (agent.messageBubbles.length > 0) {
        const visibleCount = agent.messageBubbles.filter(b => {
          const age = (simTimeRef.current ?? 0) - b.time
          return age <= BUBBLE_HOLD + BUBBLE_FADE_OUT
        }).length
        if (visibleCount > 0) {
          maxX = Math.max(maxX, agent.x + r + 14 + BUBBLE_MAX_W * 0.4)
          minX = Math.min(minX, agent.x - r - BUBBLE_MAX_W * 0.2)
          const stackH = visibleCount * 46
          minY = Math.min(minY, agent.y - 20)
          maxY = Math.max(maxY, agent.y - 20 + stackH)
        }
      }
    }
    for (const [, tool] of toolCalls) {
      if (tool.opacity > 0.1 && (!focusScope || focusScope.has(tool.agentId))) {
        const halfW = TOOL_CARD_W / 2
        const halfH = TOOL_CARD_H / 2
        minX = Math.min(minX, tool.x - halfW)
        maxX = Math.max(maxX, tool.x + halfW)
        minY = Math.min(minY, tool.y - halfH)
        maxY = Math.max(maxY, tool.y + halfH)
      }
    }
    for (const disc of discoveries) {
      if (disc.opacity > 0.1 && (!focusScope || focusScope.has(disc.agentId))) {
        minX = Math.min(minX, disc.x - DISC_BOUNDS_HALF_W)
        maxX = Math.max(maxX, disc.x + DISC_BOUNDS_HALF_W)
        minY = Math.min(minY, disc.y - DISC_BOUNDS_HALF_H)
        maxY = Math.max(maxY, disc.y + DISC_BOUNDS_HALF_H)
      }
    }
    if (!focusScope && clouds && clouds.length > 0) {
      for (const g of cloudGeometries(clouds, agents).values()) {
        minX = Math.min(minX, g.x - g.r)
        maxX = Math.max(maxX, g.x + g.r)
        minY = Math.min(minY, g.y - g.r)
        maxY = Math.max(maxY, g.y + g.r + AUTOFIT_CLOUD_CAPTION)
      }
    }
    if (minX === Infinity) {
      fitCacheRef.current = { agents, toolCalls, discoveries, selectedAgentId, result: null }
      return null
    }
    const padding = ANIM.viewportPadding
    const boundsW = maxX - minX + padding * 2
    const boundsH = maxY - minY + padding * 2
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const scale = Math.min(dimensions.width / boundsW, dimensions.height / boundsH, 2)
    const result = {
      x: dimensions.width / 2 - centerX * scale,
      y: dimensions.height / 2 - centerY * scale,
      scale,
    }
    fitCacheRef.current = { agents, toolCalls, discoveries, selectedAgentId, result }
    return result
  }, [getDescendantIds, drawPropsRef, simTimeRef, fleetView, activeFit])

  /** Run a camera event through the state machine and carry out the animation action it asks for. */
  const dispatch = useCallback((event: CameraEvent): CameraAction => {
    const { state, action } = transition(cameraStateRef.current, event)
    cameraStateRef.current = state
    userHasNavigatedRef.current = state.userNavigated
    if (action === 'stop') {
      targetTransformRef.current = null
    } else if (action === 'snap') {
      const fit = computeFitTransform()
      targetTransformRef.current = null
      if (fit) transformRef.current = fit
    } else if (action === 'animate') {
      const fit = computeFitTransform()
      if (fit) targetTransformRef.current = fit
    }
    return action
  }, [computeFitTransform])

  /** User input reached the canvas: the intro stops at once (the next frame already has no target). */
  const interrupt = useCallback((kind: CameraInputKind) => { dispatch({ type: 'input', kind }) }, [dispatch])

  /** Explicit fit (fit button, double click): during the intro it ends the animation at the destination. */
  const doZoomToFit = useCallback(() => { dispatch({ type: 'explicit-fit' }) }, [dispatch])

  // Automatic fit (first load, real layout change). The fleet map decides when (shouldRefit) and the
  // state machine ignores it after an interrupt; the session view's trigger is an explicit button.
  useEffect(() => {
    if (!zoomToFitTrigger || zoomToFitTrigger <= 0) return
    if (!fleetView) dispatch({ type: 'reset' })
    dispatch({ type: 'layout-fit' })
  }, [zoomToFitTrigger, dispatch, fleetView])

  // Entering or leaving the screensaver, or switching the auto-fit option while it runs (screensaverCameraStep):
  //  fit      the user's navigation is dropped (the screensaver is the auto-view) and the fit starts at once;
  //  freeze   the option was switched off: the camera stops where it is, nothing zooms by itself from now on;
  //  release  leaving a screensaver that fitted: back to the normal fit;
  //  none     option off: the screensaver leaves the camera alone (zoom and pan work as before).
  const planRef = useRef<ScreensaverCameraPlan | null>(null)
  useEffect(() => {
    const plan = screensaverCameraPlan(fleetView, screensaver, screensaverAutoFit)
    const step = screensaverCameraStep(planRef.current, plan)
    planRef.current = plan
    if (step === 'none') return
    if (step === 'freeze') { dispatch({ type: 'input', kind: 'drag' }); return }
    dispatch({ type: 'reset' })
    if (step === 'fit') dispatch({ type: 'layout-fit' })
  }, [screensaver, screensaverAutoFit, fleetView, dispatch])

  // Re-engage auto-fit when selection changes (not in the fleet map: a click keeps the user's view)
  useEffect(() => {
    if (fleetView) return
    dispatch({ type: 'reset' })
    targetTransformRef.current = null
  }, [selectedAgentId, fleetView, dispatch])

  /** Zoom by `factor` around the centre of the canvas (on-screen buttons). Counts as user navigation. */
  const zoomBy = useCallback((factor: number) => {
    dispatch({ type: 'input', kind: 'zoom-button' })
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    const { width, height } = drawPropsRef.current.dimensions
    transformRef.current = zoomAt(transformRef.current, width / 2, height / 2, factor, { min: CAMERA.minZoom, max: CAMERA.maxZoom })
  }, [drawPropsRef, dispatch])

  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const canvas = mainCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (screenX - rect.left - t.x) / t.scale,
      y: (screenY - rect.top - t.y) / t.scale,
    }
  }, [mainCanvasRef])

  /** Call from draw loop to update inertia and auto-fit lerp */
  const updateCamera = useCallback((isDragging: boolean, pauseAutoFit?: boolean) => {
    const transform = transformRef.current

    // Pan inertia
    const inertia = panVelocityRef.current
    if (inertia.active) {
      transformRef.current = { ...transform, x: transform.x + inertia.vx, y: transform.y + inertia.vy }
      inertia.vx *= ANIM.inertiaDecay
      inertia.vy *= ANIM.inertiaDecay
      if (Math.abs(inertia.vx) < 0.1 && Math.abs(inertia.vy) < 0.1) {
        inertia.active = false
      }
    }

    // Auto-fit (the screensaver keeps fitting whatever the user zoomed or panned)
    if ((activeFit || !userHasNavigatedRef.current) && !isDragging && !pauseAutoFit) {
      const fit = computeFitTransform()
      if (fit) targetTransformRef.current = fit
    }

    // Smooth lerp toward target
    const target = targetTransformRef.current
    if (target) {
      // ?shot=1 (screenshot harness): snap to the fit instead of easing, so a frozen page is stable at once
      const lerpSpeed = SHOT_MODE ? 1 : ANIM.autoFitLerp
      const t = transformRef.current
      const nx = t.x + (target.x - t.x) * lerpSpeed
      const ny = t.y + (target.y - t.y) * lerpSpeed
      const ns = t.scale + (target.scale - t.scale) * lerpSpeed
      if (Math.abs(target.x - nx) < 0.5 && Math.abs(target.y - ny) < 0.5 && Math.abs(target.scale - ns) < 0.001) {
        targetTransformRef.current = null
        transformRef.current = { x: target.x, y: target.y, scale: target.scale }
        dispatch({ type: 'arrived' })
      } else {
        transformRef.current = { x: nx, y: ny, scale: ns }
      }
    }
  }, [computeFitTransform, dispatch, activeFit])

  return {
    transformRef,
    userHasNavigatedRef,
    cameraStateRef,
    interrupt,
    panVelocityRef,
    screenToCanvas,
    doZoomToFit,
    zoomBy,
    updateCamera,
  }
}
