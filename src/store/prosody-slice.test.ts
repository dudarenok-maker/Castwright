/* Task 14 (fs-65 Phase 3) — prosody-slice unit tests.
   TDD: set/update/clear actions; confirms TRANSIENT invariant (not in
   persistence-middleware or broadcast-middleware). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prosodySlice, prosodyActions } from './prosody-slice';

describe('prosodySlice — activeStream reducers', () => {
  it('starts with activeStream: null', () => {
    const state = prosodySlice.reducer(undefined, { type: 'noop' });
    expect(state.activeStream).toBeNull();
  });

  it('setActive sets the stream with progress and label', () => {
    const state = prosodySlice.reducer(
      undefined,
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Phase 3 — Detecting prosody' }),
    );
    expect(state.activeStream).toEqual({
      bookId: 'b1',
      progress: 0,
      label: 'Phase 3 — Detecting prosody',
    });
  });

  it('updateProgress updates progress for the matching bookId (fraction 0..1 → rounded 0..100)', () => {
    const s1 = prosodySlice.reducer(
      undefined,
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Phase 3 — Detecting prosody' }),
    );
    const s2 = prosodySlice.reducer(s1, prosodyActions.updateProgress({ bookId: 'b1', progress: 0.42 }));
    expect(s2.activeStream?.progress).toBe(42);
  });

  it('updateProgress is a no-op when bookId does not match', () => {
    const s1 = prosodySlice.reducer(
      undefined,
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Phase 3 — Detecting prosody' }),
    );
    const s2 = prosodySlice.reducer(s1, prosodyActions.updateProgress({ bookId: 'b2', progress: 0.9 }));
    expect(s2.activeStream?.progress).toBe(0);
  });

  it('clear sets activeStream to null', () => {
    const s1 = prosodySlice.reducer(
      undefined,
      prosodyActions.setActive({ bookId: 'b1', progress: 50, label: 'Phase 3 — Detecting prosody' }),
    );
    const s2 = prosodySlice.reducer(s1, prosodyActions.clear());
    expect(s2.activeStream).toBeNull();
  });

  it('updateProgress rounds the fraction to the nearest integer percent', () => {
    const s1 = prosodySlice.reducer(
      undefined,
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Phase 3' }),
    );
    const s2 = prosodySlice.reducer(s1, prosodyActions.updateProgress({ bookId: 'b1', progress: 0.999 }));
    expect(s2.activeStream?.progress).toBe(100);
    const s3 = prosodySlice.reducer(s1, prosodyActions.updateProgress({ bookId: 'b1', progress: 0.005 }));
    expect(s3.activeStream?.progress).toBe(1);
  });
});

/* Transient invariant: confirm prosody is NOT wired in persistence-middleware
   or broadcast-middleware by reading their source files directly. */
describe('prosodySlice — transient invariant (not persisted, not broadcast)', () => {
  const storeDir = join(__dirname, '.');

  it('prosody-slice is NOT referenced in persistence-middleware', () => {
    const src = readFileSync(join(storeDir, 'persistence-middleware.ts'), 'utf8');
    expect(src).not.toContain('prosody');
  });

  it('prosody-slice is NOT referenced in broadcast-middleware', () => {
    const src = readFileSync(join(storeDir, 'broadcast-middleware.ts'), 'utf8');
    expect(src).not.toContain('prosody');
  });
});
