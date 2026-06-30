/* Pairs with docs/features/archive/63-cross-tab-broadcast-sync.md and the
   diffing/debounce refinement from plan 89 C2.

   The broadcast middleware brokers the analysis + chapters activeStream
   snapshots across tabs via a BroadcastChannel. Tests cover:

   Plan 63 invariants:
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
      middleware still functions (no throw, store dispatches still flow).

   Plan 89 C2 refinements:
   6. Shallow diffing: after the initial `mode: 'full'` send, subsequent
      ticks emit only the fields that changed (`mode: 'diff'`).
   7. phaseProgress debounce: N progress-only ticks inside the debounce
      window coalesce into a single broadcast (the slowest non-progress
      tick wins, the rest are dropped on the wire).
   8. Round-trip: a recipient that applies the diff sequence reconstructs
      the sender's final activeStream byte-for-byte.
   9. Narrow-scope guard (plan 63): non-activeStream actions still never
      broadcast — the C2 diff lives inside the existing scope, never
      widens it. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  createBroadcastMiddleware,
  BROADCAST_CHANNEL_NAME,
  PROGRESS_DEBOUNCE_MS,
  type BroadcastMessage,
} from './broadcast-middleware';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
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

/** Test-only clock driver. Lets the middleware's debounce window advance in
 *  step with the test rather than racing the real timer. */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeStore(
  channel: BroadcastChannel | null,
  opts?: { instanceId?: string; now?: () => number; debounceMs?: number },
) {
  const middleware = createBroadcastMiddleware({
    channel,
    instanceId: opts?.instanceId ?? 'self-tab-id',
    now: opts?.now,
    debounceMs: opts?.debounceMs,
  });
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
  streamKey: 'book-X::1',
  bookId: 'book-X',
  chapterId: 1,
  modelKey: 'kokoro-v1',
  done: 0,
  total: 10,
  inProgress: 1,
  lastTickAt: 1000,
  halted: false,
};

describe('broadcastMiddleware — outbound (mode: full)', () => {
  let mock: ReturnType<typeof makeMockChannel>;

  beforeEach(() => {
    mock = makeMockChannel();
  });

  it('broadcasts the post-mutation analysis snapshot on setActiveStream as mode:full', () => {
    const store = makeStore(mock.channel);
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({
      kind: 'sync:analysis',
      instanceId: 'self-tab-id',
      bookId: 'book-X',
      mode: 'full',
      snapshot: analysisSnap,
    });
  });

  it('broadcasts the post-mutation chapters activeStream on setActiveStream as mode:full', () => {
    const store = makeStore(mock.channel);
    store.dispatch(chaptersActions.setActiveStream(chaptersSnap));
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({
      kind: 'sync:chapters',
      instanceId: 'self-tab-id',
      bookId: 'book-X',
      mode: 'full',
      snapshot: chaptersSnap,
    });
  });

  it('broadcasts a mode:clear message on clearActiveStream so siblings tear down their pill', () => {
    const store = makeStore(mock.channel);
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;
    store.dispatch(analysisActions.clearActiveStream());
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({
      kind: 'sync:analysis',
      mode: 'clear',
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

  it('plan 63 narrow-scope guard: per-chapter row mutations stay off the wire', () => {
    /* applyGenerationTick mutates `chapters[]` but is NOT in the broadcast
       rules table (intentionally narrow to avoid the backlog `fe-11` race case).
       Plan 89 C2 must NOT widen this — the diff scope is strictly inside
       activeStream. */
    const store = makeStore(mock.channel);
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

describe('broadcastMiddleware — outbound diffing (plan 89 C2)', () => {
  it('emits mode:diff with only the changed fields on a subsequent tick', () => {
    const clock = makeClock();
    /* Long debounce so we can isolate the diffing behaviour without
       progress-only ticks getting collapsed. */
    const mock = makeMockChannel();
    const store = makeStore(mock.channel, { now: clock.now, debounceMs: 250 });
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;
    /* Advance past the debounce window so the next tick is sent on its own. */
    clock.advance(500);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm-X',
        phaseId: 1,
        phaseLabel: 'Attributing sentences',
        lastTickAt: 2000,
      }),
    );
    expect(mock.sent).toHaveLength(1);
    const msg = mock.sent[0];
    expect(msg.kind).toBe('sync:analysis');
    expect(msg.mode).toBe('diff');
    if (msg.kind === 'sync:analysis' && msg.mode === 'diff') {
      /* Only the fields that actually changed should ride the wire. */
      expect(msg.diff).toEqual({
        phaseId: 1,
        phaseLabel: 'Attributing sentences',
        lastTickAt: 2000,
      });
      /* Fields that didn't change (bookTitle, manuscriptId, state, ...) are
         absent — the receiver reconstructs the rest from its existing
         activeStream. */
      expect(Object.keys(msg.diff)).not.toContain('bookTitle');
      expect(Object.keys(msg.diff)).not.toContain('manuscriptId');
    }
  });

  it('debounces phaseProgress-only ticks within PROGRESS_DEBOUNCE_MS', () => {
    const clock = makeClock();
    const mock = makeMockChannel();
    const store = makeStore(mock.channel, { now: clock.now, debounceMs: PROGRESS_DEBOUNCE_MS });
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;

    /* Five rapid progress-only ticks inside the window — only the first
       should escape (and only when the window has elapsed, which it
       has NOT here — they all land at t=0..40, well below 250 ms). */
    clock.advance(0);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm-X', phaseProgress: 0.1 }),
    );
    clock.advance(10);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm-X', phaseProgress: 0.2 }),
    );
    clock.advance(10);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm-X', phaseProgress: 0.3 }),
    );
    clock.advance(10);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm-X', phaseProgress: 0.4 }),
    );
    clock.advance(10);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm-X', phaseProgress: 0.5 }),
    );
    /* Window: [0, 250). Setup send was at t=0; nothing else has elapsed
       past the window. Expected: zero progress ticks broadcast (all
       collapsed by debounce). */
    expect(mock.sent).toHaveLength(0);

    /* Walk past the window, then fire one more progress-only tick: that
       one DOES send because the debounce window has elapsed. */
    clock.advance(PROGRESS_DEBOUNCE_MS + 50);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm-X', phaseProgress: 0.6 }),
    );
    expect(mock.sent).toHaveLength(1);
    const escapee = mock.sent[0];
    expect(escapee.kind).toBe('sync:analysis');
    if (escapee.kind === 'sync:analysis' && escapee.mode === 'diff') {
      expect(escapee.diff.phaseProgress).toBe(0.6);
    } else {
      throw new Error('expected sync:analysis diff');
    }
  });

  it('does NOT debounce a tick that mixes phaseProgress with a non-progress field', () => {
    /* phaseProgress + phaseId is NOT progress-only — phase transitions are
       structural and must reach the recipient immediately. */
    const clock = makeClock();
    const mock = makeMockChannel();
    const store = makeStore(mock.channel, { now: clock.now, debounceMs: PROGRESS_DEBOUNCE_MS });
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;

    clock.advance(10);
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm-X',
        phaseProgress: 0.5,
        phaseId: 2,
      }),
    );
    expect(mock.sent).toHaveLength(1);
    const msg = mock.sent[0];
    if (msg.kind === 'sync:analysis' && msg.mode === 'diff') {
      expect(msg.diff).toEqual({ phaseProgress: 0.5, phaseId: 2 });
    } else {
      throw new Error('expected sync:analysis diff');
    }
  });

  it('switches to mode:full when bookId changes (cross-book stream replacement)', () => {
    const clock = makeClock();
    const mock = makeMockChannel();
    const store = makeStore(mock.channel, { now: clock.now, debounceMs: 250 });
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;
    /* Open a fresh stream on a different book. */
    clock.advance(500);
    const sniperSnap: AnalysisStreamSnapshot = {
      ...analysisSnap,
      bookId: 'book-Y',
      manuscriptId: 'm-Y',
      bookTitle: 'Other Tale',
    };
    store.dispatch(analysisActions.setActiveStream(sniperSnap));
    expect(mock.sent).toHaveLength(1);
    const msg = mock.sent[0];
    expect(msg.kind).toBe('sync:analysis');
    expect(msg.mode).toBe('full');
    if (msg.kind === 'sync:analysis' && msg.mode === 'full') {
      expect(msg.snapshot).toEqual(sniperSnap);
    }
  });

  it('round-trip: applying the diff stream onto a recipient reconstructs the sender state byte-for-byte', () => {
    const clock = makeClock();
    const senderMock = makeMockChannel();
    const senderStore = makeStore(senderMock.channel, {
      instanceId: 'sender',
      now: clock.now,
      debounceMs: 0, // disable debounce so every tick is observed
    });
    const receiverMock = makeMockChannel();
    const receiverStore = makeStore(receiverMock.channel, {
      instanceId: 'receiver',
      now: clock.now,
      debounceMs: 0,
    });

    /* Open the stream then apply a sequence of ticks. */
    senderStore.dispatch(analysisActions.setActiveStream(analysisSnap));
    senderStore.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm-X',
        phaseProgress: 0.25,
        lastTickAt: 1500,
      }),
    );
    senderStore.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm-X',
        phaseId: 1,
        phaseLabel: 'Attributing sentences',
        phaseProgress: 0,
        lastTickAt: 2000,
      }),
    );
    senderStore.dispatch(
      analysisActions.bumpActiveStreamHeartbeat({ manuscriptId: 'm-X', lastTickAt: 2200 }),
    );

    /* Pipe every emitted message through the receiver's onmessage. */
    for (const msg of senderMock.sent) {
      (receiverMock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(msg);
    }

    /* `phaseElapsedMs` is intentionally NOT broadcast (heartbeat-frequency,
       tab-local cosmetic for the single-chapter subset pill ease), so the
       receiver legitimately won't reconstruct it. Compare everything else
       byte-for-byte. */
    const { phaseElapsedMs: _s, ...senderRest } =
      senderStore.getState().analysis.activeStream!;
    const { phaseElapsedMs: _r, ...receiverRest } =
      receiverStore.getState().analysis.activeStream!;
    expect(receiverRest).toEqual(senderRest);
  });

  it('skips empty diffs (a no-op reducer tick does not touch the wire)', () => {
    /* hydrateColdBoot is in the broadcast actions list but is a no-op when
       activeStream is already set. The middleware should observe no diff
       and NOT broadcast. */
    const clock = makeClock();
    const mock = makeMockChannel();
    const store = makeStore(mock.channel, { now: clock.now, debounceMs: 250 });
    store.dispatch(analysisActions.setActiveStream(analysisSnap));
    mock.sent.length = 0;
    clock.advance(500);
    store.dispatch(analysisActions.hydrateColdBoot(analysisSnap));
    expect(mock.sent).toHaveLength(0);
  });
});

describe('broadcastMiddleware — inbound', () => {
  let mock: ReturnType<typeof makeMockChannel>;

  beforeEach(() => {
    mock = makeMockChannel();
  });

  it('dispatches applyExternalAnalysisSnapshot on a sync:analysis full message from another tab', () => {
    const store = makeStore(mock.channel);
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        mode: 'full',
        snapshot: analysisSnap,
      },
    );
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    /* And does not re-broadcast — the inbound reducer is layer-2 echo-suppressed. */
    expect(mock.sent).toHaveLength(0);
  });

  it('applies a diff message onto the existing activeStream', () => {
    const store = makeStore(mock.channel);
    /* Seed via a `full` message first. */
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        mode: 'full',
        snapshot: analysisSnap,
      },
    );
    /* Now a diff message that only carries phaseProgress + lastTickAt. */
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        mode: 'diff',
        diff: { phaseProgress: 0.42, lastTickAt: 2000 },
      },
    );
    /* Reconstructed activeStream should keep all the un-diffed fields and
       update the diffed ones. */
    expect(store.getState().analysis.activeStream).toEqual({
      ...analysisSnap,
      phaseProgress: 0.42,
      lastTickAt: 2000,
    });
    expect(mock.sent).toHaveLength(0);
  });

  it('dispatches applyExternalChaptersSnapshot on a sync:chapters full message from another tab', () => {
    const store = makeStore(mock.channel);
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:chapters',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        mode: 'full',
        snapshot: chaptersSnap,
      },
    );
    expect(store.getState().chapters.activeStreams).toEqual({
      [chaptersSnap.streamKey]: chaptersSnap,
    });
    expect(mock.sent).toHaveLength(0);
  });

  it('handles mode:clear from a sibling tab (their stream ended)', () => {
    const store = makeStore(mock.channel);
    /* Seed first. */
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        mode: 'full',
        snapshot: analysisSnap,
      },
    );
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    /* Clear. */
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: null,
        mode: 'clear',
        snapshot: null,
      },
    );
    expect(store.getState().analysis.activeStream).toBeNull();
    expect(mock.sent).toHaveLength(0);
  });

  it('echo suppression: drops messages whose instanceId matches our own (no infinite ping-pong)', () => {
    const store = makeStore(mock.channel, { instanceId: 'self-tab-id' });
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
        mode: 'full',
        snapshot: spoofedSnapshot,
      },
    );
    expect(store.getState().analysis.activeStream).toEqual(before);
    expect(mock.sent).toHaveLength(0);
  });

  it('inbound from another tab does not re-broadcast (loop guard)', () => {
    const store = makeStore(mock.channel);
    (mock.channel as unknown as { simulateInbound: (m: BroadcastMessage) => void }).simulateInbound(
      {
        kind: 'sync:analysis',
        instanceId: 'OTHER-tab',
        bookId: 'book-X',
        mode: 'full',
        snapshot: analysisSnap,
      },
    );
    expect(mock.sent).toHaveLength(0);
    /* Sanity: store still works after inbound. */
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
  });

  it('cross-bookId: a sibling tab broadcasting bookId=Y replaces activeStream wholesale (no leakage into per-book per-chapter state)', () => {
    const store = makeStore(mock.channel);
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
        mode: 'full',
        snapshot: yokoSnap,
      },
    );
    expect(store.getState().analysis.activeStream).toEqual(yokoSnap);
    expect(store.getState().chapters.activeStreams).toEqual({});
    expect(mock.sent).toHaveLength(0);
  });

  it('ignores malformed inbound messages (defensive guard)', () => {
    const store = makeStore(mock.channel);
    const onmsg = (mock.channel as unknown as { onmessage: (e: MessageEvent) => void }).onmessage;
    onmsg({ data: null } as MessageEvent);
    onmsg({ data: { kind: 'sync:unknown', instanceId: 'x', bookId: null, mode: 'full' } } as MessageEvent);
    expect(store.getState().analysis.activeStream).toBeNull();
    expect(store.getState().chapters.activeStreams).toEqual({});
  });
});

describe('broadcastMiddleware — graceful degradation', () => {
  it('no-ops out when BroadcastChannel is unavailable (channel=null)', () => {
    const store = makeStore(null);
    expect(() => store.dispatch(analysisActions.setActiveStream(analysisSnap))).not.toThrow();
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    store.dispatch(analysisActions.clearActiveStream());
    expect(store.getState().analysis.activeStream).toBeNull();
  });

  it('swallows postMessage errors (e.g. channel closed mid-tick) without breaking the dispatch', () => {
    const mock = makeMockChannel();
    (mock.channel as unknown as { postMessage: (m: BroadcastMessage) => void }).postMessage = () => {
      throw new Error('Channel is closed');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(mock.channel);
    expect(() => store.dispatch(analysisActions.setActiveStream(analysisSnap))).not.toThrow();
    expect(store.getState().analysis.activeStream).toEqual(analysisSnap);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---- Task 9: sync:substage cross-tab broadcast ----

import { prosodySlice, prosodyActions } from './prosody-slice';
import { scriptReviewSlice } from './script-review-slice';

function harness(instanceId = 'self') {
  const posted: BroadcastMessage[] = [];
  const channel = {
    postMessage: (m: BroadcastMessage) => posted.push(m),
    onmessage: null as null | ((e: { data: BroadcastMessage }) => void),
    close: () => {},
  } as unknown as BroadcastChannel;
  const store = configureStore({
    reducer: { prosody: prosodySlice.reducer, scriptReview: scriptReviewSlice.reducer },
    middleware: (gdm) => gdm({ serializableCheck: false }).concat(createBroadcastMiddleware({ channel, instanceId })),
  });
  const inbound = (m: BroadcastMessage) => channel.onmessage!({ data: m } as MessageEvent);
  return { store, posted, inbound };
}

describe('broadcast-middleware sync:substage', () => {
  it('posts set on setActive and clear on clear (book taken from payload)', () => {
    const { store, posted } = harness();
    store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0.4, label: 'Detecting emotions' }));
    expect(posted.at(-1)).toMatchObject({ kind: 'sync:substage', stream: 'prosody', bookId: 'b1', mode: 'set', entry: { progress: 40, label: 'Detecting emotions' } });
    store.dispatch(prosodyActions.clear({ bookId: 'b1' }));
    expect(posted.at(-1)).toMatchObject({ kind: 'sync:substage', stream: 'prosody', bookId: 'b1', mode: 'clear' });
  });

  it('applies a foreign inbound set and does NOT re-broadcast', () => {
    const { store, posted, inbound } = harness('self');
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'bX', mode: 'set', entry: { progress: 22, label: 'Detecting emotions' } });
    expect(store.getState().prosody.activeStreams.bX).toEqual({ progress: 22, label: 'Detecting emotions' });
    expect(posted).toHaveLength(0); // applyExternalSet is not in the outbound match set
  });

  it('drops self-echo by instanceId', () => {
    const { store, inbound } = harness('self');
    inbound({ kind: 'sync:substage', instanceId: 'self', stream: 'prosody', bookId: 'bSelf', mode: 'set', entry: { progress: 5, label: 'x' } });
    expect(store.getState().prosody.activeStreams.bSelf).toBeUndefined();
  });

  it('a clear on book X leaves book Y intact (finding-2 regression)', () => {
    const { store, inbound } = harness('self');
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'b1', mode: 'set', entry: { progress: 1, label: 'x' } });
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'b2', mode: 'set', entry: { progress: 2, label: 'y' } });
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'b1', mode: 'clear' });
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
    expect(store.getState().prosody.activeStreams.b2).toEqual({ progress: 2, label: 'y' });
  });
});
