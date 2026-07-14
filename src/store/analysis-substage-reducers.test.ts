import { describe, it, expect } from 'vitest';
import {
  setActiveSubstage,
  updateSubstageProgress,
  type SetActiveSubstagePayload,
  type UpdateSubstageProgressPayload,
} from './analysis-substage-reducers';
import type { SubstageEntry } from './prosody-slice';

describe('setActiveSubstage', () => {
  it('stores a rounded-percent entry keyed by bookId', () => {
    const state: Record<string, SubstageEntry> = {};
    setActiveSubstage(state, { bookId: 'b1', progress: 0.5, label: 'Detecting emotions' });
    expect(state.b1).toEqual<SubstageEntry>({ progress: 50, label: 'Detecting emotions' });
  });

  it('stores optional fields only when provided', () => {
    const state: Record<string, SubstageEntry> = {};
    setActiveSubstage(state, {
      bookId: 'b1',
      progress: 0,
      label: 'Detecting emotions',
      chapterIndex: 1,
      totalChapters: 12,
    });
    expect(state.b1).toEqual<SubstageEntry>({
      progress: 0,
      label: 'Detecting emotions',
      chapterIndex: 1,
      totalChapters: 12,
    });
  });

  it('fully REPLACES an existing entry rather than merging', () => {
    const state: Record<string, SubstageEntry> = {
      b1: { progress: 10, label: 'old', chapterIndex: 3, totalChapters: 9, estRemainingMs: 5000 },
    };
    const payload: SetActiveSubstagePayload = { bookId: 'b1', progress: 0.2, label: 'new' };
    setActiveSubstage(state, payload);
    expect(state.b1).toEqual<SubstageEntry>({ progress: 20, label: 'new' });
  });

  it('only touches the named bookId', () => {
    const state: Record<string, SubstageEntry> = { b2: { progress: 0, label: 'y' } };
    setActiveSubstage(state, { bookId: 'b1', progress: 0, label: 'x' });
    expect(state.b2).toEqual<SubstageEntry>({ progress: 0, label: 'y' });
  });
});

describe('updateSubstageProgress', () => {
  it('is a no-op when the book has no active entry', () => {
    const state: Record<string, SubstageEntry> = {};
    updateSubstageProgress(state, { bookId: 'b1', progress: 0.5 });
    expect(state.b1).toBeUndefined();
  });

  it('updates only the fields present in the payload, preserving the rest', () => {
    const state: Record<string, SubstageEntry> = {
      b1: {
        progress: 0,
        label: 'Detecting emotions',
        chapterIndex: 1,
        totalChapters: 12,
      },
    };
    const payload: UpdateSubstageProgressPayload = {
      bookId: 'b1',
      progress: 0.5,
      estRemainingMs: 60_000,
    };
    updateSubstageProgress(state, payload);
    expect(state.b1).toEqual<SubstageEntry>({
      progress: 50,
      label: 'Detecting emotions',
      chapterIndex: 1,
      totalChapters: 12,
      estRemainingMs: 60_000,
    });

    updateSubstageProgress(state, {
      bookId: 'b1',
      progress: 0.6,
      chapterIndex: 2,
      label: 'Detecting instruct',
    });
    expect(state.b1).toEqual<SubstageEntry>({
      progress: 60,
      label: 'Detecting instruct',
      chapterIndex: 2,
      totalChapters: 12,
      estRemainingMs: 60_000, // untouched — this update didn't carry a new one
    });
  });

  it('only touches the named bookId', () => {
    const state: Record<string, SubstageEntry> = {
      b1: { progress: 0, label: 'x' },
      b2: { progress: 0, label: 'y' },
    };
    updateSubstageProgress(state, { bookId: 'b1', progress: 0.42 });
    expect(state.b1.progress).toBe(42);
    expect(state.b2.progress).toBe(0);
  });
});

describe('substage reducers — heartbeat/model fields', () => {
  it('updateSubstageProgress merges model/engine/activityState and stamps activitySince on state change', () => {
    const state: Record<string, SubstageEntry> = {
      b1: { progress: 0, label: 'Reviewing script' },
    };
    updateSubstageProgress(state, {
      bookId: 'b1', progress: 0, activityState: 'waiting', model: 'qwen3.5:9b', engine: 'local', now: 1000,
    });
    expect(state.b1.activityState).toBe('waiting');
    expect(state.b1.activitySince).toBe(1000);
    expect(state.b1.model).toBe('qwen3.5:9b');
    expect(state.b1.engine).toBe('local');
  });

  it('re-stamps activitySince only when activityState actually changes', () => {
    const state: Record<string, SubstageEntry> = {
      b1: { progress: 10, label: 'Reviewing script', activityState: 'streaming', activitySince: 1000 },
    };
    // same state, later tick — must NOT move activitySince (progress is a 0..1 fraction)
    updateSubstageProgress(state, { bookId: 'b1', progress: 0.2, activityState: 'streaming', now: 5000 });
    expect(state.b1.activitySince).toBe(1000);
    // transition — must re-stamp
    updateSubstageProgress(state, { bookId: 'b1', progress: 0.2, activityState: 'waiting', now: 6000 });
    expect(state.b1.activitySince).toBe(6000);
  });

  it('sets fallbackActive and does not lose it on later merges', () => {
    const state: Record<string, SubstageEntry> = { b1: { progress: 0, label: 'x' } };
    updateSubstageProgress(state, { bookId: 'b1', progress: 0, fallbackActive: true, engine: 'gemini', model: 'gemma-4-31b-it' });
    updateSubstageProgress(state, { bookId: 'b1', progress: 5 }); // bare progress tick
    expect(state.b1.fallbackActive).toBe(true);
    expect(state.b1.engine).toBe('gemini');
  });
});
