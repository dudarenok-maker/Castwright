import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { scoreBook } from './aggregate.js';
import { readVerdicts, readAttempted, attemptedPath } from './verdicts-io.js';
import { readCentroids } from './centroids-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// helper: a 2-d unit vector at angle θ, padded to length 8 (test vectors are small)
const vec = (θ: number) => Float32Array.from([Math.cos(θ), Math.sin(θ), 0, 0, 0, 0, 0, 0]);

describe('scoreBook', () => {
  it('scores all segments acoustically — including fallback renders — and correctly classifies by cosine distance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-book-'));
    //
    // Fixture layout:
    //   sentenceIds [0..11]  — 12 clean Qwen segments clustered at θ≈0  (non-fallback anchor)
    //   sentenceIds [99]     — 1 non-fallback drifted segment at θ≈1.2  (far from centroid → voice-mismatch)
    //   sentenceIds [100]    — 1 fallback (renderedFallbackEngine='kokoro'), vec FAR (θ≈1.2) → voice-mismatch
    //   sentenceIds [101]    — 1 fallback (renderedFallbackEngine='kokoro'), vec CLOSE (θ≈0.01) → voice-match
    //
    // The discriminating test is sentenceIds[101]: the definitional (wrong) rule would have
    // flagged it as voice-mismatch simply because renderedEngine !== configuredEngine.
    // The acoustic rule correctly passes it because its cosine is high (near the centroid).
    // Per spec §0.1: acoustic ≠ config; a Kokoro fallback that sounds like the voice passes
    // the acoustic gate — the fallback itself is a config concern surfaced elsewhere.
    //
    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'hero', sentenceIds: [i], vec: vec(0.02 * i) });
    rows.push({ characterId: 'hero', sentenceIds: [99], vec: vec(1.2) });    // non-fallback, drifted
    rows.push({ characterId: 'hero', sentenceIds: [100], vec: vec(1.2) });   // fallback render, acoustically FAR
    rows.push({ characterId: 'hero', sentenceIds: [101], vec: vec(0.01) });  // fallback render, acoustically CLOSE

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);

    // REAL shape: voiceEngine lives ONLY on characterSnapshots (per-character);
    // renderedFallbackEngine is per-segment on the segments[] entries.
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({
        characterId: 'hero', sentenceIds: r.sentenceIds,
        renderedFallbackEngine: (r.sentenceIds[0] === 100 || r.sentenceIds[0] === 101) ? 'kokoro' : null,
      })),
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    const bySent = Object.fromEntries(verdicts!.map((v) => [v.sentenceIds[0], v]));

    // Non-fallback drifted segment flagged acoustically
    expect(bySent[99].verdict).toBe('voice-mismatch');

    // Fallback segment acoustically FAR → voice-mismatch; stored cosine is the REAL
    // measurement (not fabricated 0), but it will be low (far from centroid)
    expect(bySent[100].verdict).toBe('voice-mismatch');
    // The stored cosine must be the real acoustic measurement — it will be low
    // (far vector), but NOT necessarily exactly 0 unless perfectly orthogonal
    expect(bySent[100].cosine).toBeLessThan(0.5);

    // DISCRIMINATING TEST: fallback render that is acoustically CLOSE to the centroid
    // must pass as voice-match. The definitional (wrong) rule would have flagged this
    // because renderedEngine ('kokoro') !== configuredEngine ('qwen'). The acoustic
    // rule correctly passes it — per spec §0.1, acoustic scoring is independent of
    // config; the fallback is a config concern surfaced elsewhere.
    expect(bySent[101].verdict).toBe('voice-match');
    // Also confirm the stored cosine is the real high measurement
    expect(bySent[101].cosine).toBeGreaterThan(0.9);

    // Clean segments pass
    expect(bySent[0].verdict).toBe('voice-match');

    const centroids = await readCentroids(dir);
    expect(centroids!['hero'].referenceKind).toBe('in-book');

    // The attempted sentinel is written for a chapter that scored successfully too —
    // "attempted" and "scored" aren't mutually exclusive; every processed chapter
    // gets a sentinel regardless of outcome.
    expect(await readAttempted(attemptedPath(join(dir, 'audio'), 'ch1'))).toBe(true);
  });

  it('writes the attempted sentinel even when the embeddings sibling is missing (fleet-wide embed-failure signal)', async () => {
    // fs-51 correctness fix: a chapter with a stochastic-voiced character whose
    // `.embeddings.json` sibling is missing must still leave evidence that
    // scoreBook tried to process it — otherwise "the gate never ran" and "the
    // gate ran and embedding failed for every chapter" both look identical
    // (chaptersScored === 0 book-wide) to qa-report.ts's aggregation. The
    // sentinel is written BEFORE the missing-embeddings skip so its presence
    // alone proves scoreBook began this chapter's per-chapter processing.
    const dir = mkdtempSync(join(tmpdir(), 'spk-noemb-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    // Segments file exists (stochastic voice) but NO embeddings.json sibling.
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: [{ characterId: 'hero', sentenceIds: [1], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // No verdict file — scoring never happened for this chapter.
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).toBeNull();

    // But the attempted sentinel IS present — proving scoreBook tried.
    expect(await readAttempted(attemptedPath(join(dir, 'audio'), 'ch1'))).toBe(true);
  });

  it('does not stamp the attempted sentinel for a sibling chapter still mid-finalize (GH #1436)', async () => {
    // GH #1436: finalize-chapter-write.ts writes `<slug>.segments.json` BEFORE
    // `<slug>.embeddings.json`. Sibling chapters of the same book can render
    // concurrently, so chapter 1 finishing (and triggering this scoreBook run)
    // can race chapter 2's OWN finalize: chapter 2's segments.json has landed
    // (so it looks "eligible" — a stochastic-voiced character) but its
    // embeddings.json hasn't landed yet. Only chapter 1 is passed as
    // `justFinalizedSlugs` (it's the one whose completion triggered this call)
    // — chapter 2 must be left unstamped, since scoreBook has no evidence
    // chapter 2's OWN attempt has actually happened yet.
    const dir = mkdtempSync(join(tmpdir(), 'spk-race-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    const rows = [{ characterId: 'hero', sentenceIds: [1], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: [{ characterId: 'hero', sentenceIds: [1], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    // ch2: segments.json written (eligible — same stochastic character) but
    // NO embeddings.json sibling yet — still genuinely mid-finalize.
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      segments: [{ characterId: 'hero', sentenceIds: [2], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    // Only ch1 triggered this call.
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }], ['ch1']);

    expect(await readAttempted(attemptedPath(join(dir, 'audio'), 'ch1'))).toBe(true);
    // The race this bug report describes: ch2 must NOT be marked "attempted"
    // just because it appeared in the full book-wide `chapters` list scanned
    // by ch1's scoreBook run.
    expect(await readAttempted(attemptedPath(join(dir, 'audio'), 'ch2'))).toBe(false);
  });

  it('self-heals a coalesced-away trigger once the sibling chapter\'s own embeddings land on a later run (GH #1436)', async () => {
    // Complement to the test above: once ch2's embeddings genuinely DO exist
    // on disk (its own finalize-chapter-write completed), a LATER scoreBook
    // run — even one triggered by a different chapter entirely — must mark it
    // attempted. The embeddings sibling's presence is independent, positive
    // evidence of ch2's own completed attempt, regardless of who triggered
    // this particular call.
    const dir = mkdtempSync(join(tmpdir(), 'spk-race-heal-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    const rows = [{ characterId: 'hero', sentenceIds: [1], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: [{ characterId: 'hero', sentenceIds: [1], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    // ch2 now has ITS OWN embeddings too (its finalize completed since the
    // earlier test's snapshot in time).
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      segments: [{ characterId: 'hero', sentenceIds: [2], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    // A THIRD chapter's completion triggers this run — ch2 is not the trigger.
    writeFileSync(join(dir, 'audio', 'ch3.segments.json'), JSON.stringify({
      chapterId: 3,
      segments: [{ characterId: 'hero', sentenceIds: [3], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    await scoreBook(
      dir,
      [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }, { id: 3, slug: 'ch3' }],
      ['ch3'],
    );

    // ch2 is attempted purely because its embeddings sibling exists — not
    // because it was this call's trigger.
    expect(await readAttempted(attemptedPath(join(dir, 'audio'), 'ch2'))).toBe(true);
    // ch3 IS this call's trigger, so it's attempted regardless of its own
    // (absent) embeddings — matching the fleet-wide-failure invariant above.
    expect(await readAttempted(attemptedPath(join(dir, 'audio'), 'ch3'))).toBe(true);
  });

  it('too-few anchors → audition fallback → null (no sidecar) → all segments inconclusive with referenceKind too-short', async () => {
    // Fixture: only 3 anchor-eligible vectors (below CENTROID_MIN_N=10) for a
    // Qwen character. This triggers the too-thin branch → auditionCentroid is called.
    // Without a live sidecar, auditionCentroid returns null → referenceKind:'too-short'
    // → all segments of this character score 'inconclusive'.
    //
    // auditionCentroid has no injection seam threaded through scoreBook, so it
    // makes a REAL network call to getResolvedSidecarUrl() (default
    // localhost:9000). Point LOCAL_TTS_URL at a guaranteed-empty ephemeral port
    // instead of relying on the shared default port having nothing on it — the
    // dev box's own TTS sidecar can occupy :9000 (or sit there wedged/unresponsive,
    // see #1243), which turns the "fails fast" assumption into a 15s hang (#1242).
    const probe = createServer();
    const ephemeralPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const prevLocalTtsUrl = process.env.LOCAL_TTS_URL;
    process.env.LOCAL_TTS_URL = `http://127.0.0.1:${ephemeralPort}`;

    const dir = mkdtempSync(join(tmpdir(), 'spk-thin-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    // Only 3 vectors — below CENTROID_MIN_N=10
    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 3; i++) rows.push({ characterId: 'minor', sentenceIds: [i], vec: vec(0.05 * i) });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({ characterId: 'minor', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: {
        minor: {
          voiceEngine: 'qwen',
          resolvedVoiceName: 'qwen-test-uuid',
          voiceId: 'minor',
        },
      },
    }));

    try {
      await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    } finally {
      if (prevLocalTtsUrl === undefined) delete process.env.LOCAL_TTS_URL;
      else process.env.LOCAL_TTS_URL = prevLocalTtsUrl;
    }

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    // All segments should be inconclusive (too-short blind spot)
    for (const v of verdicts!) {
      expect(v.verdict).toBe('inconclusive');
      expect(v.referenceKind).toBe('too-short');
    }

    const centroids = await readCentroids(dir);
    expect(centroids!['minor'].referenceKind).toBe('too-short');
  });

  it("classifies a character book-wide by its FIRST chapter's snapshot — a kokoro-then-qwen mid-book switch is never scored, even in the later qwen chapter", async () => {
    // Companion to qa-report.test.ts's matching eligibility test: confirms
    // scoreBook's own book-wide, first-chapter-wins classification
    // (configuredEngineByChar) is unchanged by the fs-51 review-finding fix —
    // hero renders Kokoro in ch1 (first appearance, wins the classification)
    // then switches to Qwen in ch2; hero is treated as Kokoro-configured
    // everywhere and is never scored, including in ch2.
    const dir = mkdtempSync(join(tmpdir(), 'spk-midswitch-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    const rows1 = [{ characterId: 'hero', sentenceIds: [1], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows1, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows1.map((r) => ({ characterId: 'hero', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { hero: { voiceEngine: 'kokoro' } },
    }));

    const rows2 = [{ characterId: 'hero', sentenceIds: [2], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), rows2, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      segments: rows2.map((r) => ({ characterId: 'hero', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    expect(await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'))).toBeNull();
    expect(await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'))).toBeNull();
    expect(await readCentroids(dir)).toBeNull();
  });

  it('skips Kokoro-configured characters entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-kok-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    const rows = [{ characterId: 'narrator', sentenceIds: [1], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({ characterId: 'narrator', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // No verdicts written (Kokoro skipped)
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).toBeNull();

    const centroids = await readCentroids(dir);
    expect(centroids).toBeNull();
  });
});

describe('centroids-io round-trip', () => {
  it('writes and reads back a centroid record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-ctrnd-'));
    const { writeCentroids, readCentroids: rc } = await import('./centroids-io.js');

    const rows = [
      {
        characterId: 'hero',
        centroid: [0.1, 0.2, 0.3],
        cleanMean: 0.85,
        pSevere: 0.5,
        pBand: 0.7,
        referenceKind: 'in-book' as const,
      },
    ];

    await writeCentroids(dir, rows);
    const back = await rc(dir);
    expect(back).not.toBeNull();
    expect(back!['hero'].referenceKind).toBe('in-book');
    expect(back!['hero'].cleanMean).toBeCloseTo(0.85);
    expect(back!['hero'].centroid).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null on missing file', async () => {
    const { readCentroids: rc } = await import('./centroids-io.js');
    const dir = mkdtempSync(join(tmpdir(), 'spk-miss-'));
    expect(await rc(dir)).toBeNull();
  });
});
