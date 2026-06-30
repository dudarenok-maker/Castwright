import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetGenerationStatsForTest,
  getGenerationStats,
  recordBatchThroughput,
  recordChapterThroughput,
} from './generation-stats.js';

afterEach(() => __resetGenerationStatsForTest());

const T0 = 1_000_000_000_000; // fixed base epoch so window math is deterministic

describe('generation-stats accumulator', () => {
  it('reports the empty shape before anything is recorded', () => {
    const s = getGenerationStats(T0);
    expect(s.chapters).toBe(0);
    expect(s.rtf).toBeNull();
    expect(s.xRealtime).toBeNull();
    expect(s.chaptersPerHour).toBeNull();
    expect(s.last).toBeNull();
    expect(s.updatedAt).toBeNull();
  });

  it('computes rtf and xRealtime for a single chapter', () => {
    // 120 s of audio synthesised in 60 s wall → rtf 0.5, 2x realtime.
    const s = recordChapterThroughput({ chapterId: 3, audioSec: 120, synthMs: 60_000 }, T0);
    expect(s.chapters).toBe(1);
    expect(s.audioSec).toBe(120);
    expect(s.synthSec).toBe(60);
    expect(s.rtf).toBeCloseTo(0.5, 5);
    expect(s.xRealtime).toBeCloseTo(2, 5);
    expect(s.last?.chapterId).toBe(3);
    expect(s.last?.rtf).toBeCloseTo(0.5, 5);
    // window = synth start (T0-60s) .. T0 = 60 s → 1 chapter / 60 s = 60 ch/hr.
    expect(s.chaptersPerHour).toBeCloseTo(60, 3);
  });

  it('rolls multiple chapters in one window into an aggregate rtf', () => {
    recordChapterThroughput({ chapterId: 3, audioSec: 100, synthMs: 50_000 }, T0);
    const s = recordChapterThroughput(
      { chapterId: 4, audioSec: 300, synthMs: 150_000 },
      T0 + 60_000,
    );
    expect(s.chapters).toBe(2);
    expect(s.audioSec).toBe(400);
    expect(s.synthSec).toBe(200);
    // aggregate: 200 s synth / 400 s audio = 0.5 rtf (2x realtime).
    expect(s.rtf).toBeCloseTo(0.5, 5);
    expect(s.xRealtime).toBeCloseTo(2, 5);
    // window opened at T0-50s, latest fold at T0+60s → 110 s for 2 chapters.
    expect(s.chaptersPerHour).toBeCloseTo((2 / 110) * 3600, 3);
  });

  it('opens a fresh window after an idle gap (a new run is not averaged against the old)', () => {
    recordChapterThroughput({ chapterId: 3, audioSec: 100, synthMs: 50_000 }, T0);
    // > 10 min later: a brand-new generation session.
    const s = recordChapterThroughput(
      { chapterId: 9, audioSec: 60, synthMs: 60_000 },
      T0 + 11 * 60_000,
    );
    expect(s.chapters).toBe(1); // not 2 — old window discarded
    expect(s.audioSec).toBe(60);
    expect(s.rtf).toBeCloseTo(1, 5);
  });

  it('goes back to the empty shape once the window idles past the reset gap', () => {
    recordChapterThroughput({ chapterId: 3, audioSec: 100, synthMs: 50_000 }, T0);
    expect(getGenerationStats(T0 + 60_000).chapters).toBe(1);
    expect(getGenerationStats(T0 + 11 * 60_000).chapters).toBe(0);
  });
});

describe('generation-stats live per-batch window', () => {
  it('reports liveBatchRtf for a single batch (genMs ÷ audioMs)', () => {
    // 90 s compute for 30 s of audio → rtf 3.0.
    const s = recordBatchThroughput({ genMs: 90_000, audioMs: 30_000 }, T0);
    expect(s.liveBatchRtf).toBeCloseTo(3, 5);
    expect(s.lastBatchRtf).toBeCloseTo(3, 5);
    expect(s.batchesInWindow).toBe(1);
    expect(s.batchUpdatedAt).toBe(new Date(T0).toISOString());
  });

  it('aggregates recent batches and tracks the latest separately', () => {
    recordBatchThroughput({ genMs: 90_000, audioMs: 30_000 }, T0); // rtf 3.0
    const s = recordBatchThroughput({ genMs: 30_000, audioMs: 30_000 }, T0 + 90_000); // rtf 1.0
    // aggregate: 120 000 ms gen / 60 000 ms audio = 2.0; last batch = 1.0.
    expect(s.liveBatchRtf).toBeCloseTo(2, 5);
    expect(s.lastBatchRtf).toBeCloseTo(1, 5);
    expect(s.batchesInWindow).toBe(2);
  });

  it('drops the batch readout once no batch is recent (idle past 5 min)', () => {
    recordBatchThroughput({ genMs: 90_000, audioMs: 30_000 }, T0);
    expect(getGenerationStats(T0 + 60_000).liveBatchRtf).toBeCloseTo(3, 5);
    const idle = getGenerationStats(T0 + 6 * 60_000);
    expect(idle.liveBatchRtf).toBeNull();
    expect(idle.batchesInWindow).toBe(0);
    expect(idle.batchUpdatedAt).toBeNull();
  });

  it('is independent of the chapter window — live while the first chapter is still rendering', () => {
    // No chapter completed yet (chapters stays 0), but batches are landing.
    const s = recordBatchThroughput({ genMs: 45_000, audioMs: 30_000 }, T0);
    expect(s.chapters).toBe(0);
    expect(s.rtf).toBeNull();
    expect(s.liveBatchRtf).toBeCloseTo(1.5, 5);
  });
});

describe('generation-stats per-chapter history ring', () => {
  it('records every field of a finished chapter newest-first', () => {
    const s = recordChapterThroughput(
      {
        chapterId: 12,
        audioSec: 120,
        synthMs: 60_000,
        title: 'Chapter 12',
        bookId: 'book-a',
        modelKey: 'qwen3-tts',
      },
      T0,
    );
    expect(s.recentChapters).toHaveLength(1);
    expect(s.recentChapters[0]).toEqual({
      chapterId: 12,
      title: 'Chapter 12',
      bookId: 'book-a',
      modelKey: 'qwen3-tts',
      rtf: 0.5, // 60 s synth / 120 s audio
      rerecordRtf: null, // no QA sub-costs
      verifyRtf: null, // no QA sub-costs
      audioSec: 120,
      synthSec: 60,
      at: new Date(T0).toISOString(),
    });
  });

  it('keeps the newest chapter first', () => {
    recordChapterThroughput({ chapterId: 1, audioSec: 100, synthMs: 50_000 }, T0);
    const s = recordChapterThroughput(
      { chapterId: 2, audioSec: 100, synthMs: 50_000 },
      T0 + 60_000,
    );
    expect(s.recentChapters.map((c) => c.chapterId)).toEqual([2, 1]);
  });

  it('caps the ring at MAX_HISTORY (200), keeping the most recent', () => {
    for (let i = 1; i <= 205; i++) {
      recordChapterThroughput({ chapterId: i, audioSec: 100, synthMs: 50_000 }, T0 + i * 1000);
    }
    const s = getGenerationStats(T0 + 205_000);
    expect(s.recentChapters).toHaveLength(200);
    expect(s.recentChapters[0].chapterId).toBe(205); // newest kept
    expect(s.recentChapters[199].chapterId).toBe(6); // oldest 5 dropped
  });

  it('survives the rolling-window idle reset — the trend is not blanked', () => {
    recordChapterThroughput({ chapterId: 3, audioSec: 100, synthMs: 50_000 }, T0);
    // Read well past RESET_MS: the aggregate empties but the history must not.
    const s = getGenerationStats(T0 + 11 * 60_000);
    expect(s.chapters).toBe(0); // rolling window reset
    expect(s.rtf).toBeNull();
    expect(s.recentChapters).toHaveLength(1); // history preserved
    expect(s.recentChapters[0].chapterId).toBe(3);
  });

  it('records rtf=null (not 0/Infinity) for a chapter with no audio', () => {
    const s = recordChapterThroughput({ chapterId: 7, audioSec: 0, synthMs: 30_000 }, T0);
    expect(s.recentChapters[0].rtf).toBeNull();
  });

  it('defaults title/bookId/modelKey to null for a bare 3-field call (back-compat)', () => {
    const s = recordChapterThroughput({ chapterId: 9, audioSec: 100, synthMs: 50_000 }, T0);
    expect(s.recentChapters[0]).toMatchObject({
      chapterId: 9,
      title: null,
      bookId: null,
      modelKey: null,
    });
  });

  it('is cleared by the test reset helper', () => {
    recordChapterThroughput({ chapterId: 1, audioSec: 100, synthMs: 50_000 }, T0);
    __resetGenerationStatsForTest();
    expect(getGenerationStats(T0).recentChapters).toHaveLength(0);
  });

  it('B1: records rerecordRtf and verifyRtf from QA sub-costs', () => {
    __resetGenerationStatsForTest();
    const s = recordChapterThroughput({
      chapterId: 1,
      audioSec: 100,
      synthMs: 120_000,
      rerecordMs: 30_000, // 30s re-record over 100s audio → 0.30
      transcribeMs: 8_000,
      embedMs: 2_000, // (8+2)/100 → 0.10
    });
    expect(s.recentChapters[0].rerecordRtf).toBeCloseTo(0.3, 3);
    expect(s.recentChapters[0].verifyRtf).toBeCloseTo(0.1, 3);
  });

  it('B1: QA fields are null when sub-costs are absent (multi-worker / no split)', () => {
    __resetGenerationStatsForTest();
    const s = recordChapterThroughput({ chapterId: 2, audioSec: 100, synthMs: 120_000 });
    expect(s.recentChapters[0].rerecordRtf).toBeNull();
    expect(s.recentChapters[0].verifyRtf).toBeNull();
  });
});
