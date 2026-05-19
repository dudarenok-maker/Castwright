/* Pairs with docs/features/63-cross-tab-broadcast-sync.md.

   The broadcast middleware brokers the analysis + chapters activeStream
   snapshots across tabs via a BroadcastChannel. Tests cover the four
   acceptance cases pinned by the plan:

   1. Outbound: a mutating action on the analysis / chapters activeStream
      reaches the channel's postMessage with a snapshot derived from
      post-mutation state.
   2. Inbound: a `message` event with the right kind drives the
      corresponding `applyExternal*Snapshot` reducer without re-broadcasting.
   3. Echo suppression: a message whose `instanceId` matches our own is
      dropped (no inbound dispatch, no infinite ping-pong).
   4. Cross-bookId isolation: tab A's bookId=X snapshot does not
      contaminate a sibling tab's per-book per-chapter state — only the
      activeStream slot is mirrored (per-chapter rows / cast / manuscript
      are NOT broadcast).
   5. Graceful degradation: when BroadcastChannel is missing, the
      middleware still functions (no throw, store dispatches still flow). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  createBroadcastMiddleware,
  BROADCAST_CHANNEL_NAME,
  type BroadcastMessage,
} from './broadcast-middleware';
import {
  analysisSlice,
  analysisActions,
  type AnalysisStreamSnapshot,
} from './analysis-slice';
import { chaptersSlice, chaptersActions, type ActiveStreamSnapshot } from './chapters-slice';

/* Minimal mock channel — collects postMessage calls and exposes a
   `simulateInbound` hook to dispatch into the registered `onmessage`. */
function makeMockChannel() {
  let onmessage: ((ev: MessageEvent<BroadcastMessage>) => void) | null = null;
  const sent: BroadcastMessage[] = [];
  const channel = {
    name: BROADCAST_CHANNEL_NAME,
    set onmessage(cb: ((ev: MessageEvent<BroadcastMessage>) => void) | null) {
      onmessage = cb;
    },
    get onmessage() {
      return onmessage;
    },
    postMessage(msg: BroadcastMessage) {
      sent.push(msg);
    },
    close() {
      onmessage = null;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as BroadcastChannel & {
    /** Test-only — fire the registered onmessage with an incoming payload. */
    simulateInbound: (msg: BroadcastMessage) => void;
  };
  (channel as unknown as { simulateInbound: (msg: BroadcastMessage) => void }).simulateInbound = (
    msg,
  ) => {
    onmessage?.({ data: msg } as MessageEvent<BroadcastMessage>);
  };
  return { channel, sent };
}

function makeStore(channel: BroadcastChannel | null, instanceId = 'self-tab-id') {
  const middleware = createBroadcastMiddleware({ channel, instanceId });
  return configureStore({
    reducer: {
      analysis: analysisSlice.reducer,
      chapters: chaptersSlice.reducer,
    },
    middleware: (getDefault) => getDefault().concat(middleware),
  });
}

const analysisSnap: AnalysisStreamSnapshot = {
  bookId: 'book-X',
  manuscriptId: 'm-X',
  bookTitle: 'A Tale',
  phaseId: 0,
  phaseLabel: 'Detecting characters',
  phaseProgress: 0,
  remainingMs: null,
  lastTickAt: 1000,
  state: 'running',
};

const chaptersSnap: ActiveStreamSnapshot = {
  bookId: 'book-X',
  modelKey: 'kokoro-v1',
  done: 0,
  total: 10,
  inProgress: 1,
  lastTickAt: 1000,
  halted: false,
};

describe('broadcastMiddleware — outbound', () => {
  let mock: ReturnType<typeof makeMockChannel>;

  beforeEach(() => {
    mock = makeMockChannel();
  });

  it('broadcasts the post-mutation analysis snapshot on setActiveStream', () => {
    const store = makeStore(mock.channel);
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({
      kind: 'sync:analysis',
      instanceId: 'self-tab-id',
      bookId: 'book-X',
      snapshot: analysisSnap,
    });
  });

  it('broadcasts the post-mutation chapters activeStream on setActiveStream', () => {
    const store = makeStore(mock.channel);
    store.dispatch(chaptersActions.setActiveStream(chaptersSnap));
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({
      kind: 'sync:chapters',
      instanceId: 'self-tab-id',
      bookId: 'book-X',
      snapshot: chaptersSnap,
    });
  });

  it('broadcasts the latest derived snapshot on a tick action — not the action payload', () => {
    const store = makeStore(mock.channel);
    /* Open the stream then tick — the tick payload is partial
       (phaseProgress only); the broadcast must reflect the merged
       slice state, not the action.payload. */
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm-X',
        phaseProgress: 0.42,
        lastTickAt: 2000,
      }),
    );
    expect(mock.sent).toHaveLength(1);
    const msg = mock.sent[0];
    expect(msg.kind).toBe('sync:analysis');
    if (msg.kind === 'sync:analysis') {
      expect(msg.snapshot?.phaseProgress).toBe(0.42);
      expect(msg.snapshot?.lastTickAt).toBe(2000);
      /* Untouched fields survive in the broadcast — proves we send post-merge state. */
      expect(msg.snapshot?.bookTitle).toBe('A Tale');
    }
  });

  it('broadcasts a null snapshot on clearActiveStream so siblings tear down their pill', () => {
    const store = makeStore(mock.channel);
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;
    store.dispatch(analysisActions.clearActiveStream());
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({
      kind: 'sync:analysis',
      snapshot: null,
      bookId: null,
    });
  });

  it('does NOT broadcast non-cross-tab-relevant actions (analysis-slice noise)', () => {
    const store = makeStore(mock.channel);
    /* Dispatch an unrelated action; should not touch the channel. */
    store.dispatch({ type: 'analysis/unrelated' });
    expect(mock.sent).toHaveLength(0);
  });

  it('does NOT broadcast per-chapter row mutations — only activeStream is in scope', () => {
    const store = makeStore(mock.channel);
    /* applyGenerationTick mutates `chapters[]` but is NOT in the broadcast
       rules table (intentionally narrow to avoid the Won't #3 race case). */
    store.dispatch(
      chaptersActions.applyGenerationTick({ type: 'idle' } as Parameters<
        typeof chaptersActions.applyGenerationTick
      >[0]),
    );
    expect(mock.sent).toHaveLength(0);
  });

  it('does NOT re-broadcast the inbound applyExternal* reducers (echo-suppression layer 2)', () => {
    const store = makeStore(mock.channel);
    store.dispatch(analysisActions.applyExternalAnalysisSnapshot(analysisSnap));
    store.dispatch(chaptersActions.applyExternalChaptersSnapshot(chaptersSnap));
    expect(mock.sent).toHaveLength(0);
  });
});

describe('broadcastMiddleware — inbound', () => {
  let mock: ReturnType<typeof makeMockChannel>;

  beforeEach(() => {
    mock = makeMockChannel();
  });

  it('dispatches applyExternalAnalysisSnapshot on a sync:analysis message from another tab', () => {
    const store = makeStore(mock.channel);
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        snapshot: analysisSnap,
      },
    );
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    /* And does not re-broadcast — the inbound reducer is layer-2 echo-suppressed. */
    expect(mock.sent).toHaveLength(0);
  });

  it('dispatches applyExternalChaptersSnapshot on a sync:chapters message from another tab', () => {
    const store = makeStore(mock.channel);
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:chapters',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        snapshot: chaptersSnap,
      },
    );
    expect(store.getState().chapters.activeStream).toEqual(chaptersSnap);
    expect(mock.sent).toHaveLength(0);
  });

  it('echo suppression: drops messages whose instanceId matches our own (no infinite ping-pong)', () => {
    const store = makeStore(mock.channel, 'self-tab-id');
    /* Seed some state so a misfire would be visible. */
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    const before = store.getState().analysis.activeStream;
    mock.sent.length = 0;
    /* A spoofed inbound message tagged with our own instanceId must be ignored. */
    const spoofedSnapshot: AnalysisStreamSnapshot = {
      ...analysisSnap,
      bookTitle: 'should-not-leak',
      phaseProgress: 0.99,
    };
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'self-tab-id',
        bookId: 'book-X',
        snapshot: spoofedSnapshot,
      },
    );
    expect(store.getState().analysis.activeStream).toEqual(before);
    expect(mock.sent).toHaveLength(0);
  });

  it('inbound from another tab does not re-broadcast (loop guard)', () => {
    /* Layered guarantee: even when an inbound message lands legitimately,
       the dispatched applyExternal* reducer must not appear on the
       channel — otherwise tab A → tab B → tab A → ... loops forever. */
    const store = makeStore(mock.channel);
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        snapshot: analysisSnap,
      },
    );
    expect(mock.sent).toHaveLength(0);
    /* Sanity: store still works after inbound. */
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
  });

  it('cross-bookId: a sibling tab broadcasting bookId=Y replaces activeStream wholesale (the snapshot carries its own bookId — no leakage into per-book per-chapter state)', () => {
    const store = makeStore(mock.channel);
    /* Tab is currently snapshotting book-X. */
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    const yokoSnap: AnalysisStreamSnapshot = {
      ...analysisSnap,
      bookId: 'book-Y',
      manuscriptId: 'm-Y',
      bookTitle: 'Sibling Book',
    };
    mock.sent.length = 0;
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-Y',
        snapshot: yokoSnap,
      },
    );
    /* activeStream now reflects book-Y — the pill shows the sibling tab's
       run. Crucially, no per-book state was touched: the chapters slice
       (where per-chapter rows / cast IDs live in production) is
       untouched because the inbound message only targets the analysis
       activeStream slot. */
    expect(store.getState().analysis.activeStream).toEqual(yokoSnap);
    expect(store.getState().chapters.activeStream).toBeNull();
    /* And we did not re-broadcast the inbound. */
    expect(mock.sent).toHaveLength(0);
  });

  it('ignores malformed inbound messages (defensive guard)', () => {
    const store = makeStore(mock.channel);
    const onmsg = (mock.channel as unknown as { onmessage: (e: MessageEvent) => void }).onmessage;
    /* Null payload. */
    onmsg({ data: null } as MessageEvent);
    /* Unknown kind. */
    onmsg({ data: { kind: 'sync:unknown', instanceId: 'x', bookId: null, snapshot: null } } as MessageEvent);
    expect(store.getState().analysis.activeStream).toBeNull();
    expect(store.getState().chapters.activeStream).toBeNull();
  });
});

describe('broadcastMiddleware — graceful degradation', () => {
  it('no-ops out when BroadcastChannel is unavailable (channel=null)', () => {
    /* Simulate "BroadcastChannel is undefined" by passing channel: null
       explicitly. The middleware still composes into a working store. */
    const store = makeStore(null);
    /* Dispatch flows through and mutates state. */
    expect(() => store.dispatch(analysisActions.setActiveStream(analysisSnap))).not.toThrow();
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    /* clearActiveStream still works too. */
    store.dispatch(analysisActions.clearActiveStream());
    expect(store.getState().analysis.activeStream).toBeNull();
  });

  it('swallows postMessage errors (e.g. channel closed mid-tick) without breaking the dispatch', () => {
    const mock = makeMockChannel();
    /* Make postMessage throw. */
    (mock.channel as unknown as { postMessage: (m: BroadcastMessage) => void }).postMessage = () => {
      throw new Error('Channel is closed');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(mock.channel);
    expect(() => store.dispatch(analysisActions.setActiveStream(analysisSnap))).not.toThrow();
    /* Reducer still ran. */
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
