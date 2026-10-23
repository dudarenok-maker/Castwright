import { describe, it, expect } from 'vitest';
import { buildPersistedHints, sha256Hex, MANUSCRIPT_HINTS_SCHEMA } from './manuscript-hints.js';

const base = { manuscriptId: 'm1', manuscriptFile: 'manuscript.md', sourceSha256: 'abc' };

describe('sha256Hex', () => {
  it('hashes a known buffer', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('buildPersistedHints', () => {
  it('pairs by id and emits in stateChapters order', () => {
    const out = buildPersistedHints({
      ...base,
      hints: [
        { id: 1, body: 'one' },
        { id: 2, body: 'two' },
        { id: 3, body: 'three' },
      ],
      stateChapters: [
        { id: 3, uuid: 'u3' },
        { id: 1, uuid: 'u1' },
        { id: 2, uuid: 'u2' },
      ],
    });
    expect(out.schema).toBe(MANUSCRIPT_HINTS_SCHEMA);
    expect(out.manuscriptId).toBe('m1');
    expect(out.manuscriptFile).toBe('manuscript.md');
    expect(out.sourceSha256).toBe('abc');
    expect(out.chapters).toEqual([
      { id: 3, uuid: 'u3', body: 'three' },
      { id: 1, uuid: 'u1', body: 'one' },
      { id: 2, uuid: 'u2', body: 'two' },
    ]);
  });

  it('throws on a count mismatch', () => {
    expect(() =>
      buildPersistedHints({
        ...base,
        hints: [{ id: 1, body: 'one' }],
        stateChapters: [
          { id: 1, uuid: 'u1' },
          { id: 2, uuid: 'u2' },
        ],
      }),
    ).toThrow();
  });

  it('throws when a hint id has no state chapter', () => {
    expect(() =>
      buildPersistedHints({
        ...base,
        hints: [
          { id: 1, body: 'one' },
          { id: 9, body: 'nine' },
        ],
        stateChapters: [
          { id: 1, uuid: 'u1' },
          { id: 2, uuid: 'u2' },
        ],
      }),
    ).toThrow();
  });

  it('throws when a state chapter has no uuid', () => {
    expect(() =>
      buildPersistedHints({
        ...base,
        hints: [{ id: 1, body: 'one' }],
        stateChapters: [{ id: 1 }],
      }),
    ).toThrow();
  });
});
