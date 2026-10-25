/* srv-35 (plan 190) — lazy-migration + anti-strip primitives for the
 * immutable per-chapter `uuid`. Pure functions, no I/O. */

import { describe, it, expect } from 'vitest';
import {
  ensureChapterUuids,
  reconcileChapterUuids,
  carryTitleSynthesized,
  carryServerOwnedChapterFields,
} from './chapter-uuid.js';
import type { BookStateJson } from './scan.js';

type Chapter = BookStateJson['chapters'][number];

function ch(partial: Partial<Chapter> & { id: number }): Chapter {
  return {
    title: `Chapter ${partial.id}`,
    slug: `${String(partial.id).padStart(2, '0')}-chapter-${partial.id}`,
    ...partial,
  };
}

function state(chapters: Chapter[]): BookStateJson {
  return {
    bookId: 'b',
    manuscriptId: 'm',
    title: 'T',
    author: 'A',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters,
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ensureChapterUuids', () => {
  it('mints a uuid for every chapter missing one and reports changed', () => {
    const s = state([ch({ id: 1 }), ch({ id: 2 })]);

    const changed = ensureChapterUuids(s);

    expect(changed).toBe(true);
    expect(s.chapters[0].uuid).toMatch(UUID_RE);
    expect(s.chapters[1].uuid).toMatch(UUID_RE);
    expect(s.chapters[0].uuid).not.toBe(s.chapters[1].uuid);
  });

  it('is idempotent — a second pass mints nothing and reports unchanged', () => {
    const s = state([ch({ id: 1 }), ch({ id: 2 })]);
    ensureChapterUuids(s);
    const first = s.chapters.map((c) => c.uuid);

    const changed = ensureChapterUuids(s);

    expect(changed).toBe(false);
    expect(s.chapters.map((c) => c.uuid)).toEqual(first);
  });

  it('never overwrites an existing uuid', () => {
    const s = state([ch({ id: 1, uuid: 'keep-me' }), ch({ id: 2 })]);

    const changed = ensureChapterUuids(s);

    expect(changed).toBe(true); // ch 2 was minted
    expect(s.chapters[0].uuid).toBe('keep-me');
    expect(s.chapters[1].uuid).toMatch(UUID_RE);
  });

  it('mints for excluded chapters too (they can be re-included)', () => {
    const s = state([ch({ id: 1, excluded: true })]);

    ensureChapterUuids(s);

    expect(s.chapters[0].uuid).toMatch(UUID_RE);
  });
});

describe('reconcileChapterUuids', () => {
  it('carries each chapter uuid from the existing chapters by id', () => {
    const existing = [ch({ id: 1, uuid: 'u1' }), ch({ id: 2, uuid: 'u2' })];
    const incoming = [ch({ id: 1, title: 'Renamed' }), ch({ id: 2 })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('u1');
    expect(out[1].uuid).toBe('u2');
    expect(out[0].title).toBe('Renamed'); // incoming fields win
  });

  it('mints a uuid for an incoming chapter with no matching existing id', () => {
    const existing = [ch({ id: 1, uuid: 'u1' })];
    const incoming = [ch({ id: 1 }), ch({ id: 2 })]; // id 2 is new

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('u1');
    expect(out[1].uuid).toMatch(UUID_RE);
  });

  it('ignores a client uuid when the existing chapter has one (#3683)', () => {
    const existing = [ch({ id: 1, uuid: 'old' })];
    const incoming = [ch({ id: 1, uuid: 'client-supplied' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('old');
  });

  it('never lets a client claim a uuid another existing chapter holds (#3683)', () => {
    const existing = [ch({ id: 1, uuid: 'old' }), ch({ id: 2, uuid: 'other' })];
    const incoming = [ch({ id: 1, uuid: 'other' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('old');
  });

  it('keeps a client uuid for an id with no existing uuid', () => {
    const existing = [ch({ id: 1, uuid: 'u1' })];
    const incoming = [ch({ id: 2, uuid: 'client-supplied' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('client-supplied');
  });

  it('id-only match with a slug mismatch carries nothing and keeps a free client uuid (#3683)', () => {
    const existing = [ch({ id: 1, slug: '01-two', uuid: 'u-2' })];
    const incoming = [ch({ id: 1, slug: '01-one', uuid: 'u-1' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('u-1');
  });

  it('same id+slug with a different client uuid still carries the disk uuid (#3683)', () => {
    const existing = [ch({ id: 1, uuid: 'disk' })];
    const incoming = [ch({ id: 1, uuid: 'other' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('disk');
  });

  it('an unmatched chapter whose client uuid a disk chapter holds gets a fresh one (#3683)', () => {
    const existing = [ch({ id: 3, slug: '03-four', uuid: 'u-4' })];
    const incoming = [ch({ id: 3, slug: '03-three', uuid: 'u-3' }), ch({ id: 4, uuid: 'u-4' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('u-3');
    expect(out[1].uuid).toMatch(UUID_RE);
    expect(out[1].uuid).not.toBe('u-4');
  });

  it('output uuids are unique even when two incoming chapters claim one disk chapter (#3683)', () => {
    const existing = [ch({ id: 1, uuid: 'u1' })];
    const incoming = [ch({ id: 1 }), ch({ id: 1 })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(new Set(out.map((c) => c.uuid)).size).toBe(2);
  });

  it('two unmatched chapters sharing a free client uuid: the first keeps it, the second is minted (#3683)', () => {
    const existing = [ch({ id: 1, uuid: 'u-1' })];
    const incoming = [ch({ id: 5, uuid: 'same' }), ch({ id: 6, uuid: 'same' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('same');
    expect(out[1].uuid).toMatch(UUID_RE);
    expect(out[1].uuid).not.toBe('same');
  });

  it('a matched stored chapter with no uuid keeps the client uuid when nothing else holds it (#3683)', () => {
    const existing = [ch({ id: 1, slug: '01-x' })];
    const incoming = [ch({ id: 1, slug: '01-x', uuid: 'forged' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('forged');
  });

  it('does not mutate the incoming array', () => {
    const existing = [ch({ id: 1, uuid: 'u1' })];
    const incoming = [ch({ id: 1 })];

    reconcileChapterUuids(incoming, existing);

    expect(incoming[0].uuid).toBeUndefined();
  });
});

describe('carryTitleSynthesized', () => {
  it('carries a true flag from the existing chapter by id', () => {
    const existing = [ch({ id: 1, titleSynthesized: true }), ch({ id: 2 })];
    const incoming = [ch({ id: 1 }), ch({ id: 2 })];

    const out = carryTitleSynthesized(incoming, existing);

    expect(out[0].titleSynthesized).toBe(true);
    expect('titleSynthesized' in out[1]).toBe(false);
  });

  it('drops a client-sent true when the existing chapter has no flag', () => {
    const existing = [ch({ id: 1 })];
    const incoming = [ch({ id: 1, titleSynthesized: true })];

    const out = carryTitleSynthesized(incoming, existing);

    expect('titleSynthesized' in out[0]).toBe(false);
  });

  it('leaves the flag absent for an incoming id with no existing chapter', () => {
    const existing = [ch({ id: 1, titleSynthesized: true })];
    const incoming = [ch({ id: 1 }), ch({ id: 2, titleSynthesized: true })];

    const out = carryTitleSynthesized(incoming, existing);

    expect(out[0].titleSynthesized).toBe(true);
    expect('titleSynthesized' in out[1]).toBe(false);
  });

  it('drops the flag when the incoming title differs from the stored one', () => {
    const existing = [ch({ id: 1, title: 'Chapter 1', titleSynthesized: true })];
    const incoming = [ch({ id: 1, title: 'Chapter 9' })];

    const out = carryTitleSynthesized(incoming, existing);

    expect('titleSynthesized' in out[0]).toBe(false);
  });

  it('does not mutate the incoming array', () => {
    const existing = [ch({ id: 1, titleSynthesized: true })];
    const incoming = [ch({ id: 1 })];

    carryTitleSynthesized(incoming, existing);

    expect('titleSynthesized' in incoming[0]).toBe(false);
  });
  it('matches by id alone: carries across a slug mismatch while the title is unchanged, not when it differs (#3683)', () => {
    const existing = [ch({ id: 1, slug: '01-two', title: 'T', uuid: 'a', titleSynthesized: true })];

    expect(
      carryTitleSynthesized([ch({ id: 1, slug: '01-one', title: 'T', uuid: 'b' })], existing)[0]
        .titleSynthesized,
    ).toBe(true);
    expect(
      carryTitleSynthesized([ch({ id: 1, slug: '01-one', title: 'U', uuid: 'a' })], existing)[0]
        .titleSynthesized,
    ).toBeUndefined();
  });
});

describe('carryServerOwnedChapterFields (#3683)', () => {
  const audioQa: NonNullable<Chapter['audioQa']> = {
    status: 'suspect',
    reasons: ['loudness'],
    measuredLufs: -20.5,
    truePeakDb: -1.5,
    durationSec: 754.56,
    expectedSec: 750,
    checkedAt: '2026-10-23T10:00:05.000Z',
  };

  it('a) a stale copy loses to the stamp — the existing server-owned values win', () => {
    const existing = [
      ch({
        id: 1,
        duration: '00:12:34',
        audioRenderedAt: '2026-10-23T10:00:00.000Z',
        audioModelKey: 'qwen',
        audioEngines: { qwen: 2 },
        audioQa,
      }),
    ];
    const incoming = [
      ch({ id: 1, duration: '00:00', audioRenderedAt: '2026-10-01T00:00:00.000Z' }),
    ];

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect(out[0].duration).toBe('00:12:34');
    expect(out[0].audioRenderedAt).toBe('2026-10-23T10:00:00.000Z');
    expect(out[0].audioModelKey).toBe('qwen');
    expect(out[0].audioEngines).toEqual({ qwen: 2 });
    expect(out[0].audioQa).toEqual(audioQa);
  });

  it('b) a client value for a server-owned field is ignored', () => {
    const existing = [
      ch({ id: 1, generationState: 'failed', generationError: 'old reason' }),
    ];
    const incoming = [
      ch({ id: 1, audioModelKey: 'kokoro', duration: '01:00:00', generationError: 'client reason' }),
    ];

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect('audioModelKey' in out[0]).toBe(false);
    expect('duration' in out[0]).toBe(false);
    expect(out[0].generationError).toBe('old reason');
  });

  it('c) a stale copy keeps the failure stamp — absent client keys keep disk values', () => {
    const existing = [
      ch({
        id: 1,
        generationState: 'failed',
        generationError: 'boom',
        generationErrorCode: 'E_TTS',
        generationRemediation: 'retry',
      }),
    ];
    const incoming = [ch({ id: 1 })]; // a copy taken before the failure

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect(out[0].generationState).toBe('failed');
    expect(out[0].generationError).toBe('boom');
    expect(out[0].generationErrorCode).toBe('E_TTS');
    expect(out[0].generationRemediation).toBe('retry');
  });

  it('c2) an explicit null clears the generation* failure fields', () => {
    const existing = [
      ch({
        id: 1,
        generationState: 'failed',
        generationError: 'boom',
        generationErrorCode: 'E_TTS',
        generationRemediation: 'retry',
      }),
    ];
    const incoming = [
      ch({
        id: 1,
        generationState: null as unknown as Chapter['generationState'],
        generationError: null as unknown as Chapter['generationError'],
        generationErrorCode: null as unknown as Chapter['generationErrorCode'],
        generationRemediation: null as unknown as Chapter['generationRemediation'],
      }),
    ];

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect(out[0]).not.toHaveProperty('generationState');
    expect(out[0]).not.toHaveProperty('generationError');
    expect(out[0]).not.toHaveProperty('generationErrorCode');
    expect(out[0]).not.toHaveProperty('generationRemediation');
  });

  it('c2) mixed — only an explicitly-nulled field is dropped, absent ones keep disk values', () => {
    const existing = [
      ch({
        id: 1,
        generationState: 'failed',
        generationError: 'boom',
        generationErrorCode: 'E_TTS',
        generationRemediation: 'retry',
      }),
    ];
    const incoming = [
      ch({ id: 1, generationState: null as unknown as Chapter['generationState'] }),
    ];

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect(out[0]).not.toHaveProperty('generationState');
    expect(out[0].generationError).toBe('boom');
    expect(out[0].generationErrorCode).toBe('E_TTS');
    expect(out[0].generationRemediation).toBe('retry');
  });

  it('d) a client cannot plant generation* fields the server never stamped', () => {
    const existing = [ch({ id: 1 })];
    const incoming = [ch({ id: 1, generationState: 'failed', generationError: 'x' })];

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect('generationState' in out[0]).toBe(false);
    expect('generationError' in out[0]).toBe(false);
  });

  it('e) an unknown id keeps pass-through fields and drops server-owned ones', () => {
    const incoming = [
      ch({
        id: 9,
        title: 'Client Title',
        excluded: true,
        held: true,
        duration: '00:10:00',
        audioModelKey: 'kokoro',
        generationError: 'x',
      }),
    ];

    const out = carryServerOwnedChapterFields(incoming, []);

    expect(out[0].title).toBe('Client Title');
    expect(out[0].excluded).toBe(true);
    expect(out[0].held).toBe(true);
    expect('duration' in out[0]).toBe(false);
    expect('audioModelKey' in out[0]).toBe(false);
    expect('generationError' in out[0]).toBe(false);
  });

  it('f) title, excluded and held pass through from the incoming chapter', () => {
    const existing = [ch({ id: 1, title: 'Disk Title', excluded: true, held: true })];
    const incoming = [ch({ id: 1, title: 'Client Title', excluded: false, held: false })];

    const out = carryServerOwnedChapterFields(incoming, existing);

    expect(out[0].title).toBe('Client Title');
    expect(out[0].excluded).toBe(false);
    expect(out[0].held).toBe(false);
  });

  it('g) does not mutate the incoming array or its chapter objects', () => {
    const existing = [ch({ id: 1, duration: '00:12:34', generationState: 'failed' })];
    const incoming = [
      ch({
        id: 1,
        duration: '00:00',
        generationError: null as unknown as Chapter['generationError'],
      }),
    ];
    const before = structuredClone(incoming);

    carryServerOwnedChapterFields(incoming, existing);

    expect(incoming).toEqual(before);
  });
  it('h) carries nothing across a slug mismatch but carries across a uuid mismatch (#3683)', () => {
    const existing = [ch({ id: 1, slug: '01-two', uuid: 'u-2', duration: '00:20:00' })];

    const slugMiss = carryServerOwnedChapterFields(
      [ch({ id: 1, slug: '01-one', uuid: 'u-1', duration: 'client' })],
      existing,
    );
    expect(slugMiss[0].duration).toBeUndefined();

    const uuidMiss = carryServerOwnedChapterFields(
      [ch({ id: 1, slug: '01-two', uuid: 'u-1', duration: 'client' })],
      existing,
    );
    expect(uuidMiss[0].duration).toBe('00:20:00');
  });

  it('i) matches when one side carries no uuid', () => {
    const existing = [ch({ id: 1, duration: '00:20:00' })];

    const out = carryServerOwnedChapterFields([ch({ id: 1, uuid: 'u-1' })], existing);

    expect(out[0].duration).toBe('00:20:00');
  });
});
