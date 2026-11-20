/* #4329 (of #4319, spec §4.3 "The scan heal", §4.4 `healTakeFields`) - the scan
   heal derives through the take leaf: it fills the EFFECTIVE model key, fills
   `audioQa` when absent, never fills `audioTakeId`, and never rewrites a value
   that is already present. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillAudioModelKeysFromSegments, type BookStateJson } from './scan.js';

const base = {
  bookId: 'b1',
  manuscriptId: 'm1',
  title: 'T',
  author: 'A',
  series: 'S',
  seriesPosition: 1,
  isStandalone: false,
  manuscriptFile: 'manuscript.txt',
  castConfirmed: false,
  coverGradient: ['#000', '#fff'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

const QA = {
  status: 'ok',
  reasons: [],
  measuredLufs: -19,
  truePeakDb: -3,
  durationSec: 125,
  expectedSec: 120,
  checkedAt: '2026-02-02T00:00:00.000Z',
};

type Ch = Record<string, unknown>;

async function heal(segments: unknown, chapter: Ch) {
  const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-heal-take-fields-'));
  try {
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'audio', '01-c.mp3'), 'x');
    writeFileSync(join(bookDir, 'audio', '01-c.segments.json'), JSON.stringify(segments));
    const st = { ...base, chapters: [{ id: 1, title: 'C', slug: '01-c', duration: '00:00', ...chapter }] };
    writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(st));
    const res = await backfillAudioModelKeysFromSegments(bookDir, st as unknown as BookStateJson);
    const disk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')) as {
      chapters: Ch[];
    };
    return { returned: res.state.chapters[0] as Ch, disk: disk.chapters[0] };
  } finally {
    rmSync(bookDir, { recursive: true, force: true });
  }
}

describe('scan heal through the take leaf (#4329)', () => {
  it('H1: a chapter missing audioModelKey heals to the EFFECTIVE key, not the raw modelKey', async () => {
    const { returned, disk } = await heal(
      {
        durationSec: 125,
        modelKey: 'kokoro-v1',
        synthesizedAt: '2026-02-02T00:00:00.000Z',
        characterSnapshots: { a: { voiceEngine: 'qwen' }, b: { voiceEngine: 'qwen' } },
      },
      {},
    );
    for (const ch of [returned, disk]) {
      expect(ch.audioModelKey).toBe('qwen3-tts-0.6b');
      expect(ch.audioEngines).toEqual({ qwen: 2 });
      expect(ch.duration).toBe('02:05');
    }
  });

  it('H2: a chapter missing audioQa heals it from the segments qa', async () => {
    const { returned, disk } = await heal(
      { durationSec: 125, modelKey: 'kokoro-v1', synthesizedAt: '2026-02-02T00:00:00.000Z', qa: QA },
      {},
    );
    expect(returned.audioQa).toEqual(QA);
    expect(disk.audioQa).toEqual(QA);
  });

  it('H3: segments carrying a takeId never give the chapter an audioTakeId', async () => {
    const { returned, disk } = await heal(
      { durationSec: 125, modelKey: 'kokoro-v1', takeId: 'abcdefghijklmnop', qa: QA },
      {},
    );
    expect(returned.audioTakeId).toBeUndefined();
    expect(disk.audioTakeId).toBeUndefined();
    expect(disk.audioQa).toEqual(QA); // the heal still ran
  });

  it('H4: present values, including an audioModelKey from an earlier raw-key heal, are never rewritten', async () => {
    const present = {
      duration: '09:09',
      audioModelKey: 'kokoro-v1',
      audioEngines: { kokoro: 9 },
      audioRenderedAt: '2025-01-01T00:00:00.000Z',
      audioQa: { ...QA, status: 'suspect' },
    };
    const { returned, disk } = await heal(
      {
        durationSec: 125,
        modelKey: 'kokoro-v1',
        synthesizedAt: '2026-02-02T00:00:00.000Z',
        characterSnapshots: { a: { voiceEngine: 'qwen' } },
        qa: QA,
      },
      present,
    );
    for (const ch of [returned, disk]) {
      expect(ch).toMatchObject(present);
    }
  });
});
