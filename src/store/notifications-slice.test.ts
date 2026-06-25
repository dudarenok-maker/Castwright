// Pairs with docs/features/archive/48-toast-surface.md

import { describe, expect, it } from 'vitest';
import { notificationsSlice, notificationsActions, type VoiceNudge } from './notifications-slice';

const emptyState = () => ({ toasts: [] });

describe('notificationsSlice — pushToast', () => {
  it('appends a toast with a generated id and stamps createdAt', () => {
    const next = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({ kind: 'error', message: 'boom' }),
    );
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].kind).toBe('error');
    expect(next.toasts[0].message).toBe('boom');
    expect(typeof next.toasts[0].id).toBe('string');
    expect(next.toasts[0].id.length).toBeGreaterThan(0);
    expect(typeof next.toasts[0].createdAt).toBe('number');
    expect(next.toasts[0].dedupeKey).toBeUndefined();
  });

  it('stacks multiple toasts when no dedupeKey is set', () => {
    const state = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({ kind: 'error', message: 'first' }),
    );
    const next = notificationsSlice.reducer(
      state,
      notificationsActions.pushToast({ kind: 'info', message: 'second' }),
    );
    expect(next.toasts.map((t) => t.message)).toEqual(['first', 'second']);
    expect(next.toasts[0].id).not.toBe(next.toasts[1].id);
  });

  it('dedupes by key — second push with same key bumps createdAt instead of stacking', async () => {
    const state = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({
        kind: 'error',
        message: 'stream halted',
        dedupeKey: 'generation-stream',
      }),
    );
    const firstId = state.toasts[0].id;
    const firstCreatedAt = state.toasts[0].createdAt;

    // Wait a tick so Date.now() advances on the next push.
    await new Promise((r) => setTimeout(r, 5));

    const next = notificationsSlice.reducer(
      state,
      notificationsActions.pushToast({
        kind: 'error',
        message: 'stream halted again',
        dedupeKey: 'generation-stream',
      }),
    );
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].id).toBe(firstId);
    expect(next.toasts[0].createdAt).toBeGreaterThan(firstCreatedAt);
    expect(next.toasts[0].message).toBe('stream halted again');
  });

  it('dedupe overrides kind on a same-key bump', () => {
    const state = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({
        kind: 'warn',
        message: 'first',
        dedupeKey: 'export',
      }),
    );
    const next = notificationsSlice.reducer(
      state,
      notificationsActions.pushToast({
        kind: 'error',
        message: 'second',
        dedupeKey: 'export',
      }),
    );
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].kind).toBe('error');
    expect(next.toasts[0].message).toBe('second');
  });

  it('two pushes with different keys produce two independent toasts', () => {
    const state = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({ kind: 'error', message: 'a', dedupeKey: 'k1' }),
    );
    const next = notificationsSlice.reducer(
      state,
      notificationsActions.pushToast({ kind: 'warn', message: 'b', dedupeKey: 'k2' }),
    );
    expect(next.toasts).toHaveLength(2);
    expect(next.toasts.map((t) => t.dedupeKey).sort()).toEqual(['k1', 'k2']);
  });
});

describe('notificationsSlice — dismiss', () => {
  it('dismissToast removes the toast matching the id', () => {
    const state = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({ kind: 'info', message: 'first' }),
    );
    const id = state.toasts[0].id;
    const next = notificationsSlice.reducer(state, notificationsActions.dismissToast(id));
    expect(next.toasts).toHaveLength(0);
  });

  it('dismissToast with an unknown id is a no-op', () => {
    const state = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({ kind: 'info', message: 'first' }),
    );
    const next = notificationsSlice.reducer(state, notificationsActions.dismissToast('not-here'));
    expect(next.toasts).toHaveLength(1);
  });

  it('dismissByKey clears every toast carrying the given dedupeKey', () => {
    const s1 = notificationsSlice.reducer(
      emptyState(),
      notificationsActions.pushToast({ kind: 'error', message: 'one', dedupeKey: 'export' }),
    );
    const s2 = notificationsSlice.reducer(
      s1,
      notificationsActions.pushToast({ kind: 'warn', message: 'two' }),
    );
    const next = notificationsSlice.reducer(s2, notificationsActions.dismissByKey('export'));
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].message).toBe('two');
  });
});

const reduce = (actions: ReturnType<typeof notificationsActions.pushToast>[]) =>
  actions.reduce((s, a) => notificationsSlice.reducer(s, a), notificationsSlice.reducer(undefined, { type: '@@INIT' }));

const nudge = (over: Partial<VoiceNudge>): VoiceNudge => ({
  bookId: 'b1', modelKey: 'qwen3-tts-0.6b', characterIds: ['mara'], names: ['Mara'], ...over,
});

describe('notifications nudge merge-dedupe', () => {
  it('unions characterIds/names into an existing same-key nudge instead of overwriting', () => {
    const s = reduce([
      notificationsActions.pushToast({ kind: 'info', message: '1 needs a voice', dedupeKey: 'k', nudge: nudge({}) }),
      notificationsActions.pushToast({
        kind: 'info', message: '1 needs a voice', dedupeKey: 'k',
        nudge: nudge({ characterIds: ['tom'], names: ['Tom'] }),
      }),
    ]);
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].nudge?.characterIds).toEqual(['mara', 'tom']);
    expect(s.toasts[0].nudge?.names).toEqual(['Mara', 'Tom']);
  });

  it('does not duplicate an id already present in the existing nudge', () => {
    const s = reduce([
      notificationsActions.pushToast({ kind: 'info', message: 'x', dedupeKey: 'k', nudge: nudge({}) }),
      notificationsActions.pushToast({ kind: 'info', message: 'x', dedupeKey: 'k', nudge: nudge({}) }),
    ]);
    expect(s.toasts[0].nudge?.characterIds).toEqual(['mara']);
  });

  it('carries nudge on a fresh (non-dedupe) push', () => {
    const s = reduce([
      notificationsActions.pushToast({ kind: 'info', message: 'x', nudge: nudge({}) }),
    ]);
    expect(s.toasts[0].nudge?.characterIds).toEqual(['mara']);
  });
});
