import { describe, it, expect } from 'vitest';
import { buildPersistedHints, hintsFromPersisted, sha256Hex, MANUSCRIPT_HINTS_SCHEMA } from './manuscript-hints.js';

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

describe('hintsFromPersisted', () => {
  const state = {
    manuscriptId: 'm1',
    manuscriptFile: 'manuscript.md',
    chapters: [
      { id: 1, uuid: 'u1', title: 'Gamma', titleSynthesized: true },
      { id: 2, uuid: 'u2', title: 'Alpha', excluded: true },
      { id: 3, uuid: 'u3', title: 'Beta' },
    ],
  };
  const good = () => ({
    schema: 1,
    manuscriptId: 'm1',
    manuscriptFile: 'manuscript.md',
    sourceSha256: 'abc',
    writtenAt: 'now',
    chapters: [
      { id: 1, uuid: 'u1', body: 'g' },
      { id: 2, uuid: 'u2', body: 'a' },
      { id: 3, uuid: 'u3', body: 'b' },
    ],
  });
  const run = (file: unknown, st: typeof state = state, sha = 'abc') =>
    hintsFromPersisted(file, st, sha);

  it('takes bodies from the file and titles / flags from state', () => {
    const r = run(good());
    expect(r).toEqual({
      ok: true,
      hints: [
        { id: 1, title: 'Gamma', body: 'g', titleSynthesized: true, excluded: undefined },
        { id: 2, title: 'Alpha', body: 'a', excluded: true },
        { id: 3, title: 'Beta', body: 'b', excluded: undefined },
      ],
    });
  });

  it.each([
    ['wrong schema', (f: any) => { f.schema = 2; }],
    ['wrong manuscriptId', (f: any) => { f.manuscriptId = 'other'; }],
    ['wrong manuscriptFile', (f: any) => { f.manuscriptFile = 'other.md'; }],
    ['wrong sourceSha256', (f: any) => { f.sourceSha256 = 'zzz'; }],
    ['length mismatch', (f: any) => { f.chapters.pop(); }],
    ['id mismatch at one position', (f: any) => { f.chapters[1].id = 9; }],
    ['uuid mismatch at one position', (f: any) => { f.chapters[2].uuid = 'ux'; }],
    ['uuids swapped (reorder shape)', (f: any) => {
      [f.chapters[0].uuid, f.chapters[1].uuid] = [f.chapters[1].uuid, f.chapters[0].uuid];
    }],
    ['non-string body', (f: any) => { f.chapters[0].body = 5; }],
  ])('rejects: %s', (_name, mutate) => {
    const f = good();
    mutate(f);
    const r = run(f);
    expect(r.ok).toBe(false);
  });

  it('rejects a state chapter with no uuid', () => {
    const st = { ...state, chapters: [{ id: 1, title: 'x' }, ...state.chapters.slice(1)] };
    const f = good();
    f.chapters[0].uuid = '';
    expect(run(f, st as never).ok).toBe(false);
  });

  it.each([null, undefined, 'str', 7, []])('rejects a non-object file: %j', (f) => {
    expect(run(f).ok).toBe(false);
  });
});
