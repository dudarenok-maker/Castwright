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
