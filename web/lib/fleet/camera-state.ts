/**
 * Camera state machine of the map views, pure so it can be tested without a canvas.
 *
 *   intro    the camera is animating to a fit (first load, real layout change)
 *   settled  the fit was reached; the view still follows the fit until the user takes over
 *   user     the user zoomed, panned or interrupted the intro; only an explicit fit gives the view back
 *
 * Any user input that navigates (wheel, pinch, drag, zoom button) takes control at once. A plain press
 * (pointer down, tap, click on a node) takes control only while the intro is running: when the camera
 * is settled a click on a node must not turn auto-fit off. After an interrupt the intro never re-runs
 * by itself (`layout-fit` is ignored in `user`); only an explicit fit starts it again.
 */

export type CameraMode = 'intro' | 'settled' | 'user'

export interface CameraState {
  mode: CameraMode
  /** True once the user took control; mirrors "auto-fit is off". */
  userNavigated: boolean
}

/** Navigation inputs always take control; `press` (pointer down / click / tap) only interrupts a running intro. */
export type CameraInputKind = 'wheel' | 'pinch' | 'drag' | 'zoom-button' | 'press'

export type CameraEvent =
  /** Automatic fit: first load or a real layout change (see `shouldRefit`). */
  | { type: 'layout-fit' }
  /** The camera reached its target. */
  | { type: 'arrived' }
  | { type: 'input'; kind: CameraInputKind }
  /** Fit button or double click. During the intro it ends the animation at the destination. */
  | { type: 'explicit-fit' }
  /** Back to automatic fitting without animating (e.g. the selection changed in the session view). */
  | { type: 'reset' }

/** What the camera has to do about its running animation. */
export type CameraAction =
  | 'none'
  /** Drop the animation target and the pan inertia; the transform stays where it is. */
  | 'stop'
  /** Jump to the fit target now. */
  | 'snap'
  /** Start (or restart) animating to the fit. */
  | 'animate'

export const INITIAL_CAMERA_STATE: CameraState = { mode: 'settled', userNavigated: false }

export function transition(state: CameraState, event: CameraEvent): { state: CameraState; action: CameraAction } {
  switch (event.type) {
    case 'layout-fit':
      if (state.userNavigated) return { state, action: 'none' }
      return { state: { mode: 'intro', userNavigated: false }, action: 'animate' }
    case 'arrived':
      if (state.mode !== 'intro') return { state, action: 'none' }
      return { state: { mode: 'settled', userNavigated: state.userNavigated }, action: 'none' }
    case 'input': {
      if (event.kind === 'press' && state.mode !== 'intro') return { state, action: 'none' }
      return { state: { mode: 'user', userNavigated: true }, action: 'stop' }
    }
    case 'explicit-fit':
      if (state.mode === 'intro') return { state: { mode: 'settled', userNavigated: false }, action: 'snap' }
      return { state: { mode: 'intro', userNavigated: false }, action: 'animate' }
    case 'reset':
      return { state: { mode: 'settled', userNavigated: false }, action: 'none' }
  }
}
