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
  /** Max severity across the group's chapters — drives the group's pill. */
  topSeverity: DriftEvent['severity'];
  /** Per-chapter top-severity counts. NOT per-event — the server emits
      one DriftEvent per drift factor (voice / tone / attributes / …), so
      a chapter that fires 3 factors would otherwise inflate these counts
      3×. Pre-correction (plan 91 archive) this counted events. */
  severityCounts: Record<DriftEvent['severity'], number>;
  /** Union of `factor` strings across events in the group — surface what
      triggered the drift in factor-chip form. */
  factors: string[];
  /** Raw per-event list, sorted by chapterId ascending. Used by
      bulk-dismiss (every factor-event must be dismissed individually so
      the chapter doesn't reappear on the next poll). */
  events: DriftEvent[];
  /** Per-chapter rollup. The modal's chapter strip renders ONE row per
      chapter — multi-factor events on the same chapter collapse here.
      Sorted by chapterId ascending. */
  chapters: DriftChapterEntry[];
  /** True iff every event in the group is `autoQueueable`. Controls the
      "Auto-regen all" bulk action's availability. */
  allAutoQueueable: boolean;
}

/* One row in the chapter strip. Aggregates every drift event the group
   has for `chapterId` so the strip can show one row even when multiple
   factors fired on the same chapter. */
export interface DriftChapterEntry {
  chapterId: number;
  chapterTitle: string;
  topSeverity: DriftEvent['severity'];
  /** Union of factor strings that fired on this chapter. */
  factors: string[];
  /** True iff every underlying event is autoQueueable. */
  autoQueueable: boolean;
  /** Every underlying event id. Dismiss-one-row loops over these so a
      single click takes down every factor-event for the chapter. */
  eventIds: string[];
  /** Top-severity event for this chapter — fed to DriftListenWidget
      (which takes a single event) and used for stable test ids. */
  representativeEvent: DriftEvent;
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
   build a `groupsByBook` prop without going through redux.

   The grouping key intentionally OMITS `factor` — the server emits one
   event per drift factor (voice / gender / ageRange / 4 tone metrics /
   attributes), and all factor-events for the same `(book, character,
   snapshot)` share one compare card. The same omission means multiple
   factor-events for the same chapter must be folded into one
   `DriftChapterEntry` so the chapter strip doesn't duplicate rows. */
export function groupDriftEvents(events: DriftEvent[]): DriftGroup[] {
  const byGroupId = new Map<
    string,
    DriftGroup & { _byChapter: Map<number, DriftChapterEntry> }
  >();
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
        chapters: [],
        allAutoQueueable: true,
        _byChapter: new Map(),
      };
      byGroupId.set(gid, group);
    }
    group.events.push(event);
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

    /* Per-chapter rollup. First event for a chapter seeds the entry;
       subsequent events for the same chapter raise top-severity, union
       factors, AND autoQueueable, push the eventId, and swap the
       representative event when a more-severe one arrives. */
    let entry = group._byChapter.get(event.chapterId);
    if (!entry) {
      entry = {
        chapterId: event.chapterId,
        chapterTitle: event.chapterTitle,
        topSeverity: event.severity,
        factors: event.factor ? [event.factor] : [],
        autoQueueable: event.autoQueueable ?? false,
        eventIds: [event.id],
        representativeEvent: event,
      };
      group._byChapter.set(event.chapterId, entry);
    } else {
      entry.eventIds.push(event.id);
      if (event.factor && !entry.factors.includes(event.factor)) {
        entry.factors.push(event.factor);
      }
      if (!event.autoQueueable) entry.autoQueueable = false;
      if (severityRank[event.severity] > severityRank[entry.topSeverity]) {
        entry.topSeverity = event.severity;
        entry.representativeEvent = event;
      }
      /* Prefer the freshest non-empty chapterTitle (server stamps it
         per-event; older events occasionally fall through to "Chapter
         N" — let later events upgrade). */
      if (event.chapterTitle && !entry.chapterTitle.trim()) {
        entry.chapterTitle = event.chapterTitle;
      }
    }
  }
  /* Final pass: sort events + chapters by chapterId, derive
     per-chapter severityCounts (NOT per-event — see DriftGroup doc),
     drop the private _byChapter Map from the returned shape. */
  return Array.from(byGroupId.values()).map((g) => {
    const chapters = Array.from(g._byChapter.values()).sort(
      (a, b) => a.chapterId - b.chapterId,
    );
    const severityCounts: Record<DriftEvent['severity'], number> = {
      severe: 0,
      moderate: 0,
      mild: 0,
    };
    for (const ch of chapters) severityCounts[ch.topSeverity] += 1;
    const { _byChapter: _unused, ...rest } = g;
    return {
      ...rest,
      events: g.events.slice().sort((a, b) => a.chapterId - b.chapterId),
      chapters,
      severityCounts,
    };
  });
}

/* Count of DISTINCT flagged chapters across a set of drift events.

   Drift's unit of action is the chapter: regenerating a chapter clears
   drift for EVERY cast member in it. So every "{N} chapters" headline must
   dedupe to unique `(book, chapter)` pairs — counting raw events (which are
   chapter × character × factor) over-reports whenever a chapter has more than
   one drifting character, or one character drifts on multiple factors. Keyed
   by `bookId|chapterId` so the same chapter number in two books stays
   distinct. */
export function distinctDriftChapterCount(events: DriftEvent[]): number {
  return new Set(events.map((e) => `${e.bookId ?? ''}|${e.chapterId}`)).size;
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
