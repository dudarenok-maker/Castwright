// Pairs with docs/features/289-book-state-revision-precondition.md (C, T2)
import { describe, expect, it } from 'vitest';
import { createBookStateDisk } from './book-state-disk';

function seeded() {
  const disk = createBookStateDisk();
  disk.seed('b1', {
    state: { title: 'T0', author: 'A0' },
    manuscript: { sentences: [{ id: 1 }], mergedAwayKeys: ['1:2'] },
  });
  return disk;
}

describe('book-state disk model: server parity (plan 289, C)', () => {
  it('merges a partial state patch, skipping undefined fields', () => {
    const disk = seeded();
    disk.put('b1', { slice: 'state', patch: { title: 'T1', author: undefined } as never });
    expect(disk.books.get('b1')!.state).toEqual({ title: 'T1', author: 'A0' });
  });

  it('replaces the manuscript file: a patch without mergedAwayKeys drops the tombstones', () => {
    const disk = seeded();
    disk.put('b1', { slice: 'manuscript', patch: { sentences: [{ id: 3 }] } as never });
    expect(disk.books.get('b1')!.manuscript).toEqual({ sentences: [{ id: 3 }] });
  });

  it('answers 400 to a manuscript patch with no sentences, and writes nothing', () => {
    const disk = seeded();
    expect(() => disk.put('b1', { slice: 'manuscript', patch: { mergedAwayKeys: [] } as never })).toThrow(
      /\(400\)/,
    );
    expect(disk.books.get('b1')!.manuscript!.mergedAwayKeys).toEqual(['1:2']);
    expect(disk.log.at(-1)!.outcome).toBe('400');
  });

  it('checks only the carried fields: a stale uncarried field does not refuse', () => {
    const disk = seeded();
    const base = disk.revision('b1', 'state');
    disk.write('b1', 'state', { title: 'T0', author: 'Elsewhere' });
    disk.put('b1', { slice: 'state', patch: { title: 'T1' }, baseRevision: base } as never);
    expect(disk.books.get('b1')!.state).toEqual({ title: 'T1', author: 'Elsewhere' });
    let err: unknown;
    try {
      disk.put('b1', { slice: 'state', patch: { author: 'Mine' }, baseRevision: base } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'stale_revision', fields: ['author'] });
  });

  it('refuseNext answers a non-stale 409 with its code and writes nothing', () => {
    const disk = seeded();
    disk.refuseNext('book_path_taken');
    expect(() => disk.put('b1', { slice: 'state', patch: { title: 'T1' } } as never)).toThrow(
      expect.objectContaining({ code: 'book_path_taken', message: expect.stringContaining('(409)') }),
    );
    expect(disk.books.get('b1')!.state.title).toBe('T0');
    disk.put('b1', { slice: 'state', patch: { title: 'T1' } } as never);
    expect(disk.log.map((p) => p.outcome)).toEqual(['refused', 'ok']);
  });

  it('loseResponse writes, then fails with a 503', () => {
    const disk = seeded();
    disk.loseResponse(1);
    expect(() => disk.put('b1', { slice: 'state', patch: { title: 'T1' } } as never)).toThrow(/\(503\)/);
    expect(disk.books.get('b1')!.state.title).toBe('T1');
    expect(disk.log.at(-1)!.outcome).toBe('lost');
  });

  it('hold keeps a served PUT in transit until released, and maxInTransit counts the overlap', async () => {
    const disk = seeded();
    const release = disk.hold();
    const held = disk.serve('b1', { slice: 'state', patch: { title: 'T1' } } as never);
    await Promise.resolve();
    expect(disk.books.get('b1')!.state.title).toBe('T0');
    await disk.serve('b1', { slice: 'state', patch: { author: 'A1' } } as never);
    expect(disk.maxInTransit('b1', 'state')).toBe(2);
    release();
    await held;
    expect(disk.books.get('b1')!.state).toEqual({ title: 'T1', author: 'A1' });
  });

  it('hold afterWrite lands the write at once and holds only the answer', async () => {
    const disk = seeded();
    const release = disk.hold(undefined, { afterWrite: true });
    let answered = false;
    const held = disk.serve('b1', { slice: 'state', patch: { title: 'T1' } } as never).then(() => {
      answered = true;
    });
    await Promise.resolve();
    expect(disk.books.get('b1')!.state.title).toBe('T1');
    expect(answered).toBe(false);
    release();
    await held;
    expect(answered).toBe(true);
    expect(disk.maxInTransit('b1', 'state')).toBe(1);
  });

  /* #3784 pass 13, C1 — `put` cannot hold a PUT, so a test whose PUTs bypass
     `serve` would see its hold do nothing. It throws instead. */
  it('a PUT that matches a hold but is made through put throws, and writes nothing', () => {
    const disk = seeded();
    disk.hold((id, req) => id === 'b1' && req.slice === 'state');
    expect(() => disk.put('b1', { slice: 'state', patch: { title: 'T1' } } as never)).toThrow(/disk\.serve/);
    expect(disk.books.get('b1')!.state.title).toBe('T0');
    expect(disk.log).toEqual([]);
    disk.put('b1', { slice: 'cast', patch: { characters: [] } } as never);
    expect(disk.log.at(-1)!.outcome).toBe('ok');
  });
});
