/* Revisions slice — pending A/B diffs awaiting accept/reject, plus drift events. */

import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
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
       the next disk hydrate.

       Multi-book aware: when the caller stamps `bookId` onto the payload,
       only that book's drift entries are replaced — events from other
       concurrently-active books survive the poll. `pending` is still
       replaced wholesale (the regen/diff flow operates on the active
       book and the server response doesn't differentiate). */
    applyPoll: (s, a: PayloadAction<(RevisionsResponse & { bookId?: string }) | undefined>) => {
      const payload = a.payload || ({} as RevisionsResponse & { bookId?: string });
      const bookId = payload.bookId;
      s.pending = payload.pending || [];
      if (bookId) {
        const incoming = payload.drift || [];
        s.drift = [
          ...s.drift.filter((d) => d.bookId !== bookId),
          ...incoming.map((d) => ({ ...d, bookId: d.bookId || bookId })),
        ];
      } else {
        s.drift = payload.drift || [];
      }
      s.loaded = true;
    },
    /* Disk hydrate on book open. Carries dismissed + acceptedSelections so
       subsequent edits union with prior persisted state rather than
       overwriting it in revisions.json. Plan 55 adds `timeline`.

       Multi-book aware: when `bookId` is provided, drift events for that
       book are merged in (replacing any prior events with that bookId),
       while other books' events are preserved. Without bookId the slice
       falls back to the legacy whole-slice replace for callers that
       haven't migrated. */
    hydrateFromBookState: (
      s,
      a: PayloadAction<
        | {
            bookId?: string;
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
      if (payload.bookId) {
        const bid = payload.bookId;
        const incoming = payload.drift ?? [];
        s.drift = [
          ...s.drift.filter((d) => d.bookId !== bid),
          ...incoming.map((d) => ({ ...d, bookId: d.bookId || bid })),
        ];
      } else {
        s.drift = payload.drift ?? [];
      }
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

/* `createSelector` input — the flat drift array. Both grouped selectors
   memoise on this reference, so any reducer that returns a fresh array
   (applyPoll, dismissDrift, hydrate) invalidates the cache; reducers
   that don't touch drift keep the cached result. */
const selectDriftArray = (state: { revisions: RevisionsState }) => state.revisions.drift;

/* Selector: group drift events by `bookId` for the multi-book Drift
   Report. Returns an ordered array so the modal can render one section
   per book. Books with no events are absent. The order preserves the
   first appearance of each bookId in the flat `drift` list — a tiny
   stability detail that keeps the modal from re-shuffling when a poll
   completes for a different book mid-render. Memoised via createSelector
   so unrelated re-renders don't rebuild the Map every time (perf — a
   300-event modal hangs the browser otherwise). */
export const selectDriftByBook = createSelector(
  [selectDriftArray],
  (drift): Array<{ bookId: string; events: DriftEvent[] }> => {
    const seen = new Map<string, DriftEvent[]>();
    for (const event of drift) {
      const bid = event.bookId ?? '';
      let bucket = seen.get(bid);
      if (!bucket) {
        bucket = [];
        seen.set(bid, bucket);
      }
      bucket.push(event);
    }
    return Array.from(seen.entries()).map(([bookId, events]) => ({ bookId, events }));
  },
);

/* A drift-card group bundles every chapter affected by the same
   `(bookId, characterId, snapshot)` triple under one card. The compare
   table at the top of the card is the diff between this snapshot and
   the current cast profile — by definition identical for every event in
   the group, so it renders once instead of N times. Per-chapter regen /
   listen / dismiss controls live in the expandable strip at the bottom
   of the card. */
export interface DriftGroup {
  groupId: string;
  bookId: string;
  characterId: string;
  /** Profile the character had at chapter-render time. Shared by every
      event in this group (same JSON fingerprint). */
  snapshot: DriftEvent['snapshot'];
  /** Live profile from the latest cast. Shared by every event in this
      group; the modal renders the snapshot→current diff once. */
  current: DriftEvent['current'];
  /** Max severity across the group's events — drives the group's pill. */
  topSeverity: DriftEvent['severity'];
  severityCounts: Record<DriftEvent['severity'], number>;
  /** Union of `factor` strings across events in the group — surface what
      triggered the drift in factor-chip form. */
  factors: string[];
  /** Per-chapter events, sorted by chapterId ascending. */
  events: DriftEvent[];
  /** True iff every event in the group is `autoQueueable`. Controls the
      "Auto-regen all" bulk action's availability. */
  allAutoQueueable: boolean;
}

const severityRank: Record<DriftEvent['severity'], number> = {
  severe: 3,
  moderate: 2,
  mild: 1,
};

/* Stable fingerprint of a drift snapshot — same fields the compare card
   reads. JSON.stringify with sorted keys keeps fingerprints
   deterministic across reducer runs (Set / Object key order vary). A
   missing snapshot collapses to a sentinel so older events still group
   sanely. */
function snapshotKey(snap: DriftEvent['snapshot']): string {
  if (!snap) return '∅';
  const tone = snap.tone ?? {};
  const attrs = (snap.attributes ?? []).slice().sort().join(',');
  return [
    snap.voiceId ?? '',
    snap.voiceEngine ?? '',
    snap.gender ?? '',
    snap.ageRange ?? '',
    tone.warmth ?? '',
    tone.pace ?? '',
    tone.authority ?? '',
    tone.emotion ?? '',
    attrs,
  ].join('|');
}

/* Collapse a flat list of drift events into `(book × character ×
   snapshot)` groups. Pure helper — also reused by tests that need to
   build a `groupsByBook` prop without going through redux. */
export function groupDriftEvents(events: DriftEvent[]): DriftGroup[] {
  const byGroupId = new Map<string, DriftGroup>();
  for (const event of events) {
    const bid = event.bookId ?? '';
    const gid = `${bid}|${event.characterId}|${snapshotKey(event.snapshot)}`;
    let group = byGroupId.get(gid);
    if (!group) {
      group = {
        groupId: gid,
        bookId: bid,
        characterId: event.characterId,
        snapshot: event.snapshot,
        current: event.current,
        topSeverity: event.severity,
        severityCounts: { severe: 0, moderate: 0, mild: 0 },
        factors: [],
        events: [],
        allAutoQueueable: true,
      };
      byGroupId.set(gid, group);
    }
    group.events.push(event);
    group.severityCounts[event.severity] = (group.severityCounts[event.severity] ?? 0) + 1;
    if (severityRank[event.severity] > severityRank[group.topSeverity]) {
      group.topSeverity = event.severity;
    }
    if (event.factor && !group.factors.includes(event.factor)) {
      group.factors.push(event.factor);
    }
    if (!event.autoQueueable) group.allAutoQueueable = false;
    /* Adopt the freshest `current` projection — server stamps it from
       the live cast on every emit, so the last-seen wins. Snapshot is
       immutable per groupId by construction. */
    if (event.current) group.current = event.current;
  }
  /* Sort each group's events by chapterId so the affected-chapters
     strip reads in order. */
  return Array.from(byGroupId.values()).map((g) => ({
    ...g,
    events: g.events.slice().sort((a, b) => a.chapterId - b.chapterId),
  }));
}

/* Selector: collapse the flat drift list into `(book × character ×
   snapshot)` groups. Replaces the per-event card render in the Drift
   Report modal — 300 events typically collapse to ~6–18 groups because
   the same cast edit affects every chapter the character voiced.
   Memoised via createSelector. */
export const selectDriftGroupsByBook = createSelector(
  [selectDriftArray],
  (drift): Array<{ bookId: string; groups: DriftGroup[] }> => {
    const byBook = new Map<string, DriftEvent[]>();
    for (const event of drift) {
      const bid = event.bookId ?? '';
      let bucket = byBook.get(bid);
      if (!bucket) {
        bucket = [];
        byBook.set(bid, bucket);
      }
      bucket.push(event);
    }
    return Array.from(byBook.entries()).map(([bookId, events]) => ({
      bookId,
      groups: groupDriftEvents(events),
    }));
  },
);
