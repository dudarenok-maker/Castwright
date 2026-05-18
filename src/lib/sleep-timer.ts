/* Sleep-timer state machine — plan 53.
 *
 * Pure JS state machine driving the mini-player's optional "stop
 * after N minutes" or "stop at the end of the current chapter"
 * affordance. NO React dependencies — the component owns its own
 * useRef/useEffect glue (so the timer survives chapter-switch
 * re-renders) and just polls/feeds events into this machine.
 *
 * Two flavours:
 *
 *   - **countdown**: timer fires after `durationMs` of wall-clock
 *     time. The component pauses playback (and the existing plan
 *     47 onTimeUpdate flush handles the listen-progress save on
 *     the next pause-driven render).
 *
 *   - **end-of-chapter**: timer fires when the audio element emits
 *     `ended`. No duration involved — the player just calls
 *     `notifyChapterEnded()` from its onEnded handler.
 *
 * The state is intentionally **per-session only**. Reload =
 * cleared timer. This matches every standalone audiobook player
 * (BookPlayer, Smart AudioBook Player, Voice) — persisting the
 * picked duration across reloads would surprise the user who
 * picked "30 min" last night and reopened the app a day later. */

export type SleepTimerMode = 'countdown' | 'end-of-chapter';

/** Pre-baked countdown durations exposed in the picker. Kept here
 *  (not in the component) so the test suite asserts against the
 *  canonical list without duplicating literals. */
export const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60] as const;
export type SleepTimerPresetMin = (typeof SLEEP_TIMER_PRESETS_MIN)[number];

export interface SleepTimerIdle {
  kind: 'idle';
}

export interface SleepTimerCountdown {
  kind: 'countdown';
  /** Wall-clock ms at which the timer fires. */
  firesAt: number;
  /** Original picker selection — surfaces in the UI label. */
  durationMs: number;
}

export interface SleepTimerEndOfChapter {
  kind: 'end-of-chapter';
}

export interface SleepTimerFired {
  kind: 'fired';
  /** Which mode produced the fire, for UI copy. */
  cause: SleepTimerMode;
}

export type SleepTimerState =
  | SleepTimerIdle
  | SleepTimerCountdown
  | SleepTimerEndOfChapter
  | SleepTimerFired;

/** Idle factory — exported so tests + components share one literal. */
export const IDLE: SleepTimerIdle = { kind: 'idle' };

/** Start a fresh countdown that fires after `durationMs` of
 *  wall-clock time. `now` parameter is a seam for tests; production
 *  callers pass `Date.now()`. */
export function startCountdown(durationMs: number, now: number = Date.now()): SleepTimerCountdown {
  return { kind: 'countdown', firesAt: now + durationMs, durationMs };
}

/** Start an end-of-chapter timer. Fires the next time the audio
 *  element emits `ended`. */
export function startEndOfChapter(): SleepTimerEndOfChapter {
  return { kind: 'end-of-chapter' };
}

/** Cancel any active timer back to idle. Idempotent on the idle /
 *  fired states. */
export function cancel(): SleepTimerIdle {
  return IDLE;
}

/** Tick the countdown forward. Returns the same state unless the
 *  wall-clock has crossed `firesAt`, in which case we transition to
 *  `fired`. Caller is responsible for invoking this from a
 *  setInterval / requestAnimationFrame / audio onTimeUpdate seam —
 *  the machine itself owns no timers. */
export function tick(state: SleepTimerState, now: number = Date.now()): SleepTimerState {
  if (state.kind !== 'countdown') return state;
  if (now >= state.firesAt) return { kind: 'fired', cause: 'countdown' };
  return state;
}

/** Tell the machine the audio element just emitted `ended`. Only
 *  the end-of-chapter mode reacts to this — countdown is wall-clock
 *  driven, idle/fired are no-ops. */
export function notifyChapterEnded(state: SleepTimerState): SleepTimerState {
  if (state.kind === 'end-of-chapter') return { kind: 'fired', cause: 'end-of-chapter' };
  return state;
}

/** Convenience for the UI: how many ms remain before the countdown
 *  fires. Returns null for non-countdown states. Negative values
 *  clamp to 0 (the countdown should already have ticked into
 *  `fired` by that point, but the floor keeps the UI honest if a
 *  tick was missed). */
export function remainingMs(state: SleepTimerState, now: number = Date.now()): number | null {
  if (state.kind !== 'countdown') return null;
  return Math.max(0, state.firesAt - now);
}

/** Predicate — is the player supposed to pause RIGHT NOW because
 *  the timer fired? Caller flips this back to idle after acting on
 *  the fire so we don't pause every render. */
export function isFired(state: SleepTimerState): state is SleepTimerFired {
  return state.kind === 'fired';
}
