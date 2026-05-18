/* Revisions slice — pending A/B diffs awaiting accept/reject, plus drift events. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Revision, DriftEvent, RevisionsResponse, TimelineEntry } from '../lib/types';

export interface RevisionsState {
  pending: Revision[];
  drift: DriftEvent[];
  /** Ids of drift events the user has dismissed. The backend revisions
      detector reads this from disk and filters its output, so a dismissed
      event won't reappear on the next poll. Slice carries it so subsequent
      dismissals in the same session don't overwrite the persisted list. */
  dismissed: string[];
  /** Write-only audit log of per-segment selections at accept time. Keyed by
      revision id. The future TTS regen flow will consume this to re-render
      only the rejected segments; today nothing reads it back. Persisted
      because losing it would force the user to redo the diff if regen ever
      needs to know which take they kept. */
  acceptedSelections: Record<string, Record<number, 'A' | 'B'>>;
  /** Plan 55 — per-chapter append-only event log of accept / reject /
      rollback actions. Keyed by chapterId (as string in serialised form;
      numeric on the slice). The Revision History view reads this back to
      surface a chronological timeline; the rollback button on the most
      recent reversible entry calls plan 20's existing restore endpoint. */
  timeline: Record<number, TimelineEntry[]>;
  loaded: boolean;
}

const initialState: RevisionsState = {
  pending: [],
  drift: [],
  dismissed: [],
  acceptedSelections: {},
  timeline: {},
  loaded: false,
};

export const revisionsSlice = createSlice({
  name: 'revisions',
  initialState,
  reducers: {
    acceptAllPending: (s) => {
      s.pending = [];
    },
    rejectAllPending: (s) => {
      s.pending = [];
    },
    /** Per-item accept: drops one revision from pending and records the
        user's segment selection. The selection is parked on the slice and
        rides the persistence patch out to revisions.json — no in-app
        consumer reads it yet (future TTS regen will). Also appends a plan 55
        timeline entry for the chapter; the new entry is marked `reversible`
        (plan 20 preserved the prior take as `.previous.mp3`) and any prior
        `reversible` entry on the same chapter is flipped to non-reversible
        — only the most-recent reversible accept/reject on a chapter rolls
        back via plan 20's single-previous chain. */
    acceptRevision: (
      s,
      a: PayloadAction<{ revisionId: string; selection: Record<number, 'A' | 'B'> }>,
    ) => {
      const rev = s.pending.find((r) => r.id === a.payload.revisionId);
      s.pending = s.pending.filter((r) => r.id !== a.payload.revisionId);
      s.acceptedSelections[a.payload.revisionId] = a.payload.selection;
      if (rev) {
        appendTimelineEntryHelper(s, {
          id: a.payload.revisionId,
          chapterId: rev.chapterId,
          characterId: rev.characterId,
          eventKind: 'accepted',
          timestamp: nowIso(),
          status: 'active',
          reversible: true,
        });
      }
    },
    /** Per-item reject: drops one revision from pending. No selection
        captured — reject means "this revision is unwelcome, throw it away
        wholesale", not "I have feelings about specific segments." Like
        accept, a rejection is reversible via plan 20's restore (the
        previous take, untouched by the regen, is still on disk). */
    rejectRevision: (s, a: PayloadAction<string>) => {
      const rev = s.pending.find((r) => r.id === a.payload);
      s.pending = s.pending.filter((r) => r.id !== a.payload);
      if (rev) {
        appendTimelineEntryHelper(s, {
          id: a.payload,
          chapterId: rev.chapterId,
          characterId: rev.characterId,
          eventKind: 'rejected',
          timestamp: nowIso(),
          status: 'active',
          reversible: true,
        });
      }
    },
    /** Plan 55 rollback. Flips the targeted entry's status to
        `rolled-back-from` and appends a new `rolled-back` entry marking the
        action. The new entry is NOT itself reversible — plan 20's single
        `.previous.mp3` chain is consumed by the rollback. Multi-step
        rollback (snapshot-per-entry) graduates to v1.4.0. */
    rolledBack: (
      s,
      a: PayloadAction<{ chapterId: number; timelineEntryId: string; rolledBackId: string }>,
    ) => {
      const list = s.timeline[a.payload.chapterId];
      if (!list) return;
      for (const entry of list) {
        if (entry.id === a.payload.timelineEntryId) {
          entry.status = 'rolled-back-from';
        }
        // No prior reversible entry remains on this chapter — clearing
        // reversibility prevents double-rollback against a consumed chain.
        entry.reversible = false;
      }
      list.push({
        id: a.payload.rolledBackId,
        chapterId: a.payload.chapterId,
        eventKind: 'rolled-back',
        timestamp: nowIso(),
        status: 'active',
        revisionId: a.payload.timelineEntryId,
        reversible: false,
      });
    },
    dismissDrift: (s, a: PayloadAction<string>) => {
      s.drift = s.drift.filter((e) => e.id !== a.payload);
      if (!s.dismissed.includes(a.payload)) s.dismissed.push(a.payload);
    },
    /* Enqueue a pending revision when a regen kicks off. The
       generation-stream middleware fires this on every
       `chapters/regenerateCharacter` dispatch so the toolbar pending
       count surfaces the regen-in-flight immediately — without waiting
       for the 30s revisions poll cycle. `playable: false` until
       chapter_complete arrives; the a/b player renders a "Rendering…"
       state until then. Dedupe by id so a regen restart replaces the
       prior stub rather than queueing duplicates. */
    enqueuePending: (s, a: PayloadAction<Revision>) => {
      s.pending = [...s.pending.filter((r) => r.id !== a.payload.id), a.payload];
    },
    /* Flip `playable: true` for every pending revision whose chapterId
       matches. Fired from the generation-stream chapter_complete handler
       once the new render is on disk. Multiple in-flight revisions can
       target the same chapter (e.g. parallel character regens) — flip
       them all. */
    markRevisionPlayable: (s, a: PayloadAction<{ chapterId: number }>) => {
      s.pending = s.pending.map((r) =>
        r.chapterId === a.payload.chapterId ? { ...r, playable: true } : r,
      );
    },
    /* Runtime poll: refresh pending/drift but DON'T touch dismissed or
       acceptedSelections — the server response (RevisionsResponse) doesn't
       include either, and overwriting with empty would lose state until
       the next disk hydrate. */
    applyPoll: (s, a: PayloadAction<RevisionsResponse>) => {
      s.pending = a.payload?.pending || [];
      s.drift = a.payload?.drift || [];
      s.loaded = true;
    },
    /* Disk hydrate on book open. Carries dismissed + acceptedSelections so
       subsequent edits union with prior persisted state rather than
       overwriting it in revisions.json. Plan 55 adds `timeline`. */
    hydrateFromBookState: (
      s,
      a: PayloadAction<
        | {
            pending?: Revision[];
            drift?: DriftEvent[];
            dismissed?: string[];
            acceptedSelections?: Record<string, Record<number, 'A' | 'B'>>;
            timeline?: Record<string, TimelineEntry[]> | Record<number, TimelineEntry[]>;
          }
        | null
        | undefined
      >,
    ) => {
      const payload = a.payload;
      if (!payload) {
        s.loaded = true;
        return;
      }
      s.pending = payload.pending ?? [];
      s.drift = payload.drift ?? [];
      s.dismissed = payload.dismissed ?? [];
      s.acceptedSelections = payload.acceptedSelections ?? {};
      s.timeline = normaliseTimelineKeys(payload.timeline);
      s.loaded = true;
    },
  },
});

/** Internal — append a timeline entry, flipping any prior reversible entry
    on the same chapter to non-reversible. Keeps `reversible: true` as a
    one-per-chapter invariant matching plan 20's single `.previous.mp3`. */
function appendTimelineEntryHelper(s: RevisionsState, entry: TimelineEntry): void {
  const chapterEntries = (s.timeline[entry.chapterId] ??= []);
  if (entry.reversible) {
    for (const prior of chapterEntries) prior.reversible = false;
  }
  chapterEntries.push(entry);
}

/** JSON keys are strings; on-disk timeline is `Record<string, TimelineEntry[]>`
    but the slice uses numeric chapterIds. Defensive coercion preserves both
    shapes on hydrate so a pre-plan-55 book (no timeline) doesn't blow up. */
function normaliseTimelineKeys(
  raw: Record<string, TimelineEntry[]> | Record<number, TimelineEntry[]> | undefined,
): Record<number, TimelineEntry[]> {
  if (!raw) return {};
  const out: Record<number, TimelineEntry[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(k);
    if (Number.isFinite(n) && Array.isArray(v)) out[n] = v;
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const revisionsActions = revisionsSlice.actions;
