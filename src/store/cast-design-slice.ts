/* Cast-design slice — out-of-band snapshot of the in-flight "Design full cast"
   bulk job so a top-bar `DesignPill` (the third status pill, beside Analysis
   and Generation) can render live progress across navigation and a browser
   reload.

   The job itself is server-owned (an in-memory per-book job streaming SSE — see
   `server/src/routes/cast-design.ts`). This slice is the cross-book snapshot the
   pill reads; it survives navigation because it lives in Redux, and survives a
   browser reload because the layout cold-boot probe re-subscribes to the live
   server job (see `cast-design-stream-middleware.ts`). Mirrors the shape of
   `analysis.activeStream` in `analysis-slice.ts`.

   Deliberately NOT cross-tab broadcast (unlike the analysis/chapters snapshots):
   the design loop has a single owning tab — a second tab couldn't drive or tear
   it down (the middleware's re-entrancy guard is per-tab module state), so a
   mirrored pill would be worse UX than none. There is therefore no entry for
   `castDesign/*` in `broadcast-middleware.ts` — that omission is intentional.

   Reducers take `lastTickAt` in the payload (never `Date.now()` inside a reducer)
   so reducers stay pure and unit tests are deterministic — same idiom as
   `analysis-slice`. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Emotion } from '../lib/types';

/** A single character's design failure, surfaced in the terminal summary. */
export interface CastDesignFailure {
  characterId: string;
  name: string;
  error: string;
}

/** Preview payload for a re-design (mode: 'redesign') — staged, not yet
    persisted, awaiting A/B compare in the Profile Drawer. */
export interface CastDesignPreview {
  characterId: string;
  previewVoiceId: string;
  previewUrl: string;
  persona: string;
}

/** Snapshot of the in-flight bulk-design job for ONE book. Opened by the
    middleware on start (or on cold-boot re-subscribe); advanced per character;
    settled then cleared on completion. */
export interface CastDesignSnapshot {
  bookId: string;
  /** Distinguishes the bulk job from a single-character design. */
  kind: 'bulk' | 'single';
  /** Characters enqueued at job start — the denominator for the pill. */
  total: number;
  /** Characters designed + persisted this run (successes only). */
  done: number;
  /** Characters skipped because they already had a Qwen voice when their turn
      came (freshness-skip — never clobber a manual design). Folded into the
      percent so the bar still completes; surfaced separately in the summary. */
  skipped: number;
  /** Character currently being designed (pill subtitle "Designing <name>"). */
  currentName: string | null;
  /** Single-design only. */
  characterId?: string;
  mode?: 'first' | 'redesign';
  phase?: 'designing' | 'rendering';
  /** `running` is the happy path; `done` is the brief terminal-summary state
      before clear; `halted` is a catastrophic abort (rare — per-character
      failures never halt). `stalled` is a derived UI state computed inline in
      the layout from `lastTickAt`, not stored here.
      `ready-to-compare` is single-redesign-only: the preview is staged and the
      drawer must resolve it (approve→promote / cancel→discard). */
  state: 'running' | 'done' | 'halted' | 'ready-to-compare';
  /** ms since epoch of the most recent tick/heartbeat — drives the pill's
      stall heuristic (recomputed in the layout against `Date.now()`). */
  lastTickAt: number;
  /** Per-character failures; the loop continues past each one. */
  failures: CastDesignFailure[];
  /** Present iff state === 'ready-to-compare'. */
  preview?: CastDesignPreview;
}

export interface CastDesignState {
  active: CastDesignSnapshot | null;
}

const initialState: CastDesignState = {
  active: null,
};

/** fe-32 — design scope for the bulk job. */
export type CastDesignScope = 'bases' | 'variants' | 'both';

/** Payload for the request action the middleware intercepts (no-op reducer). */
export interface DesignAllRequestedPayload {
  bookId: string;
  characterIds: string[];
  modelKey: string;
  /** Default 'bases' keeps today's behaviour. */
  scope?: CastDesignScope;
  /** Demand-driven variant work-list (used for 'variants'/'both'). */
  variantTasks?: { characterId: string; emotions: Emotion[] }[];
}

export const castDesignSlice = createSlice({
  name: 'castDesign',
  initialState,
  reducers: {
    /* Open the snapshot. Overwrites verbatim — a fresh begin displaces any
       stale snapshot; re-entrancy is the middleware's job. `done`/`skipped`
       default to 0 for a fresh start, but the cold-boot re-subscribe seeds
       them from the server's `resume_from` event so the pill picks up a job
       already in progress at the right percentage. */
    begin(
      state,
      action: PayloadAction<{
        bookId: string;
        total: number;
        currentName: string | null;
        lastTickAt: number;
        done?: number;
        skipped?: number;
      }>,
    ) {
      state.active = {
        bookId: action.payload.bookId,
        kind: 'bulk',
        total: action.payload.total,
        done: action.payload.done ?? 0,
        skipped: action.payload.skipped ?? 0,
        currentName: action.payload.currentName,
        state: 'running',
        lastTickAt: action.payload.lastTickAt,
        failures: [],
      };
    },

    /* Advance to the next character (its design is starting). Cross-book
       guarded so a stale event from another book can't move this snapshot. */
    tick(
      state,
      action: PayloadAction<{ bookId: string; currentName: string | null; lastTickAt: number }>,
    ) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.currentName = action.payload.currentName;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Thin lastTickAt-only refresh dispatched on every server heartbeat so the
       pill's stall heuristic stays honest through a long (≤180s) single design
       while the user is on another view. Mirrors
       `analysis.bumpActiveStreamHeartbeat`. */
    heartbeat(state, action: PayloadAction<{ bookId: string; lastTickAt: number }>) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* A character was designed + persisted. */
    charDone(state, action: PayloadAction<{ bookId: string; lastTickAt: number }>) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.done += 1;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* A character was skipped (already had a Qwen voice when its turn came). */
    charSkipped(state, action: PayloadAction<{ bookId: string; lastTickAt: number }>) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.skipped += 1;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* A character's design failed — record it and keep going. Does NOT bump
       `done` (so `done` stays = successes; the summary shows failures.length). */
    charFailed(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        name: string;
        error: string;
        lastTickAt: number;
      }>,
    ) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.failures.push({
        characterId: action.payload.characterId,
        name: action.payload.name,
        error: action.payload.error,
      });
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Terminal success — flip to the brief "done" summary state. The middleware
       clears the snapshot shortly after (or the next begin displaces it). */
    settle(state, action: PayloadAction<{ bookId: string; lastTickAt: number }>) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.state = 'done';
      snap.currentName = null;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Catastrophic abort (rare). Per-character failures use `charFailed`. */
    halt(state, action: PayloadAction<{ bookId: string; lastTickAt: number }>) {
      const snap = state.active;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.state = 'halted';
      snap.currentName = null;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Tear down the snapshot — on terminal clear, cancel, or displacement. */
    clear(state) {
      state.active = null;
    },

    /* Intercepted by `cast-design-middleware` to START a run (the reducer is a
       no-op — it exists only to give a typed action creator the view dispatches). */
    designAllRequested(_state, _action: PayloadAction<DesignAllRequestedPayload>) {
      /* no-op: side effect lives in the middleware */
    },

    /* Intercepted by the middleware to RE-SUBSCRIBE to an in-flight server job
       after a cold boot / reload (no-op reducer, same rationale as above). */
    resubscribe(_state, _action: PayloadAction<{ bookId: string }>) {
      /* no-op: side effect lives in the middleware */
    },

    /* Open a single-character design snapshot. */
    beginSingle(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        name: string;
        mode: 'first' | 'redesign';
        lastTickAt: number;
      }>,
    ) {
      state.active = {
        bookId: action.payload.bookId,
        kind: 'single',
        total: 1,
        done: 0,
        skipped: 0,
        currentName: action.payload.name,
        characterId: action.payload.characterId,
        mode: action.payload.mode,
        phase: 'designing',
        state: 'running',
        lastTickAt: action.payload.lastTickAt,
        failures: [],
      };
    },

    /* Advance the sub-phase of an in-flight single design. No-ops when the
       active snapshot is not a single design or belongs to a different character. */
    setPhase(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        phase: 'designing' | 'rendering';
        lastTickAt: number;
      }>,
    ) {
      const snap = state.active;
      if (!snap || snap.kind !== 'single') return;
      if (snap.bookId !== action.payload.bookId || snap.characterId !== action.payload.characterId)
        return;
      snap.phase = action.payload.phase;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* A single re-design finished — stage the preview and flip to
       ready-to-compare. Guarded by book + character match. */
    previewReady(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        previewVoiceId: string;
        previewUrl: string;
        persona: string;
        lastTickAt: number;
      }>,
    ) {
      const snap = state.active;
      if (!snap || snap.kind !== 'single') return;
      if (snap.bookId !== action.payload.bookId || snap.characterId !== action.payload.characterId)
        return;
      snap.state = 'ready-to-compare';
      snap.preview = {
        characterId: action.payload.characterId,
        previewVoiceId: action.payload.previewVoiceId,
        previewUrl: action.payload.previewUrl,
        persona: action.payload.persona,
      };
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Intercepted by the middleware to START a single-character design
       (no-op reducer — side effect lives in the middleware). */
    designSingleRequested(
      _state,
      _action: PayloadAction<{
        bookId: string;
        characterId: string;
        name: string;
        persona: string;
        sampleVoiceId: string;
        modelKey: string;
        mode: 'first' | 'redesign';
      }>,
    ) {
      /* side effect lives in the middleware */
    },

    /* Intercepted by the middleware to RE-SUBSCRIBE to an in-flight single
       design after a cold boot / reload (no-op reducer). */
    resubscribeSingle(_state, _action: PayloadAction<{ bookId: string }>) {
      /* side effect lives in the middleware */
    },
  },
});

export const castDesignActions = castDesignSlice.actions;
