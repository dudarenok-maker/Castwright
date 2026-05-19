/* Cross-tab `BroadcastChannel` state sync (plan 63).

   Two tabs open on the same workspace cooperatively share the analysis +
   generation pill state. When tab A starts an analysis or advances a
   generation tick, tab B's top-bar pill updates without a network
   round-trip — no `/api/library/active-analyses` cold-boot lookup, no
   page refresh.

   Channel: `audiobook-state` (one shared channel name across the app).
   Payload shape: `{ kind: 'sync:analysis' | 'sync:chapters', instanceId,
   bookId, snapshot }`. The `instanceId` is a per-tab UUID generated at
   module init; each outbound message carries it and the inbound
   listener drops messages whose `instanceId` matches our own (echo
   suppression — without this, the broadcast loop becomes infinite
   ping-pong because every inbound `applyExternal*Snapshot` dispatch
   would re-broadcast in the outbound path).

   Two layers of echo suppression:
   1. **Instance tag.** Outbound messages carry our `instanceId`; the
      inbound listener `if (msg.instanceId === selfId) return`.
   2. **Action filter.** The outbound watcher does NOT match the inbound
      reducers (`analysis/applyExternalAnalysisSnapshot`,
      `chapters/applyExternalChaptersSnapshot`). Even if a bug ever
      lets a self-message slip past layer 1, the inbound dispatch
      won't re-broadcast because its action type isn't in the
      broadcast rules table.

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

   Tension with Won't #3 (multi-tab catch-up race resilience): this
   covers the cooperative cross-tab case (single user driving two tabs).
   Two simultaneous writers on the same bookId would still race — that
   stays parked. Single-user-per-workspace remains the v1 contract.
*/

import type { Middleware, AnyAction } from '@reduxjs/toolkit';
import { analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { chaptersActions, type ActiveStreamSnapshot } from './chapters-slice';

/** Shared channel name. Hard-coded — there is exactly one. */
export const BROADCAST_CHANNEL_NAME = 'audiobook-state';

/** Outbound message shape. Discriminated by `kind`. */
export type BroadcastMessage =
  | {
      kind: 'sync:analysis';
      instanceId: string;
      /** Snapshot's own `bookId` for fast pre-filter on the receiver. */
      bookId: string | null;
      snapshot: AnalysisStreamSnapshot | null;
    }
  | {
      kind: 'sync:chapters';
      instanceId: string;
      bookId: string | null;
      snapshot: ActiveStreamSnapshot | null;
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

/** Same intent for the chapters slice — anything that touches
    `activeStream`. Per-chapter row mutations (`applyGenerationTick`,
    `setChapters`, `hydrateFromBookState`, the regenerate* family,
    `mergeSubsetAnalysis`, `setChapterExcluded`) are NOT broadcast:
    those are per-tab UI state and broadcasting them would fan out
    side-effects that this plan explicitly does not solve (see Won't #3). */
const CHAPTERS_BROADCAST_ACTIONS: ReadonlySet<string> = new Set([
  'chapters/setActiveStream',
  'chapters/clearActiveStream',
  'chapters/updateActiveStreamProgress',
]);

/** Minimal slice shape the middleware reads from `getState()`. Declared
    locally to avoid a circular type back through `RootState`. */
interface BroadcastableRootState {
  analysis: { activeStream: AnalysisStreamSnapshot | null };
  chapters: { activeStream: ActiveStreamSnapshot | null };
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

/** Factory so tests can build the middleware against an injected
    channel + instanceId rather than the module-global ones. Production
    callers use `broadcastMiddleware` (the singleton below). */
export function createBroadcastMiddleware(opts?: {
  channel?: BroadcastChannel | null;
  instanceId?: string;
}): Middleware {
  return (store) => {
    const instanceId = opts?.instanceId ?? makeInstanceId();
    const channel: BroadcastChannel | null =
      opts?.channel !== undefined
        ? opts.channel
        : hasBroadcastChannel()
          ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
          : null;

    if (channel) {
      channel.onmessage = (ev: MessageEvent<BroadcastMessage>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        /* Echo suppression layer 1: drop messages we sent ourselves. */
        if (msg.instanceId === instanceId) return;
        if (msg.kind === 'sync:analysis') {
          store.dispatch(analysisActions.applyExternalAnalysisSnapshot(msg.snapshot));
          return;
        }
        if (msg.kind === 'sync:chapters') {
          store.dispatch(chaptersActions.applyExternalChaptersSnapshot(msg.snapshot));
          return;
        }
      };
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
        const msg: BroadcastMessage = {
          kind: 'sync:analysis',
          instanceId,
          bookId: snapshot?.bookId ?? null,
          snapshot,
        };
        try {
          channel.postMessage(msg);
        } catch (err) {
          /* postMessage can throw if the channel was closed under us
             (e.g. page unload races). Swallow — the cold-boot endpoint
             fallback is still the correctness floor. */
          console.warn('[broadcast] postMessage failed', err);
        }
        return result;
      }

      if (CHAPTERS_BROADCAST_ACTIONS.has(type)) {
        const state = store.getState() as BroadcastableRootState;
        const snapshot = state.chapters.activeStream;
        const msg: BroadcastMessage = {
          kind: 'sync:chapters',
          instanceId,
          bookId: snapshot?.bookId ?? null,
          snapshot,
        };
        try {
          channel.postMessage(msg);
        } catch (err) {
          console.warn('[broadcast] postMessage failed', err);
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
