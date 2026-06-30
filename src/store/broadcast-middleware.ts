/* Cross-tab `BroadcastChannel` state sync (plan 63, refined by plan 89 C2).

   Two tabs open on the same workspace cooperatively share the analysis +
   generation pill state. When tab A starts an analysis or advances a
   generation tick, tab B's top-bar pill updates without a network
   round-trip — no `/api/library/active-analyses` cold-boot lookup, no
   page refresh.

   Channel: `audiobook-state` (one shared channel name across the app).
   Payload shape (plan 89 C2): `{ kind: 'sync:analysis' | 'sync:chapters',
   instanceId, bookId, mode: 'full' | 'diff' | 'clear', diff?, snapshot? }`.
   The `instanceId` is a per-tab UUID generated at module init; each outbound
   message carries it and the inbound listener drops messages whose
   `instanceId` matches our own (echo suppression — without this, the
   broadcast loop becomes infinite ping-pong because every inbound
   `applyExternal*Snapshot` dispatch would re-broadcast in the outbound path).

   Two layers of echo suppression:
   1. **Instance tag.** Outbound messages carry our `instanceId`; the
      inbound listener `if (msg.instanceId === selfId) return`.
   2. **Action filter.** The outbound watcher does NOT match the inbound
      reducers (`analysis/applyExternalAnalysisSnapshot`,
      `chapters/applyExternalChaptersSnapshot`). Even if a bug ever
      lets a self-message slip past layer 1, the inbound dispatch
      won't re-broadcast because its action type isn't in the
      broadcast rules table.

   Plan 89 C2 — shallow diffing + phaseProgress debounce:

   The post-mutation snapshot is shallow-compared against the last value
   we broadcast for the same `(kind, bookId)` pair. Only the changed
   fields ride the wire — and when the *only* delta is `phaseProgress`
   (+ optionally `lastTickAt`), we debounce to one broadcast per
   `PROGRESS_DEBOUNCE_MS` so an analyzer phase that ticks 10x/sec
   doesn't fan 10 messages/sec into every idle tab. The recipient
   reconstructs the full snapshot by spreading the diff onto its local
   activeStream (`mode: 'diff'`), or replaces it wholesale on initial /
   structural changes (`mode: 'full'`) or clears (`mode: 'clear'`).

   PRESERVED INVARIANT (plan 63): the diff stays strictly inside the
   `activeStream` field of the analysis / chapters slices. The set of
   broadcast-eligible action types
   (`ANALYSIS_BROADCAST_ACTIONS` / `CHAPTERS_BROADCAST_ACTIONS`) does
   not widen — per-chapter rows / cast / manuscript still never
   broadcast. The C2 change is solely about the *payload shape* of the
   existing broadcasts.

   Graceful degradation: `BroadcastChannel` is missing in some older
   browsers and (historically) in non-jsdom environments. The middleware
   feature-detects via `typeof BroadcastChannel === 'function'` and
   no-ops out when absent — the cold-boot endpoint still serves as the
   fallback path for cross-tab catch-up.

   Cross-bookId isolation: each broadcast carries its slice's bookId
   inside the snapshot. The analysis-slice's `activeStream.bookId` and
   the chapters-slice's `activeStream.bookId` ride along with the
   snapshot; the inbound reducer replaces the slice's activeStream
   wholesale, so cross-bookId leak is structurally impossible — a tab
   on book X receives a tab-B-bookY snapshot, its activeStream becomes
   book Y, and the header pill correctly reflects "book Y is in flight
   elsewhere". Per-chapter rows / per-book cast / per-book manuscript
   are NEVER broadcast.

   Tension with backlog `fe-11` (multi-tab catch-up race resilience): this
   covers the cooperative cross-tab case (single user driving two tabs).
   Two simultaneous writers on the same bookId would still race — that
   stays parked. Single-user-per-workspace remains the v1 contract.
*/

import type { Middleware, AnyAction } from '@reduxjs/toolkit';
import { analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { chaptersActions, type ActiveStreamSnapshot } from './chapters-slice';
import { prosodyActions } from './prosody-slice';
import { scriptReviewActions } from './script-review-slice';
import type { SubstageEntry } from './prosody-slice';

/** Shared channel name. Hard-coded — there is exactly one. */
export const BROADCAST_CHANNEL_NAME = 'audiobook-state';

/** Plan 89 C2 — coalesce phaseProgress-only ticks within this window into a
 *  single broadcast. The receiver still gets the latest value, and a
 *  user-facing pill that updates at most 4x/sec is well below the perception
 *  threshold for "smooth" progress. Tuned to be longer than a typical SSE
 *  tick interval (~50–200 ms) so consecutive ticks reliably batch, but short
 *  enough that the worst-case latency is invisible. */
export const PROGRESS_DEBOUNCE_MS = 250;

/** Plan 89 C2 — discriminator for the payload shape after diffing. */
export type BroadcastMode = 'full' | 'diff' | 'clear';

/** Outbound message shape (plan 89 C2). Discriminated by `kind`.
 *
 *  - `mode: 'full'` — `snapshot` carries the entire activeStream. Sent on the
 *    first broadcast for a given `(kind, bookId)`, or when the bookId has
 *    changed since the last broadcast (the receiver can't safely apply a
 *    diff onto a foreign-book base).
 *  - `mode: 'diff'` — `diff` carries only the keys that changed since our
 *    last broadcast. The receiver spreads it onto its existing
 *    activeStream. `snapshot` is omitted from this branch.
 *  - `mode: 'clear'` — the snapshot was set to null (clearActiveStream).
 *    `snapshot` is null; receivers null-out their activeStream. */
export type BroadcastMessage =
  | {
      kind: 'sync:analysis';
      instanceId: string;
      /** Snapshot's own `bookId` for fast pre-filter on the receiver. */
      bookId: string | null;
      mode: 'full';
      snapshot: AnalysisStreamSnapshot;
    }
  | {
      kind: 'sync:analysis';
      instanceId: string;
      bookId: string | null;
      mode: 'diff';
      /** Subset of AnalysisStreamSnapshot fields that changed. */
      diff: Partial<AnalysisStreamSnapshot>;
    }
  | {
      kind: 'sync:analysis';
      instanceId: string;
      bookId: string | null;
      mode: 'clear';
      snapshot: null;
    }
  | {
      kind: 'sync:chapters';
      instanceId: string;
      bookId: string | null;
      mode: 'full';
      snapshot: ActiveStreamSnapshot;
    }
  | {
      kind: 'sync:chapters';
      instanceId: string;
      bookId: string | null;
      mode: 'diff';
      diff: Partial<ActiveStreamSnapshot>;
    }
  | {
      kind: 'sync:chapters';
      instanceId: string;
      bookId: string | null;
      mode: 'clear';
      snapshot: null;
    }
  | {
      kind: 'sync:substage';
      instanceId: string;
      stream: 'prosody' | 'review';
      bookId: string;
      mode: 'set';
      entry: SubstageEntry;
    }
  | {
      kind: 'sync:substage';
      instanceId: string;
      stream: 'prosody' | 'review';
      bookId: string;
      mode: 'clear';
    };

/** Action types that mutate the analysis slice's activeStream. The
    middleware re-derives the slice's snapshot post-mutation and
    broadcasts it. Inbound reducer (`applyExternalAnalysisSnapshot`) is
    deliberately absent — it must NEVER re-broadcast (echo suppression
    layer 2). */
const ANALYSIS_BROADCAST_ACTIONS: ReadonlySet<string> = new Set([
  'analysis/setActiveStream',
  'analysis/applyAnalysisSnapshotTick',
  'analysis/bumpActiveStreamHeartbeat',
  'analysis/setHalted',
  'analysis/setPaused',
  'analysis/clearActiveStream',
  'analysis/hydrateColdBoot',
  'analysis/setSeriesPrior',
]);

/** Substage progress actions for prosody and script-review slices. The
    `applyExternal*` reducers are deliberately absent (echo layer 2). */
const SUBSTAGE_BROADCAST_ACTIONS: ReadonlySet<string> = new Set([
  'prosody/setActive', 'prosody/updateProgress', 'prosody/clear',
  'scriptReview/setActive', 'scriptReview/updateProgress', 'scriptReview/clear',
]);

/** Same intent for the chapters slice — anything that touches
    `activeStream`. Per-chapter row mutations (`applyGenerationTick`,
    `setChapters`, `hydrateFromBookState`, the regenerate* family,
    `mergeSubsetAnalysis`, `setChapterExcluded`) are NOT broadcast:
    those are per-tab UI state and broadcasting them would fan out
    side-effects that this plan explicitly does not solve (see backlog `fe-11`). */
const CHAPTERS_BROADCAST_ACTIONS: ReadonlySet<string> = new Set([
  'chapters/setActiveStream',
  'chapters/clearActiveStream',
  'chapters/updateActiveStreamProgress',
]);

/** Minimal slice shape the middleware reads from `getState()`. Declared
    locally to avoid a circular type back through `RootState`. */
interface BroadcastableRootState {
  analysis: { activeStream: AnalysisStreamSnapshot | null };
  chapters: { activeStreams: Record<string, ActiveStreamSnapshot> };
  prosody: { activeStreams: Record<string, SubstageEntry> };
  scriptReview: { activeStreams: Record<string, SubstageEntry> };
}

/** Random 16-char hex id. Crypto-grade not required — collision risk
    across a handful of open tabs is negligible. */
function makeInstanceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Feature-detect BroadcastChannel. Older browsers + some test
    environments (older jsdom, node-without-polyfill) don't expose it. */
function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel === 'function';
}

/** Plan 89 C2 — compute the shallow diff between `prev` and `next` (one-level
 *  field comparison). Returns `null` when the two are field-wise equal. The
 *  diff includes every key present in `next` whose value differs by `===`
 *  from `prev`'s value (or that wasn't present in `prev`). Symmetric
 *  deletion (a key that disappeared) isn't modelled — the snapshots are
 *  fixed-shape structs from a typed interface, not freeform maps, so
 *  `undefined` legitimately survives a diff round-trip. */
function shallowDiff<T extends Record<string, unknown>>(prev: T, next: T): Partial<T> | null {
  let changed = false;
  const out: Partial<T> = {};
  for (const k in next) {
    if (prev[k] !== next[k]) {
      out[k] = next[k];
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Plan 89 C2 — true when the diff *only* touches phaseProgress and (optionally)
 *  lastTickAt. Those are the high-frequency progress ticks the
 *  PROGRESS_DEBOUNCE_MS window collapses. */
function isProgressOnlyDiff(diff: Partial<Record<string, unknown>>): boolean {
  const keys = Object.keys(diff);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (k !== 'phaseProgress' && k !== 'lastTickAt') return false;
  }
  return true;
}

/** Outbound dispatcher options consumed by the middleware factory. Pulled out
 *  so tests can stub `now()` and skip the real `setTimeout` clock. */
interface OutboundOpts {
  /** ms-since-epoch clock used for the debounce window. Tests override this
   *  to make the assertion deterministic without faking timers. */
  now: () => number;
  /** Debounce window. Tests sometimes shorten this for assertion speed. */
  debounceMs: number;
}

/** Factory so tests can build the middleware against an injected
    channel + instanceId rather than the module-global ones. Production
    callers use `broadcastMiddleware` (the singleton below). */
export function createBroadcastMiddleware(opts?: {
  channel?: BroadcastChannel | null;
  instanceId?: string;
  /** Plan 89 C2 — test-only knobs. Both default to production values. */
  now?: () => number;
  debounceMs?: number;
}): Middleware {
  const outbound: OutboundOpts = {
    now: opts?.now ?? (() => Date.now()),
    debounceMs: opts?.debounceMs ?? PROGRESS_DEBOUNCE_MS,
  };
  return (store) => {
    const instanceId = opts?.instanceId ?? makeInstanceId();
    const channel: BroadcastChannel | null =
      opts?.channel !== undefined
        ? opts.channel
        : hasBroadcastChannel()
          ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
          : null;

    /* Plan 89 C2 — last broadcast snapshot per kind, keyed by bookId. We
       keep the bookId on the entry so a bookId change between successive
       snapshots forces a `mode: 'full'` send (the receiver can't apply a
       diff onto a foreign-book base). null = nothing sent yet. */
    let lastAnalysisSent: {
      bookId: string | null;
      snapshot: AnalysisStreamSnapshot;
    } | null = null;
    let lastChaptersSent: {
      bookId: string | null;
      snapshot: ActiveStreamSnapshot;
    } | null = null;
    /* Track the wall-clock of the last progress-only emission per kind so
       the debounce can drop intermediate ticks. lastSendAt is bumped on
       every send (full / diff / clear) so a structural broadcast also
       resets the window — a fresh phase transition isn't a progress
       tick and shouldn't be debounced. */
    let lastAnalysisSendAt = -Infinity;
    let lastChaptersSendAt = -Infinity;

    if (channel) {
      channel.onmessage = (ev: MessageEvent<BroadcastMessage>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        /* Echo suppression layer 1: drop messages we sent ourselves. */
        if (msg.instanceId === instanceId) return;
        if (msg.kind === 'sync:analysis') {
          /* Reconstruct the inbound snapshot from the message's mode. */
          if (msg.mode === 'clear') {
            store.dispatch(analysisActions.applyExternalAnalysisSnapshot(null));
          } else if (msg.mode === 'full') {
            store.dispatch(analysisActions.applyExternalAnalysisSnapshot(msg.snapshot));
          } else if (msg.mode === 'diff') {
            /* Spread the diff onto our existing activeStream — that's our
               best snapshot of "the sender's previous full state".
               Inbound from another tab on a fresh open should never be
               a diff: the sender's lastAnalysisSent would be null →
               first broadcast is `mode: 'full'`. If we somehow receive
               a diff without a base, drop it rather than reconstructing
               a broken partial — the next non-debounced tick will be
               full. */
            const current = (store.getState() as BroadcastableRootState).analysis.activeStream;
            if (current) {
              store.dispatch(
                analysisActions.applyExternalAnalysisSnapshot({ ...current, ...msg.diff }),
              );
            }
          }
          return;
        }
        if (msg.kind === 'sync:chapters') {
          if (msg.mode === 'clear') {
            store.dispatch(chaptersActions.applyExternalChaptersSnapshot(null));
          } else if (msg.mode === 'full') {
            store.dispatch(chaptersActions.applyExternalChaptersSnapshot(msg.snapshot));
          } else if (msg.mode === 'diff') {
            const current =
              Object.values((store.getState() as BroadcastableRootState).chapters.activeStreams)[0] ??
              null;
            if (current) {
              store.dispatch(
                chaptersActions.applyExternalChaptersSnapshot({ ...current, ...msg.diff }),
              );
            }
          }
          return;
        }
        if (msg.kind === 'sync:substage') {
          const actions = msg.stream === 'prosody' ? prosodyActions : scriptReviewActions;
          if (msg.mode === 'clear') {
            store.dispatch(actions.applyExternalClear({ bookId: msg.bookId }));
          } else {
            store.dispatch(actions.applyExternalSet({ bookId: msg.bookId, entry: msg.entry }));
          }
          return;
        }
      };
    }

    /** Post the message, swallowing channel-closed races. Returns true on
     *  success so the outer flow can update the last-sent cursors only on
     *  actual sends (e.g. a debounce-skip should not bump them). */
    function send(msg: BroadcastMessage): boolean {
      try {
        channel?.postMessage(msg);
        return true;
      } catch (err) {
        /* postMessage can throw if the channel was closed under us
           (e.g. page unload races). Swallow — the cold-boot endpoint
           fallback is still the correctness floor. */
        console.warn('[broadcast] postMessage failed', err);
        return false;
      }
    }

    return (next) => (action) => {
      /* Let the reducer run first so getState() reflects the post-mutation
         snapshot — we broadcast the resulting truth, not the action's
         payload (which can be partial, e.g. an
         applyAnalysisSnapshotTick that only carries phaseProgress). */
      const result = next(action);
      if (!channel) return result;
      const a = action as AnyAction;
      const type = a?.type;
      if (typeof type !== 'string') return result;

      if (ANALYSIS_BROADCAST_ACTIONS.has(type)) {
        const state = store.getState() as BroadcastableRootState;
        const snapshot = state.analysis.activeStream;
        const bookId = snapshot?.bookId ?? null;
        const now = outbound.now();

        if (snapshot === null) {
          /* Clear path — always sent, never debounced. Reset the
             baseline so the next live snapshot is a `mode: 'full'`. */
          if (send({ kind: 'sync:analysis', instanceId, bookId: null, mode: 'clear', snapshot: null })) {
            lastAnalysisSent = null;
            lastAnalysisSendAt = now;
          }
          return result;
        }

        /* No previous baseline, or the bookId changed → send the whole
           snapshot. The receiver can't safely apply a diff over a
           foreign-book base. */
        if (!lastAnalysisSent || lastAnalysisSent.bookId !== bookId) {
          if (send({ kind: 'sync:analysis', instanceId, bookId, mode: 'full', snapshot })) {
            lastAnalysisSent = { bookId, snapshot };
            lastAnalysisSendAt = now;
          }
          return result;
        }

        const diff = shallowDiff(
          lastAnalysisSent.snapshot as unknown as Record<string, unknown>,
          snapshot as unknown as Record<string, unknown>,
        ) as Partial<AnalysisStreamSnapshot> | null;
        /* `phaseElapsedMs` is a heartbeat-frequency, purely-cosmetic field that
           drives the single-chapter subset pill's local time-ease. Keep it OFF
           the cross-tab wire — broadcasting it would flood the channel every ~2s
           and churn the diff; a mirror tab maps from its own clock instead. */
        if (diff && 'phaseElapsedMs' in diff) {
          delete (diff as Record<string, unknown>).phaseElapsedMs;
        }
        if (!diff || Object.keys(diff).length === 0) {
          /* No-op tick — slice state didn't change (or only phaseElapsedMs did,
             which we don't broadcast). Skip the wire. */
          return result;
        }

        /* phaseProgress-only ticks debounce within PROGRESS_DEBOUNCE_MS. */
        if (
          isProgressOnlyDiff(diff as Partial<Record<string, unknown>>) &&
          now - lastAnalysisSendAt < outbound.debounceMs
        ) {
          return result;
        }

        if (send({ kind: 'sync:analysis', instanceId, bookId, mode: 'diff', diff })) {
          lastAnalysisSent = { bookId, snapshot };
          lastAnalysisSendAt = now;
        }
        return result;
      }

      if (CHAPTERS_BROADCAST_ACTIONS.has(type)) {
        const state = store.getState() as BroadcastableRootState;
        /* The wire still carries a single snapshot. Through Wave 2 there is at
           most one open stream, so the single value is unambiguous; pick the
           first if several ever coexist (the pill aggregates locally anyway). */
        const snapshot = Object.values(state.chapters.activeStreams)[0] ?? null;
        const bookId = snapshot?.bookId ?? null;
        const now = outbound.now();

        if (snapshot === null) {
          if (send({ kind: 'sync:chapters', instanceId, bookId: null, mode: 'clear', snapshot: null })) {
            lastChaptersSent = null;
            lastChaptersSendAt = now;
          }
          return result;
        }

        if (!lastChaptersSent || lastChaptersSent.bookId !== bookId) {
          if (send({ kind: 'sync:chapters', instanceId, bookId, mode: 'full', snapshot })) {
            lastChaptersSent = { bookId, snapshot };
            lastChaptersSendAt = now;
          }
          return result;
        }

        const diff = shallowDiff(
          lastChaptersSent.snapshot as unknown as Record<string, unknown>,
          snapshot as unknown as Record<string, unknown>,
        ) as Partial<ActiveStreamSnapshot> | null;
        if (!diff) return result;

        /* chapters slice doesn't have a phaseProgress field, but the same
           debounce-only-progress rule applies: lastTickAt heartbeats land
           solo (no other field flips), and a stream of those should
           collapse the same way. We treat a diff that only touches
           `lastTickAt` as the chapters-side equivalent. */
        if (
          isProgressOnlyDiff(diff as Partial<Record<string, unknown>>) &&
          now - lastChaptersSendAt < outbound.debounceMs
        ) {
          return result;
        }

        if (send({ kind: 'sync:chapters', instanceId, bookId, mode: 'diff', diff })) {
          lastChaptersSent = { bookId, snapshot };
          lastChaptersSendAt = now;
        }
        return result;
      }

      if (SUBSTAGE_BROADCAST_ACTIONS.has(type)) {
        const [sliceName] = type.split('/');
        const stream: 'prosody' | 'review' = sliceName === 'prosody' ? 'prosody' : 'review';
        const bookId = (a.payload as { bookId?: string })?.bookId;
        if (!bookId) return result;
        const state = store.getState() as BroadcastableRootState;
        const map = stream === 'prosody' ? state.prosody.activeStreams : state.scriptReview.activeStreams;
        const entry = map[bookId]; // present for set/updateProgress; absent after clear
        if (entry) {
          send({ kind: 'sync:substage', instanceId, stream, bookId, mode: 'set', entry });
        } else {
          send({ kind: 'sync:substage', instanceId, stream, bookId, mode: 'clear' });
        }
        return result;
      }

      return result;
    };
  };
}

/** Singleton wired into the store in `src/store/index.ts`. Tests should
    use `createBroadcastMiddleware({ channel })` with an injected mock
    instead. */
export const broadcastMiddleware: Middleware = createBroadcastMiddleware();
