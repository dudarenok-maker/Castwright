import { describe, it, expect } from 'vitest';
import { prosodySlice, prosodyActions, type SubstageEntry } from './prosody-slice';

const reduce = (actions: { type: string; payload?: unknown }[]) =>
  actions.reduce((s, a) => prosodySlice.reducer(s, a), prosodySlice.getInitialState());

describe('prosody-slice (per-book map)', () => {
  it('setActive stores a rounded-percent entry keyed by bookId', () => {
    const s = reduce([prosodyActions.setActive({ bookId: 'b1', progress: 0.5, label: 'Detecting emotions' })]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({ progress: 50, label: 'Detecting emotions' });
  });

  it('updateProgress only touches the named book', () => {
    const s = reduce([
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Detecting emotions' }),
      prosodyActions.setActive({ bookId: 'b2', progress: 0, label: 'Detecting emotions' }),
      prosodyActions.updateProgress({ bookId: 'b1', progress: 0.42 }),
    ]);
    expect(s.activeStreams.b1.progress).toBe(42);
    expect(s.activeStreams.b2.progress).toBe(0);
  });

  it('clear removes only the named book, leaving others intact', () => {
    const s = reduce([
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'x' }),
      prosodyActions.setActive({ bookId: 'b2', progress: 0, label: 'y' }),
      prosodyActions.clear({ bookId: 'b1' }),
    ]);
    expect(s.activeStreams.b1).toBeUndefined();
    expect(s.activeStreams.b2).toBeDefined();
  });

  it('applyExternalSet / applyExternalClear touch only the named key', () => {
    const s1 = reduce([prosodyActions.applyExternalSet({ bookId: 'b9', entry: { progress: 30, label: 'Detecting emotions' } })]);
    expect(s1.activeStreams.b9).toEqual({ progress: 30, label: 'Detecting emotions' });
    const s2 = prosodySlice.reducer(s1, prosodyActions.applyExternalClear({ bookId: 'b9' }));
    expect(s2.activeStreams.b9).toBeUndefined();
  });
});
