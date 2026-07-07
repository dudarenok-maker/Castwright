import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../workspace/state-io.js';
import { audioDir } from '../workspace/paths.js';
import { writeVerdicts, writeAttempted, attemptedPath } from './render-integrity/verdicts-io.js';
import { scoreBook } from './render-integrity/aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './render-integrity/embeddings-io.js';
import { buildAudioQaReport } from './qa-report.js';

async function makeBook(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-report-'));
  await mkdir(audioDir(dir), { recursive: true });
  return dir;
}

function seg(overrides: Record<string, unknown> = {}) {
  return {
    groupIndex: 0,
    characterId: 'wren',
    sentenceIds: [1],
    startSec: 0,
    endSec: 1,
    ...overrides,
  };
}

describe('buildAudioQaReport', () => {
  it('reports full coverage on a clean, fully-gated book', async () => {
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1',
      chapterId: 1,
      chapterTitle: 'One',
      durationSec: 10,
      sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b',
      synthesizedAt: new Date(0).toISOString(),
      segments: [
        seg({ qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 } }),
      ],
      characterSnapshots: { wren: { voiceEngine: 'qwen' } },
    });

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);

    expect(report.chaptersRendered).toBe(1);
    expect(report.totalLines).toBe(1);
    expect(report.acoustic.linesChecked).toBe(1);
    expect(report.acoustic.linesRerecorded).toBe(0);
    expect(report.asr.linesVerified).toBe(0); // ASR field absent on this fixture → not verified
    expect(report.voiceDrift.chaptersEligible).toBe(1); // wren is qwen-voiced
    expect(report.voiceDrift.chaptersScored).toBe(0); // no render-integrity.json written
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(0); // gate genuinely off, not an embed failure
  });

  it('reports chaptersEligible = 0 for an all-Kokoro book, distinct from not-run', async () => {
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'kokoro', synthesizedAt: new Date(0).toISOString(),
      segments: [seg()],
      characterSnapshots: { wren: { voiceEngine: 'kokoro' } },
    });

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.voiceDrift.chaptersEligible).toBe(0);
    expect(report.voiceDrift.charactersOnRoster).toBe(0);
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(0); // nothing eligible to check
  });

  it('counts sentenceIds, not segment-group counts, for lines', async () => {
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ sentenceIds: [1, 2, 3] })], // one group, three sentences
      characterSnapshots: { wren: { voiceEngine: 'qwen' } },
    });
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.totalLines).toBe(3);
  });

  it('sets attribution to legacy-unattributed when a voice-mismatch row has no chapterId', async () => {
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg()],
      characterSnapshots: { wren: { voiceEngine: 'qwen' } },
    });
    await writeVerdicts(join(audioDir(dir), 'ch1.render-integrity.json'), [
      {
        characterId: 'wren', sentenceIds: [1], verdict: 'voice-mismatch', cosine: 0.3,
        severity: 'severe', fixable: true, expectedEngine: 'qwen', renderedEngine: 'qwen',
        referenceKind: 'in-book', windowed: false,
        // no chapterId — simulates a pre-fs-51 render
      },
    ]);
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.voiceDrift.attribution).toBe('legacy-unattributed');
  });

  it('attributes an eligible-but-unscored chapter to chaptersEmbedFailed once the gate is demonstrably on elsewhere', async () => {
    const dir = await makeBook();
    // Chapter 1: eligible AND scored — proves the gate is on for this book.
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg()],
      characterSnapshots: { wren: { voiceEngine: 'qwen' } },
    });
    await writeAttempted(attemptedPath(audioDir(dir), 'ch1'));
    await writeVerdicts(join(audioDir(dir), 'ch1.render-integrity.json'), [
      { characterId: 'wren', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    // Chapter 2: eligible, and ATTEMPTED (scoreBook began processing it), but
    // no verdict file — an isolated embed failure, not "off" (the gate is
    // confirmed on by chapter 1's verdict file above, and by ch2's own sentinel).
    await writeJsonAtomic(join(audioDir(dir), 'ch2.segments.json'), {
      bookId: 'b1', chapterId: 2, chapterTitle: 'Two', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ characterId: 'oduvan' })],
      characterSnapshots: { oduvan: { voiceEngine: 'qwen' } },
    });
    await writeAttempted(attemptedPath(audioDir(dir), 'ch2'));

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);
    expect(report.voiceDrift.chaptersEligible).toBe(2);
    expect(report.voiceDrift.chaptersScored).toBe(1);
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(1);
  });

  it('distinguishes a fleet-wide embedding failure (gate ran, attempted every chapter, all failed) from the gate being off', async () => {
    // fs-51 correctness fix: before this fix, chaptersEmbedFailed was gated on
    // `chaptersScored > 0`, so a book where the voice-drift gate ran and
    // attempted EVERY eligible chapter but failed to embed ALL of them was
    // indistinguishable from the gate never having run at all — both produced
    // chaptersScored === 0 and chaptersEmbedFailed === 0. The attempted
    // sentinel (written unconditionally by scoreBook's per-chapter loop,
    // regardless of embed outcome) makes this real: both chapters here are
    // eligible AND attempted, but neither has a verdict file.
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg()],
      characterSnapshots: { wren: { voiceEngine: 'qwen' } },
    });
    await writeAttempted(attemptedPath(audioDir(dir), 'ch1'));

    await writeJsonAtomic(join(audioDir(dir), 'ch2.segments.json'), {
      bookId: 'b1', chapterId: 2, chapterTitle: 'Two', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ characterId: 'oduvan' })],
      characterSnapshots: { oduvan: { voiceEngine: 'qwen' } },
    });
    await writeAttempted(attemptedPath(audioDir(dir), 'ch2'));

    // No verdict files anywhere — same on-disk shape as "gate off" EXCEPT
    // for the two attempted sentinels above.
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);
    expect(report.voiceDrift.chaptersEligible).toBe(2);
    expect(report.voiceDrift.chaptersScored).toBe(0);
    // Fleet-wide failure now reads distinctly nonzero — previously this was 0,
    // identical to the genuinely-off case in the first test above.
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(2);
  });

  it('does not count a sibling chapter still mid-finalize (segments.json written, embeddings.json not yet) toward chaptersEmbedFailed (GH #1436)', async () => {
    // GH #1436: scoreBook used to stamp the "attempted" sentinel for EVERY
    // chapter in the book on EVERY chapter-done event — including a
    // concurrently-rendering sibling whose segments.json had landed (so it
    // looks "eligible") but whose embeddings.json hadn't (finalize-chapter-
    // write.ts writes segments BEFORE embeddings). That produced a transient
    // false ALARM: chaptersEmbedFailed counted a chapter that was simply
    // still finishing its own render as an embed failure. This test fixes
    // the on-disk shape to what the corrected scoreBook now produces: ch2
    // has NO attempted sentinel (its own attempt genuinely hasn't happened
    // yet) even though its segments.json already exists.
    const dir = await makeBook();
    // ch1: fully processed — proves the gate is genuinely on for this book.
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg()],
      characterSnapshots: { wren: { voiceEngine: 'qwen' } },
    });
    await writeAttempted(attemptedPath(audioDir(dir), 'ch1'));
    await writeVerdicts(join(audioDir(dir), 'ch1.render-integrity.json'), [
      { characterId: 'wren', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);

    // ch2: still mid-render — segments.json landed (eligible, stochastic
    // character) but no attempted sentinel and no verdict file, because its
    // OWN embeddings write (and thus its own scoreBook attempt) hasn't
    // happened yet.
    await writeJsonAtomic(join(audioDir(dir), 'ch2.segments.json'), {
      bookId: 'b1', chapterId: 2, chapterTitle: 'Two', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ characterId: 'oduvan' })],
      characterSnapshots: { oduvan: { voiceEngine: 'qwen' } },
    });

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);
    expect(report.voiceDrift.chaptersEligible).toBe(2);
    expect(report.voiceDrift.chaptersScored).toBe(1);
    // Before the fix, ch1's scoreBook run would have wrongly stamped ch2
    // "attempted" too (it was in the full book-wide chapters list), making
    // this 1 — a false alarm for a chapter that was simply still rendering.
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(0);
  });

  it('classifies a mid-book engine switch book-wide (first chapter wins), matching scoreBook — a character voiced by Kokoro in ch1 then switched to Qwen in ch2 is NOT eligible in ch2', async () => {
    // PR #1433 review finding: qa-report.ts's eligibility loop used to
    // classify each chapter's stochastic characters from THAT chapter's own
    // characterSnapshots.voiceEngine — a per-chapter re-derivation that can
    // disagree with scoreBook's actual book-wide, first-chapter-wins
    // classification (aggregate.ts's configuredEngineByChar). A character
    // voiced by Kokoro in the chapter they first appear in, later switched to
    // Qwen, was incorrectly read as "eligible in the later chapter" here even
    // though scoreBook classifies that character Kokoro book-wide and never
    // scores them anywhere — see the companion scoreBook test in
    // aggregate.test.ts for the matching scoring-side assertion.
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'kokoro-v1', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ characterId: 'hero' })],
      characterSnapshots: { hero: { voiceEngine: 'kokoro' } },
    });
    await writeJsonAtomic(join(audioDir(dir), 'ch2.segments.json'), {
      bookId: 'b1', chapterId: 2, chapterTitle: 'Two', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ characterId: 'hero' })],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    });

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    // Book-wide classification (first chapter wins) says hero == kokoro, so
    // hero is never on the stochastic roster and NEITHER chapter is eligible
    // — matching what scoreBook will actually attempt to score.
    expect(report.voiceDrift.chaptersEligible).toBe(0);
    expect(report.voiceDrift.charactersOnRoster).toBe(0);
  });

  it('never produces an orphaned voice-mismatch when a character\'s first-ever chapter is missing its embeddings sibling (PR #1433 round-2 review finding)', async () => {
    // fs-51 PR #1433 round-2 finding: qa-report.ts's classifier
    // (resolveConfiguredEngineByChar) is fed the FULL segments.json
    // population via loadSegmentsFiles, regardless of embeddings
    // availability. scoreBook's OWN classifier call used to be fed a
    // DIFFERENT, embeddings-filtered chapter list — so the two could
    // disagree about which chapter is "first" for a character whose
    // first-ever rendered chapter has no embeddings sibling, producing a
    // self-contradictory report: a voice-mismatch row for a character the
    // same report's roster says was never checked.
    //
    // Fixture: hero renders Kokoro in ch1 (segments.json only, embeddings
    // write failed/never happened) then Qwen in ch2 (segments.json AND
    // embeddings.json — fully processable). This is a REAL on-disk run of
    // scoreBook (not a hand-crafted verdict file), so it exercises both
    // call sites' actual classifier inputs end-to-end.
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'kokoro-v1', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ characterId: 'hero' })],
      characterSnapshots: { hero: { voiceEngine: 'kokoro' } },
      // deliberately NO embeddings.json sibling written for ch1
    });

    // 10 clean anchor vectors clustered at angle 0 (clears CENTROID_MIN_N so
    // scoreBook takes the 'in-book' reference path, not the too-thin
    // fallback) plus one deliberately drifted vector at sentenceId 99 — a
    // genuine 'voice-mismatch' under the pre-fix bug, not a masking
    // 'inconclusive' verdict.
    const angleVec = (theta: number) => Float32Array.from([Math.cos(theta), Math.sin(theta), 0, 0, 0, 0, 0, 0]);
    const rows2: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 10; i++) rows2.push({ characterId: 'hero', sentenceIds: [i], vec: angleVec(0.02 * i) });
    rows2.push({ characterId: 'hero', sentenceIds: [99], vec: angleVec(1.2) }); // drifted
    await writeEmbeddings(join(audioDir(dir), 'ch2.embeddings.json'), rows2, EMBEDDINGS_VERSION);
    await writeJsonAtomic(join(audioDir(dir), 'ch2.segments.json'), {
      bookId: 'b1', chapterId: 2, chapterTitle: 'Two', durationSec: 10, sampleRate: 24000,
      modelKey: 'qwen3-tts-0.6b', synthesizedAt: new Date(0).toISOString(),
      segments: rows2.map((r) => seg({ characterId: 'hero', sentenceIds: r.sentenceIds })),
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    });

    // Run the REAL scoreBook against this fixture — with the round-2 fix,
    // it agrees with qa-report.ts that hero is kokoro book-wide (ch1 wins)
    // and never scores hero, so it writes no verdict file for ch2.
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    // Both call sites agree: hero is kokoro book-wide, never on the roster.
    expect(report.voiceDrift.charactersOnRoster).toBe(0);
    expect(report.voiceDrift.chaptersEligible).toBe(0);
    // No orphaned mismatch row: scoreBook wrote no verdict file for ch2, so
    // there is nothing for the roster to disagree with.
    expect(report.voiceDrift.mismatches).toEqual([]);
  });

  it('does not count a segment toward acoustic.chaptersFlagged when qa is clean and suspect is unset', async () => {
    // Companion to the chapter-qa-repair.ts fix: a repair rejected PURELY by
    // the acoustic/voice-drift cosine gate (signal-QA genuinely clean) must
    // leave the segment's `suspect` field unset, not `true` — this segment
    // shape (qa.status 'ok', suspect absent) is exactly what that fix now
    // writes for that case, and it must not inflate this count.
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'kokoro-v1', synthesizedAt: new Date(0).toISOString(),
      segments: [seg({ qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 } })],
      characterSnapshots: { wren: { voiceEngine: 'kokoro' } },
    });

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.acoustic.chaptersFlagged).toBe(0);
  });

  it('still counts a segment toward acoustic.chaptersFlagged for a genuine signal-QA/ASR suspect', async () => {
    const dir = await makeBook();
    await writeJsonAtomic(join(audioDir(dir), 'ch1.segments.json'), {
      bookId: 'b1', chapterId: 1, chapterTitle: 'One', durationSec: 10, sampleRate: 24000,
      modelKey: 'kokoro-v1', synthesizedAt: new Date(0).toISOString(),
      segments: [
        seg({
          qa: { status: 'suspect', reasons: ['long_silence'], rms: 0.001, longestSilenceSec: 5, durationSec: 6, expectedSec: 1 },
          suspect: true,
        }),
      ],
      characterSnapshots: { wren: { voiceEngine: 'kokoro' } },
    });

    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.acoustic.chaptersFlagged).toBe(1);
  });
});
