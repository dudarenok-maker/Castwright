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

/** A single character's design failure, surfaced in the terminal summary. */
export interface CastDesignFailure {
  characterId: string;
  name: string;
  error: string;
}

/** Snapshot of the in-flight bulk-design job for ONE book. Opened by the
    middleware on start (or on cold-boot re-subscribe); advanced per character;
    settled then cleared on completion. */
export interface CastDesignSnapshot {
  bookId: string;
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
  /** `running` is the happy path; `done` is the brief terminal-summary state
      before clear; `halted` is a catastrophic abort (rare — per-character
      failures never halt). `stalled` is a derived UI state computed inline in
      the layout from `lastTickAt`, not stored here. */
  state: 'running' | 'done' | 'halted';
  /** ms since epoch of the most recent tick/heartbeat — drives the pill's
      stall heuristic (recomputed in the layout against `Date.now()`). */
  lastTickAt: number;
  /** Per-character failures; the loop continues past each one. */
  failures: CastDesignFailure[];
}

export interface CastDesignState {
  active: CastDesignSnapshot | null;
}

const initialState: CastDesignState = {
  active: null,
};

/** Payload for the request action the middleware intercepts (no-op reducer). */
export interface DesignAllRequestedPayload {
  bookId: string;
  characterIds: string[];
  modelKey: string;
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
  },
});

export const castDesignActions = castDesignSlice.actions;
