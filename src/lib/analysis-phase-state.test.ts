import { describe, expect, it } from 'vitest';
import type { AnalysisLiveInfo } from './api';
import { derivePhaseState } from './analysis-phase-state';

const live = (n: number): AnalysisLiveInfo => ({
  totalChapters: 9,
  chapters: Array.from({ length: n }, (_, i) => ({
    chapterIndex: i + 1,
    chapterTitle: `Chapter ${i + 1}`,
    elapsedMs: 1000,
    estMs: 5000,
  })),
});

describe('derivePhaseState', () => {
  it('is active when it is the frontier even with no progress/live yet (initial phase 0)', () => {
    expect(
      derivePhaseState(0, { progressByPhase: {}, liveByPhase: {}, maxPhase: 0 }),
    ).toBe('active');
  });

  it('is pending for a phase beyond the frontier', () => {
    expect(
      derivePhaseState(2, { progressByPhase: { 0: 0.3 }, liveByPhase: {}, maxPhase: 0 }),
    ).toBe('pending');
  });

  it('is active when the phase has live chapters', () => {
    expect(
      derivePhaseState(0, { progressByPhase: { 0: 0.3 }, liveByPhase: { 0: live(1) }, maxPhase: 0 }),
    ).toBe('active');
  });

  it('is active when the phase has started (progress) but no live yet (e.g. library match)', () => {
    expect(
      derivePhaseState(2, { progressByPhase: { 2: 0.1 }, liveByPhase: {}, maxPhase: 2 }),
    ).toBe('active');
  });

  it('is done when its progress has reached completion', () => {
    expect(
      derivePhaseState(0, { progressByPhase: { 0: 1 }, liveByPhase: {}, maxPhase: 1 }),
    ).toBe('done');
  });

  /* Live payloads are sticky (we never blank a phase's last live), so a
     completed phase can still carry stale live chapters. Completion (progress
     1) must win over that stale live → done, so its ticker stops rendering. */
  it('is done at completion even if a stale live payload lingers', () => {
    expect(
      derivePhaseState(0, { progressByPhase: { 0: 1 }, liveByPhase: { 0: live(1) }, maxPhase: 1 }),
    ).toBe('done');
  });

  it('is done when a later phase has advanced past it and it has no live left', () => {
    expect(
      derivePhaseState(0, { progressByPhase: { 0: 0.4, 1: 0.2 }, liveByPhase: {}, maxPhase: 1 }),
    ).toBe('done');
  });

  /* The core flicker fix: when Phase 0 (cast) and Phase 1 (attribution)
     pipeline, BOTH carry live chapters at the same time and BOTH must read
     as active — neither clobbers the other into 'done'/'pending'. */
  it('keeps two pipelined phases both active when each has live chapters', () => {
    const opts = {
      progressByPhase: { 0: 0.6, 1: 0.1 },
      liveByPhase: { 0: live(1), 1: live(1) },
      maxPhase: 1,
    };
    expect(derivePhaseState(0, opts)).toBe('active');
    expect(derivePhaseState(1, opts)).toBe('active');
    expect(derivePhaseState(2, opts)).toBe('pending');
  });

  it('live presence on an earlier phase wins over the later-phase "done" rule', () => {
    // Phase 0 still streaming a slow chapter while Phase 1 has started.
    expect(
      derivePhaseState(0, {
        progressByPhase: { 0: 0.5, 1: 0.05 },
        liveByPhase: { 0: live(1) },
        maxPhase: 1,
      }),
    ).toBe('active');
  });

  it('treats an empty live payload as no live (not active on that basis alone)', () => {
    expect(
      derivePhaseState(2, { progressByPhase: {}, liveByPhase: { 2: live(0) }, maxPhase: 1 }),
    ).toBe('pending');
  });
});
