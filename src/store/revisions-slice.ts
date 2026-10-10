/* Revisions slice — plan 286: a cache of the server-owned revisions.json,
   ordered by `fileId`/`rev` with a hydrate sequence guard (spec §4). The
   server is the only writer; this slice only adopts what it returns from a
   hydrate (`hydrate`), a poll (`applyPoll`/`applyBackgroundPoll`) or a per-op
   route response (`applyServerState`, via the revisions thunks). `#3395`'s
   client-side guard machinery (window-replay, scope-reset middleware, the
   old whole-cache write path) is gone — plan 285 made the server authoritative
   for accept/reject/dismiss, so there is nothing left for the client to
   guard against racing its own writes. */

import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  Revision,
  DriftEvent,
  RevisionsResponse,
  TimelineEntry,
  RevisionsState as WireRevisionsState,
} from '../lib/types';

export interface RevisionsState {
  /** Plan 286 — the server file identity this cache last adopted. `null`
      until the first server state lands for a book (a legacy book never
      written through the server-owned store reads `fileId: null` too). */
  fileId: string | null;
  /** Plan 286 — the server file version this cache last adopted. */
  rev: number;
  /** Plan 286 — increments on every adoption that changes `(bookId, fileId,
      rev)`; a hydrate whose read started before the latest such adoption
      (`requestSeq < adoptSeq`) is stale and dropped (the sequence guard). An
      equal-version adoption (same book/fileId/rev — a routine poll) does not
      bump this, so it cannot make an in-flight hydrate look stale. */
  adoptSeq: number;
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
  /** The book `pending`/`dismissed`/`acceptedSelections`/`timeline` belong
      to — null when no book is active. Plan 286 — the server is the only
      writer, so there is no window where this cache could be actioned
      against and persisted into the wrong book's revisions.json; the
      selectors below (`selectActivePending` et al.) additionally return
      empty for any book that isn't `ui.stage`'s active one, so a stale
      `bookId` here between navigating away and the next book's hydrate
      landing is never shown. `drift` is NOT reset on a book change — it's
      already multi-book-aware (each event carries its own `bookId`, see
      `mergeDriftForBook`), unlike the other per-book fields. */
  bookId: string | null;
}

const initialState: RevisionsState = {
  fileId: null,
  rev: 0,
  adoptSeq: 0,
  pending: [],
  drift: [],
  dismissed: [],
  acceptedSelections: {},
  timeline: {},
  loaded: false,
  bookId: null,
};

/* Multi-book-aware drift merge shared by applyPoll and applyBackgroundPoll
   (#3376). When the caller stamps `bookId` onto the payload, only that book's
   drift entries are replaced — events from other concurrently-active books
   survive the poll. Without bookId, legacy whole-list replace. */
function mergeDriftForBook(
  s: RevisionsState,
  bookId: string | undefined,
  incoming: DriftEvent[] | undefined,
) {
  if (bookId) {
    s.drift = [
      ...s.drift.filter((d) => d.bookId !== bookId),
      ...(incoming || []).map((d) => ({ ...d, bookId: d.bookId || bookId })),
    ];
  } else {
    s.drift = incoming || [];
  }
}

/** Plan 286 — null (a legacy file never written through the store) is
    older than any id; ids are `${epoch 15-padded}-${random}`, so string
    order is epoch order with the suffix breaking a same-ms tie. */
export function compareFileIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
type IncomingRevisions = Partial<WireRevisionsState> & { bookId: string };
function adopt(s: RevisionsState, p: IncomingRevisions): void {
  /* Only a version change counts for the sequence guard: an equal-version
     poll must not make an in-flight hydrate look stale. */
  const changed = s.bookId !== p.bookId || s.fileId !== (p.fileId ?? null) || s.rev !== (p.rev ?? 0);
  s.bookId = p.bookId;
  s.fileId = p.fileId ?? null;
  s.rev = p.rev ?? 0;
  s.pending = p.pending ?? [];
  s.dismissed = p.dismissed ?? [];
  s.acceptedSelections = p.acceptedSelections ?? {};
  s.timeline = normaliseTimelineKeys(p.timeline);
  if (changed) s.adoptSeq += 1;
}
/** Plan 286 — the cache rule for polls and op responses (spec §4). */
function shouldAdoptOrdered(s: RevisionsState, p: IncomingRevisions): boolean {
  if (s.bookId !== p.bookId) return true;
  const c = compareFileIds(p.fileId ?? null, s.fileId);
  if (c !== 0) return c > 0;
  return (p.rev ?? 0) >= s.rev;
}

export const revisionsSlice = createSlice({
  name: 'revisions',
  initialState,
  reducers: {
    /** Plan 286 — book open / reopen hydrate from GET /state. ANY fileId
        difference adopts (null included: a book deleted and re-imported under
        its deterministic id reads fileId:null) — except a read that started
        before the latest op/poll adoption (sequence guard). */
    hydrate: (
      s,
      a: PayloadAction<{
        bookId: string;
        state: Partial<WireRevisionsState> | null;
        requestSeq?: number;
      }>,
    ) => {
      const { bookId, requestSeq } = a.payload;
      s.loaded = true;
      if (bookId === s.bookId && requestSeq !== undefined && requestSeq < s.adoptSeq) return;
      const p: IncomingRevisions = { ...(a.payload.state ?? {}), bookId };
      const differs = s.bookId !== bookId || (p.fileId ?? null) !== s.fileId;
      if (differs || (p.rev ?? 0) >= s.rev) adopt(s, p);
    },
    applyServerState: (s, a: PayloadAction<WireRevisionsState>) => {
      if (shouldAdoptOrdered(s, a.payload)) adopt(s, a.payload);
    },
    applyDismiss: (
      s,
      a: PayloadAction<{ driftId: string; state?: WireRevisionsState }>,
    ) => {
      s.drift = s.drift.filter((d) => d.id !== a.payload.driftId);
      if (a.payload.state && shouldAdoptOrdered(s, a.payload.state)) adopt(s, a.payload.state);
    },
    forgetBook: (s, a: PayloadAction<string>) => {
      if (s.bookId !== a.payload) return;
      s.bookId = null;
      s.fileId = null;
      s.rev = 0;
      s.pending = [];
      s.dismissed = [];
      s.acceptedSelections = {};
      s.timeline = {};
    },
    /* Plan 286 — the server owns pending. The poll carries the whole
       RevisionsState plus live drift: drift (per book) and the rest are adopted
       by the same ordered rule, so a slow poll cannot revert a newer op
       response or resurrect a dismissed drift event. Callers dispatch only for the active book. */
    applyPoll: (s, a: PayloadAction<RevisionsResponse & { bookId: string }>) => {
      if (shouldAdoptOrdered(s, a.payload)) {
        mergeDriftForBook(s, a.payload.bookId, a.payload.drift);
        adopt(s, a.payload);
      }
      s.loaded = true;
    },
    /* Background fan-out (Plan 83's 120 s bulk poll over NON-active books):
       merge drift scoped to the polled bookId, and never touch `pending` or
       `loaded`. `pending` is client-owned (see applyPoll above) and never
       written by any poll, active or background — this action additionally
       has no business writing a foreign book's data into the active book's
       state regardless (#3376). */
    applyBackgroundPoll: (s, a: PayloadAction<{ bookId: string; drift?: DriftEvent[] }>) => {
      mergeDriftForBook(s, a.payload.bookId, a.payload.drift);
    },
  },
});

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

export const revisionsActions = revisionsSlice.actions;

type ActiveRoot = { revisions: RevisionsState; ui: { stage: unknown } };
const EMPTY_PENDING: Revision[] = [];
const EMPTY_TIMELINE: Record<number, TimelineEntry[]> = {};
const EMPTY_SELECTIONS: Record<string, Record<number, 'A' | 'B'>> = {};
const holdsActive = (s: ActiveRoot): boolean => {
  const active = (s.ui.stage as { bookId?: string } | undefined)?.bookId ?? null;
  return s.revisions.bookId !== null && s.revisions.bookId === active;
};
/** Plan 286 — read the cache only for the active book (spec §4). */
export const selectActivePending = (s: ActiveRoot): Revision[] =>
  holdsActive(s) ? s.revisions.pending : EMPTY_PENDING;
export const selectActiveTimeline = (s: ActiveRoot) =>
  holdsActive(s) ? s.revisions.timeline : EMPTY_TIMELINE;
export const selectActiveAcceptedSelections = (s: ActiveRoot) =>
  holdsActive(s) ? s.revisions.acceptedSelections : EMPTY_SELECTIONS;

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

/** Drift events for ONE book — the cast view's per-character drift badges are
    scoped to the active book, unlike the multi-book Drift Report above.
    Memoised via createSelector (mirrors `selectDriftByBook`): an inline
    `state.revisions.drift.filter(...)` allocates a fresh array every call
    even when nothing changed, which react-redux's dev-mode stability check
    flags as "returned a different result" and forces the calling component
    to re-render on every store dispatch — a confirmed contributing factor to
    a GenerationView-area crash (#1285), since this selector's caller
    (`ReadyViewSwitch`) is GenerationView's direct parent. */
export const selectDriftForBook = createSelector(
  [selectDriftArray, (_state: { revisions: RevisionsState }, bookId: string) => bookId],
  (drift, bookId): DriftEvent[] => drift.filter((d) => d.bookId === bookId),
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

/* Fixes the "375 chapters flagged across 10 books" browser-hang report:
   `selectDriftGroupsByBook` buckets the ENTIRE workspace's drift (the
   background cross-book poll — docs/features/archive/83-drift-poll-multibook.md
   — deliberately fills it for books the user isn't even looking at), but the
   modal has no reason to render more than the active book (or its series) at
   once. Pure filter over the selector's output, applied in `layout.tsx`
   before the per-book view is built, so `DriftReportModal` itself never sees
   unscoped data. `scope: 'book'` with no `activeBookId` (can't happen from
   the real UI, but defensive) falls back to the unscoped list rather than
   rendering nothing. */
export function scopeDriftGroupsByBook(
  groupsByBook: Array<{ bookId: string; groups: DriftGroup[] }>,
  scope: 'book' | 'series',
  activeBookId: string | null,
  seriesBookIds: string[],
): Array<{ bookId: string; groups: DriftGroup[] }> {
  if (!activeBookId) return groupsByBook;
  if (scope === 'book') return groupsByBook.filter((g) => g.bookId === activeBookId);
  const allow = new Set(seriesBookIds.length > 0 ? seriesBookIds : [activeBookId]);
  return groupsByBook.filter((g) => allow.has(g.bookId));
}
