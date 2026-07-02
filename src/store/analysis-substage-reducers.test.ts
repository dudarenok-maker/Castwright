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
