import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { scoreBook } from './aggregate.js';
import { readVerdicts, readAttempted, attemptedPath } from './verdicts-io.js';
import { readCentroids } from './centroids-io.js';
import { readPendingAttempts } from './pending-attempts-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';
import { dotAudiobook, castJsonPath } from '../../workspace/paths.js';
import { castIdHistoryPath } from '../../store/cast-id-history.js';

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

  it('too-few anchors → audition fallback → null (no sidecar), repeated past the retry cap → all segments inconclusive with referenceKind too-short', async () => {
    // Fixture: only 3 anchor-eligible vectors (below CENTROID_MIN_N=10) for a
    // Qwen character. This triggers the too-thin branch → auditionCentroid is called.
    // Without a live sidecar, auditionCentroid returns null — a TRANSIENT failure
    // under the srv-36 hardening design (see pending-attempts-io.ts): a single
    // null no longer immediately degrades the character to 'too-short'. It takes
    // MAX_PENDING_ATTEMPTS (3) consecutive null results before the character
    // becomes terminal — so this call scoreBook 3 times, mirroring the "no
    // sidecar ever comes back" real-world case.
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
      // First MAX_PENDING_ATTEMPTS-1 calls are transient failures — nothing
      // written yet, just a bumped pending-attempts counter.
      for (let i = 0; i < 2; i++) {
        await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
        expect(await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'))).toBeNull();
      }
      // The 3rd consecutive null result spends the retry cap and degrades
      // the character to a terminal too-short row.
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

  it("classifies a character book-wide from the SAME chapter population qa-report.ts uses — first chapter wins even when that first chapter has no embeddings sibling (PR #1433 round-2 review finding)", async () => {
    // fs-51 PR #1433 round-2 finding: scoreBook's OWN classifier call used to
    // feed resolveConfiguredEngineByChar its embeddings-filtered `chapterData`
    // list (chapters where readEmbeddings succeeded), NOT the full
    // segments.json population qa-report.ts's loadSegmentsFiles produces. A
    // character whose first-ever rendered chapter is missing its embeddings
    // sibling would then be classified by scoreBook from a DIFFERENT "first"
    // chapter than qa-report.ts sees — able to disagree book-wide.
    //
    // Fixture: hero renders Kokoro in ch1 (segments.json only — NO
    // embeddings.json, e.g. an embed failure), then Qwen in ch2 (segments.json
    // AND embeddings.json). Before the fix, scoreBook's chapterData list
    // skipped ch1 entirely (no embeddings sibling) so its classifier saw ch2
    // FIRST → classified hero 'qwen' → scored ch2 and could write a
    // voice-mismatch verdict for a character qa-report.ts (whose classifier
    // sees ch1 first, from the unfiltered list) would classify 'kokoro' and
    // exclude from the roster entirely — a self-contradictory report. After
    // the fix, scoreBook classifies hero 'kokoro' book-wide (ch1 wins, same
    // as qa-report.ts) and never scores hero anywhere.
    const dir = mkdtempSync(join(tmpdir(), 'spk-missing-emb-first-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    // ch1: segments.json only — NO embeddings.json sibling.
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: [{ characterId: 'hero', sentenceIds: [1], renderedFallbackEngine: null }],
      characterSnapshots: { hero: { voiceEngine: 'kokoro' } },
    }));

    // ch2: segments.json AND embeddings.json — fully processable.
    const rows2 = [{ characterId: 'hero', sentenceIds: [2], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), rows2, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      segments: rows2.map((r) => ({ characterId: 'hero', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    // hero classified 'kokoro' book-wide (ch1 wins) → never scored, even in
    // ch2 where embeddings ARE present and hero's per-chapter engine is qwen.
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

describe('scoreBook — incremental per-character writes (srv-36 hardening)', () => {
  it('writes centroids.json and a chapter\'s verdict file incrementally, one character at a time, in cheap-first order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-incremental-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });

    // narrator: 12 clean anchors (clears CENTROID_MIN_N=10 — "cheap").
    // ren: 1 anchor only (too-thin — needs the "expensive" audition fallback).
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ characterId: 'narrator', sentenceIds: [i], vec: vec(0) })),
      { characterId: 'ren', sentenceIds: [200], vec: vec(0.02) },
    ];
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({ characterId: r.characterId, sentenceIds: r.sentenceIds })),
        characterSnapshots: {
          narrator: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-narrator', modelKey: 'qwen3-tts-1.7b' },
          ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' },
        },
      }),
    );

    const resolveOrder: string[] = [];
    const fakeSynth = async ({ voiceName }: { voiceName: string }) => {
      resolveOrder.push(voiceName.includes('ren') ? 'ren-synth' : voiceName);
      return { pcm: Buffer.alloc(48_000 * 2), sampleRate: 48_000, mimeType: 'audio/wav' }; // 1s of silence, clears MIN_DURATION_SEC
    };
    const fakeEmbed = async () => vec(0.02);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, {
      onCharacterScored: (characterId: string) => resolveOrder.push(`scored:${characterId}`),
      __testSynthFn: fakeSynth,
      __testEmbedFn: fakeEmbed,
    });

    // narrator (already-clears-the-floor) must be scored before ren (needs synthesis).
    const narratorScoredIdx = resolveOrder.indexOf('scored:narrator');
    const renScoredIdx = resolveOrder.indexOf('scored:ren');
    expect(narratorScoredIdx).toBeGreaterThanOrEqual(0);
    expect(renScoredIdx).toBeGreaterThan(narratorScoredIdx);

    const centroids = await readCentroids(dir);
    expect(centroids!.narrator.referenceKind).toBe('in-book');
    expect(centroids!.ren).toBeDefined();

    const verdicts = await readVerdicts(join(root, 'ch1.render-integrity.json'));
    expect(verdicts!.some((v) => v.characterId === 'narrator')).toBe(true);
    expect(verdicts!.some((v) => v.characterId === 'ren')).toBe(true);
  });

  it('a null (transient) auditionCentroid result increments pendingAttempts and writes nothing to centroids.json for that character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-transient-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), [{ characterId: 'ren', sentenceIds: [1], vec: vec(0) }], EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        segments: [{ characterId: 'ren', sentenceIds: [1] }],
        characterSnapshots: { ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );

    const throwingSynth = async () => { throw new Error('sidecar unreachable'); };

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: throwingSynth });

    expect((await readCentroids(dir))?.ren).toBeUndefined();
    expect((await readPendingAttempts(dir))?.ren).toBe(1);
    expect(await readVerdicts(join(root, 'ch1.render-integrity.json'))).toBeNull();
  });

  it('after 3 consecutive null results the character degrades to a terminal too-short row and stops retrying (absorbing state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-cap-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), [{ characterId: 'ren', sentenceIds: [1], vec: vec(0) }], EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        segments: [{ characterId: 'ren', sentenceIds: [1] }],
        characterSnapshots: { ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );

    let synthCalls = 0;
    const throwingSynth = async () => { synthCalls++; throw new Error('sidecar unreachable'); };

    for (let i = 0; i < 3; i++) {
      await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: throwingSynth });
    }
    expect(synthCalls).toBe(3);
    expect((await readCentroids(dir))?.ren.referenceKind).toBe('too-short');
    expect((await readPendingAttempts(dir))?.ren).toBeUndefined();

    // 4th call — the state is absorbing, the synth fn must NOT fire again.
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: throwingSynth });
    expect(synthCalls).toBe(3);
  });

  it('a { kind: "too-short" } audition result (pool completed, still too thin) writes a terminal row immediately without ever touching pending-attempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tooshort-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), [{ characterId: 'ren', sentenceIds: [1], vec: vec(0) }], EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        segments: [{ characterId: 'ren', sentenceIds: [1] }],
        characterSnapshots: { ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );
    // Renders that never clear MIN_DURATION_SEC — auditionCentroid exhausts
    // its budget and returns { kind: 'too-short' }, not null.
    const tooShortSynth = async () => ({ pcm: Buffer.alloc(10), sampleRate: 48_000, mimeType: 'audio/wav' });

    let synthCalls = 0;
    const countingSynth = async (...args: Parameters<typeof tooShortSynth>) => { synthCalls++; return tooShortSynth(...args); };

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: countingSynth });

    expect((await readCentroids(dir))?.ren.referenceKind).toBe('too-short');
    expect((await readPendingAttempts(dir))?.ren).toBeUndefined();

    const callsAfterFirst = synthCalls;
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: countingSynth });
    expect(synthCalls).toBe(callsAfterFirst); // absorbing — no second attempt
  });

  it('scoreBook returns usedQwenTiers reflecting the tiers actually seen this call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tiers-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    const rows = Array.from({ length: 12 }, (_, i) => ({ characterId: 'narrator', sentenceIds: [i], vec: vec(0) }));
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({ characterId: r.characterId, sentenceIds: r.sentenceIds })),
        characterSnapshots: { narrator: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-narrator', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );
    const result = await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(result.usedQwenTiers).toEqual({ keep06: false, keep17: true });
  });
});

describe('scoreBook — canonical cast-id joins (#3362 review finding)', () => {
  it('resolves a raw embedding-row characterId to the canonical cast id before joining against characterSnapshots, so anchor-eligible rows are scored and no audition is triggered', async () => {
    // Repro (PR #3375 review pass 1): finalize-chapter-write.ts (#3370) now
    // keys characterSnapshots by the CANONICAL cast id — here 'the_torment',
    // resolved from the segments' raw 'the-torment' via the normalised-id
    // tier (same collapse as #2040's own repro: analyzer mints hyphens,
    // cast-create mints underscores). Embedding rows are frozen at synth
    // time and still carry the RAW 'the-torment' group id. Before the fix,
    // `stochasticChars.has(row.characterId)` and the `charId` equality check
    // in scoreAndMergeCharacter both failed on this mismatch: every row was
    // dropped, no render-integrity.json was written, and the too-thin
    // in-book pool fell through to the (real, network-calling) audition path.
    const dir = mkdtempSync(join(tmpdir(), 'spk-canon-id-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'the_torment', name: 'The Torment', gender: 'female', attributes: [] }] }),
    );

    // 12 anchor-eligible rows (>= CENTROID_MIN_N) clustered tightly — an
    // in-book centroid resolves cleanly WITHOUT ever calling auditionCentroid,
    // as long as the rows actually get past the characterId join.
    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'the-torment', sentenceIds: [i], vec: vec(0.02 * i) });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      // #3362 pass-4 fix — segments.json's own `segments[]` entries carry
      // the RAW id verbatim, PLUS the `resolvedCharacterId` stamp
      // finalize-chapter-write.ts writes (the same resolution it applied to
      // key `characterSnapshots`), since aggregate.ts's scoring join now
      // reads THAT stamp back instead of re-deriving it.
      segments: rows.map((r) => ({ characterId: 'the-torment', resolvedCharacterId: 'the_torment', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      // characterSnapshots IS canonical-keyed (#3370).
      characterSnapshots: { the_torment: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-the-torment', modelKey: 'qwen3-tts-0.6b' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // The render-integrity file IS written, with all 12 rows scored — the
    // pre-fix bug produced zero rows here (rowsForChar.length === 0 skipped
    // the write entirely).
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12);
    // Every persisted row is stamped with the CANONICAL id, matching what
    // qa-report.ts's characterSnapshots-derived roster expects to find.
    expect(verdicts!.every((v) => v.characterId === 'the_torment')).toBe(true);
    // Every row resolved against a real in-book reference — none fell to the
    // pre-fix 'inconclusive'/'too-short' path a dropped join would produce.
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);
    expect(verdicts!.some((v) => v.verdict === 'voice-match')).toBe(true);

    // The centroid resolved from the real in-book anchors — never degraded
    // to an audition (which would have made a real network call and, absent
    // a sidecar, logged a transient failure / left the character unresolved).
    const centroids = await readCentroids(dir);
    expect(centroids!['the_torment'].referenceKind).toBe('in-book');
  });

  it('scores a chapter rendered under a character id retired AFTER rendering, under the render-time identity — no regression vs main (#3362 review pass 2, 🟠A)', async () => {
    // Repro (PR #3375 review pass 2): ch1 rendered while 'bob' was still the
    // live cast id — characterSnapshots/segments both carry 'bob'. AFTER that
    // render, a cast merge/rename retires 'bob' in favour of 'robert'
    // (cast.json now only has 'robert'; cast-id-history.json records
    // bob -> robert). Resolving the row through the book's CURRENT resolver
    // (review pass 1's fix) moves it onto 'robert', which matches nothing in
    // ch1's own raw-keyed `stochasticChars`/`orderedChars` (sourced from
    // ch1's own `characterSnapshots`, still keyed 'bob') — every row is
    // dropped, no render-integrity.json is written, and the too-thin pool
    // falls through to a (real, network-calling) audition. `main` never had
    // this problem: it scores 'bob' under its own render-time identity,
    // regardless of any later retirement.
    const dir = mkdtempSync(join(tmpdir(), 'spk-retired-after-render-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'robert', name: 'Robert', gender: 'male', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { bob: 'robert' } }),
    );

    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'bob', sentenceIds: [i], vec: vec(0.02 * i) });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: rows.map((r) => ({ characterId: 'bob', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { bob: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-bob', modelKey: 'qwen3-tts-0.6b' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // The render-integrity file IS written, with all 12 rows scored under
    // 'bob' — matching `main`'s behaviour exactly, despite the retirement.
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12);
    expect(verdicts!.every((v) => v.characterId === 'bob')).toBe(true);
    // Resolved from real in-book anchors — never degraded to an audition.
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['bob'].referenceKind).toBe('in-book');
    expect(centroids!['robert']).toBeUndefined();
  });

  it('scores a row resolved through cast-id-history AT RENDER TIME under its own chapter\'s canonical snapshot key — no phantom audition (#3362 review pass 3, 🟠C)', async () => {
    // Repro (PR #3375 review pass 3, 🟠C): the render resolves a group id
    // through cast + history (synthesise-chapter.ts), and finalize keys the
    // chapter's OWN characterSnapshots by that resolved id. Here cast is
    // [mairin], history is {mayrin: mairin} — so 'mayrin' (the raw synth-time
    // id, frozen on embedding rows and segments) resolved to 'mairin' at
    // render time, and ch1's own characterSnapshots is keyed 'mairin'.
    // Review pass 2's book-wide, HISTORY-FREE resolver had no exact or
    // normalised match for 'mayrin' against the book-wide snapshot-key set
    // (only 'mairin' is in it) and left the row raw — dropping every row,
    // writing no render-integrity.json, and falling through to a phantom
    // audition. #3362 pass-4 fix (🟠D): rather than re-deriving this bridge
    // from cast-id-history at SCORING time (which pass 3's per-chapter
    // resolver still did, and which broke again the moment history changed
    // AFTER render — see aggregate.test.ts's 'canonical cast-id joins survive
    // history changes AFTER render' describe block below), the segment
    // itself now carries the `resolvedCharacterId` stamp
    // finalize-chapter-write.ts wrote at RENDER time, and scoring simply
    // reads it back.
    const dir = mkdtempSync(join(tmpdir(), 'spk-history-tier-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );

    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'mayrin', sentenceIds: [i], vec: vec(0.02 * i) });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      // #3362 pass-4 fix — the stamp finalize-chapter-write.ts wrote from
      // resolving 'mayrin' through cast-id-history AT RENDER TIME; scoring
      // now joins on this stamp rather than re-deriving it from a resolver.
      segments: rows.map((r) => ({ characterId: 'mayrin', resolvedCharacterId: 'mairin', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { mairin: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-mairin', modelKey: 'qwen3-tts-0.6b' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // The render-integrity file IS written, with all 12 rows keyed 'mairin'
    // (this chapter's own canonical snapshot key) — never left raw as
    // 'mayrin', and never falling through to an audition.
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12);
    expect(verdicts!.every((v) => v.characterId === 'mairin')).toBe(true);
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['mairin'].referenceKind).toBe('in-book');
    expect(centroids!['mayrin']).toBeUndefined();
  });

  it('does not let a book-wide exact key shadow another chapter\'s history-resolved key — a merged character\'s post-merge chapter keeps its own voice\'s centroid (#3362 review pass 3, 🟠C variant)', async () => {
    // Repro (PR #3375 review pass 3, 🟠C variant): cast [robert], history
    // {bob: robert}. ch1 rendered PRE-merge: rows, segments AND snapshot are
    // all 'bob' (voice A, θ≈0). ch2 rendered POST-merge: its SEGMENTS still
    // carry 'bob' (attribution retained — this is the shape the 🟠A merge
    // fix's own test already covers when ch2's segments carry the survivor's
    // id instead), but its SNAPSHOT is 'robert' (voice B, θ≈π/2) — i.e. the
    // render resolved 'bob' through history to 'robert' at render time, same
    // as the 🟠C main repro above, just on a SECOND chapter that shares a
    // raw id with a first chapter's own UNRELATED exact key.
    //
    // Review pass 2's book-wide resolver had 'bob' as an EXACT key (from
    // ch1's own snapshot) in its book-wide candidate set, so ch2's 'bob' rows
    // resolved to ch1's book-wide 'bob' entry instead of through ch2's OWN
    // history bridge to 'robert' — pooling two different voices' rows under
    // one key, and leaving 'robert' with a phantom audition and 0 rows.
    const dir = mkdtempSync(join(tmpdir(), 'spk-history-shadow-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'robert', name: 'Robert', gender: 'male', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { bob: 'robert' } }),
    );

    const bobRows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) bobRows.push({ characterId: 'bob', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), bobRows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: bobRows.map((r) => ({ characterId: 'bob', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { bob: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-bob', modelKey: 'qwen3-tts-0.6b' } },
    }));

    // ch2's SEGMENTS still say 'bob' (raw, frozen at synth time), but its
    // SNAPSHOT (resolved through history at render time) is 'robert' —
    // #3362 pass-4 fix: stamped with `resolvedCharacterId: 'robert'`, the
    // same resolution finalize-chapter-write.ts applied to key the snapshot.
    const halfPi = Math.PI / 2;
    const ch2Rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) ch2Rows.push({ characterId: 'bob', sentenceIds: [200 + i], vec: vec(halfPi + 0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), ch2Rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      modelKey: 'qwen3-tts-0.6b',
      segments: ch2Rows.map((r) => ({ characterId: 'bob', resolvedCharacterId: 'robert', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { robert: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-robert', modelKey: 'qwen3-tts-0.6b' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    const bobVerdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(bobVerdicts).not.toBeNull();
    expect(bobVerdicts!.length).toBe(12);
    expect(bobVerdicts!.every((v) => v.characterId === 'bob')).toBe(true);

    // ch2's rows resolve to 'robert' via ITS OWN history bridge, not to
    // ch1's book-wide 'bob' exact key.
    const robertVerdicts = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(robertVerdicts).not.toBeNull();
    expect(robertVerdicts!.length).toBe(12);
    expect(robertVerdicts!.every((v) => v.characterId === 'robert')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['bob'].referenceKind).toBe('in-book');
    expect(centroids!['robert'].referenceKind).toBe('in-book');
    // No pooling: bob's cluster stays near θ≈0, robert's near θ≈π/2. A
    // pooled centroid (mixing both voices) would sit roughly between them.
    expect(centroids!['bob'].centroid[0]).toBeGreaterThan(0.9); // ≈ cos(0)
    expect(centroids!['robert'].centroid[1]).toBeGreaterThan(0.9); // ≈ sin(π/2)
  });

  it('never borrows a LATER, unrelated chapter\'s canonical snapshot key for a chapter with no snapshot entry at all — transitional book (#3362 review pass 3, 🟠B continued)', async () => {
    // Repro (PR #3375 review pass 3, 🟠B continued): ch1 is a pre-#3362
    // chapter with NO characterSnapshots entry at all for this character —
    // rendered before finalize started keying snapshots canonically. ch2 is
    // a post-#3362 chapter with a canonical snapshot for an UNRELATED
    // character that happens to normalise the same as ch1's raw segment id
    // ('the_torment' vs 'the-torment'). Review pass 2's book-wide resolver
    // pooled ch1's raw rows onto ch2's book-wide 'the_torment' entry
    // (aggregate.ts wrote ch1.render-integrity.json keyed 'the_torment'),
    // which then disagreed with chapter-qa-repair.ts's own (already
    // per-chapter) resolver — the acoustic gate looked up a centroid keyed
    // by ch1's raw id and never found the borrowed entry, silently skipping
    // the acoustic check for a wrong-voice take.
    //
    // Aggregate's per-chapter resolver (pass 3) never borrows ch2's key: ch1
    // has an EMPTY candidate cast for this character (no snapshot entry, no
    // history bridge target present), so its raw rows pass through
    // unresolved and — since no chapter's OWN snapshot ever uses that raw
    // spelling as a key — are never classified stochastic and stay
    // unscored, exactly matching `main`'s own pre-#3362 behaviour (no
    // resolver, raw `characterId` matched directly against raw snapshot
    // keys) rather than borrowing a later chapter's canonical id.
    const dir = mkdtempSync(join(tmpdir(), 'spk-transitional-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'the_torment', name: 'The Torment', gender: 'male', attributes: [] }] }),
    );

    // ch1: pre-#3362 shape — segments/rows raw 'the-torment', NO snapshot
    // entry for it at all.
    const ch1Rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) ch1Rows.push({ characterId: 'the-torment', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), ch1Rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: ch1Rows.map((r) => ({ characterId: 'the-torment', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: {},
    }));

    // ch2: post-#3362 shape — UNRELATED chapter, canonical snapshot
    // 'the_torment', own distinct voice.
    const halfPi = Math.PI / 2;
    const ch2Rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) ch2Rows.push({ characterId: 'the_torment', sentenceIds: [200 + i], vec: vec(halfPi + 0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), ch2Rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      modelKey: 'qwen3-tts-0.6b',
      segments: ch2Rows.map((r) => ({ characterId: 'the_torment', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { the_torment: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-the-torment', modelKey: 'qwen3-tts-0.6b' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    // ch1's rows are NEVER written under ch2's borrowed 'the_torment' key —
    // and, since no chapter's own snapshot ever names the raw spelling
    // either, ch1 stays unscored (no render-integrity.json at all),
    // matching the "pre-PR chapters stay unscored until re-rendered" cost
    // the fix accepts rather than silently misattributing.
    const ch1Verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(ch1Verdicts === null || ch1Verdicts.length === 0).toBe(true);

    // ch2 is scored correctly and independently, under its own key, with
    // its own centroid — never pooled with ch1's rows.
    const ch2Verdicts = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2Verdicts).not.toBeNull();
    expect(ch2Verdicts!.length).toBe(12);
    expect(ch2Verdicts!.every((v) => v.characterId === 'the_torment')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['the_torment'].referenceKind).toBe('in-book');
    // No centroid pooled from ch1's rows — the_torment's centroid stays
    // near its own cluster (θ≈π/2), not dragged toward ch1's (θ≈0).
    expect(centroids!['the_torment'].centroid[1]).toBeGreaterThan(0.9); // ≈ sin(π/2)
  });

  it('does not pool a pre-merge character\'s rows into the surviving character\'s centroid, and writes no duplicate verdict rows per sentence (#3362 review pass 2, 🟠A merge variant)', async () => {
    // 'bob' rendered ch1 (own voice, own centroid cluster near θ≈0), then was
    // merged into 'robert', who has his OWN chapter (ch2, own voice, own
    // cluster near θ≈π/2 — deliberately far from bob's so pooling would be
    // detectable both by count AND by centroid direction). A naive full
    // current-resolver join would fold bob's ch1 rows into 'robert' (since
    // 'robert' already exists as a roster entry from ch2), corrupting
    // robert's centroid with a different voice's embeddings and duplicating
    // rows per sentence when ch2's own robert-rendered rows are ALSO scored
    // under 'robert'.
    const dir = mkdtempSync(join(tmpdir(), 'spk-merge-no-pool-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'robert', name: 'Robert', gender: 'male', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { bob: 'robert' } }),
    );

    const bobRows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) bobRows.push({ characterId: 'bob', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), bobRows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: bobRows.map((r) => ({ characterId: 'bob', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { bob: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-bob', modelKey: 'qwen3-tts-0.6b' } },
    }));

    const robertRows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    const halfPi = Math.PI / 2;
    for (let i = 0; i < 12; i++) robertRows.push({ characterId: 'robert', sentenceIds: [200 + i], vec: vec(halfPi + 0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), robertRows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      modelKey: 'qwen3-tts-0.6b',
      segments: robertRows.map((r) => ({ characterId: 'robert', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { robert: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-robert', modelKey: 'qwen3-tts-0.6b' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    const bobVerdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(bobVerdicts).not.toBeNull();
    expect(bobVerdicts!.length).toBe(12);
    expect(bobVerdicts!.every((v) => v.characterId === 'bob')).toBe(true);

    const robertVerdicts = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(robertVerdicts).not.toBeNull();
    expect(robertVerdicts!.length).toBe(12);
    expect(robertVerdicts!.every((v) => v.characterId === 'robert')).toBe(true);
    // No duplicate rows per sentence — bob's rows never land in ch2's file
    // and vice versa.
    const robertSentenceIds = robertVerdicts!.map((v) => v.sentenceIds[0]).sort((a, b) => a - b);
    expect(new Set(robertSentenceIds).size).toBe(12);

    const centroids = await readCentroids(dir);
    expect(centroids!['bob'].referenceKind).toBe('in-book');
    expect(centroids!['robert'].referenceKind).toBe('in-book');
    // Distinct centroids — bob's cluster (θ≈0) never pooled into robert's
    // (θ≈π/2). A pooled centroid would sit roughly between the two clusters
    // (cosine ≈ 0 against both original clusters); the real, unpooled
    // centroids stay close to their own cluster's direction.
    const bobCentroid = centroids!['bob'].centroid;
    const robertCentroid = centroids!['robert'].centroid;
    expect(bobCentroid[0]).toBeGreaterThan(0.9); // ≈ cos(0)
    expect(robertCentroid[1]).toBeGreaterThan(0.9); // ≈ sin(π/2)
  });
});

describe('scoreBook — canonical cast-id joins survive history changes AFTER render (#3362 pass-4, 🟠D)', () => {
  // Every test here starts from a chapter whose segments.json ALREADY
  // carries the `resolvedCharacterId` stamp finalize-chapter-write.ts wrote
  // at render time (the state 761d28a1's own tests pin) — then mutates
  // cast.json/cast-id-history.json AFTER that, before calling scoreBook, to
  // prove scoring never re-reads them for the identity join. Pass-3's
  // per-chapter resolver (removed by this fix) re-derived the join from
  // whatever cast-id-history.json says at SCORING time, so every one of
  // these mutations reopened review pass 3's 🟠C phantom-audition symptom
  // (pass-4's repro table, S4/S5/S6/S8) or left stale verdict rows behind
  // on a re-score (S7).

  it('S4: a rename recorded AFTER render does not move the scored identity off the render-time stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-s4-rename-after-render-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'mayrin', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: rows.map((r) => ({ characterId: 'mayrin', resolvedCharacterId: 'mairin', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { mairin: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-mairin', modelKey: 'qwen3-tts-0.6b' } },
    }));

    // AFTER render: 'mairin' is renamed to 'mairin-oakes' — cast.json and
    // cast-id-history.json both move (retireCharacterId path-compresses the
    // very bridge that resolved this render). Neither the segments.json nor
    // the embedding rows change.
    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'mairin-oakes', name: 'Mairin Oakes', gender: 'female', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin-oakes', mairin: 'mairin-oakes' } }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // Still 12 rows keyed 'mairin' (the render-time stamp) — never
    // 'mairin-oakes', never dropped, never an audition (which would need a
    // real sidecar call this test never provides — a hang/throw here would
    // itself prove the row fell through to Option-B).
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12);
    expect(verdicts!.every((v) => v.characterId === 'mairin')).toBe(true);
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['mairin'].referenceKind).toBe('in-book');
    expect(centroids!['mairin-oakes']).toBeUndefined();
  });

  it('S5: rejecting the mayrin/mairin pair AFTER render does not move the scored identity off the render-time stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-s5-reject-after-render-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'mayrin', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: rows.map((r) => ({ characterId: 'mayrin', resolvedCharacterId: 'mairin', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { mairin: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-mairin', modelKey: 'qwen3-tts-0.6b' } },
    }));

    // AFTER render: a user rejects "mayrin is not Mairin" — the bridge that
    // resolved this render is torn down via rejectedPairs and
    // forgetSupersededId, with no replacement.
    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12);
    expect(verdicts!.every((v) => v.characterId === 'mairin')).toBe(true);
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);
  });

  it('S6: renaming the SURVIVOR of an earlier merge AFTER render does not disturb either chapter\'s scored identity or pool their centroids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-s6-survivor-rename-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    // ch1: pre-merge render, raw+stamp both 'bob' (exact match, no resolver
    // needed — the shape the 🟠C variant test above already pins).
    const bobRows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) bobRows.push({ characterId: 'bob', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), bobRows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: bobRows.map((r) => ({ characterId: 'bob', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { bob: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-bob', modelKey: 'qwen3-tts-0.6b' } },
    }));

    // ch2: post-merge render, raw 'bob' stamped 'robert' (finalize resolved
    // it through the bob->robert bridge at render time).
    const halfPi = Math.PI / 2;
    const ch2Rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) ch2Rows.push({ characterId: 'bob', sentenceIds: [200 + i], vec: vec(halfPi + 0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch2.embeddings.json'), ch2Rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch2.segments.json'), JSON.stringify({
      chapterId: 2,
      modelKey: 'qwen3-tts-0.6b',
      segments: ch2Rows.map((r) => ({ characterId: 'bob', resolvedCharacterId: 'robert', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { robert: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-robert', modelKey: 'qwen3-tts-0.6b' } },
    }));

    // AFTER both renders: the survivor 'robert' is itself renamed to
    // 'roberto' — cast.json and cast-id-history.json both move again.
    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'roberto', name: 'Roberto', gender: 'male', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { bob: 'roberto', robert: 'roberto' } }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }, { id: 2, slug: 'ch2' }]);

    // ch1 stays 'bob', ch2 stays 'robert' — neither moves to 'roberto', and
    // neither pools into the other (distinct centroids, own clusters).
    const bobVerdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(bobVerdicts).not.toBeNull();
    expect(bobVerdicts!.length).toBe(12);
    expect(bobVerdicts!.every((v) => v.characterId === 'bob')).toBe(true);

    const robertVerdicts = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(robertVerdicts).not.toBeNull();
    expect(robertVerdicts!.length).toBe(12);
    expect(robertVerdicts!.every((v) => v.characterId === 'robert')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['bob'].referenceKind).toBe('in-book');
    expect(centroids!['robert'].referenceKind).toBe('in-book');
    expect(centroids!['roberto']).toBeUndefined();
    expect(centroids!['bob'].centroid[0]).toBeGreaterThan(0.9); // ≈ cos(0)
    expect(centroids!['robert'].centroid[1]).toBeGreaterThan(0.9); // ≈ sin(π/2)
  });

  it('S7: re-scoring after a history change never leaves stale verdict rows behind — the stamp makes the identity stable across runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-s7-rescore-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'mayrin', sentenceIds: [i], vec: vec(0.02 * i) });
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: rows.map((r) => ({ characterId: 'mayrin', resolvedCharacterId: 'mairin', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { mairin: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-mairin', modelKey: 'qwen3-tts-0.6b' } },
    }));
    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }] }),
    );
    writeFileSync(castIdHistoryPath(dir), JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const firstPass = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(firstPass!.length).toBe(12);
    expect(firstPass!.every((v) => v.characterId === 'mairin')).toBe(true);

    // Between the two scoreBook calls: 'mairin' is renamed to
    // 'mairin-oakes' — nothing else about the render changes.
    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'mairin-oakes', name: 'Mairin Oakes', gender: 'female', attributes: [] }] }),
    );
    writeFileSync(
      castIdHistoryPath(dir),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin-oakes', mairin: 'mairin-oakes' } }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // The stamp is unaffected by the rename, so the re-score resolves the
    // SAME 12 rows under the SAME key ('mairin') both times —
    // `mergeVerdictRows` drops and rewrites exactly that key's rows, never
    // leaving a stale duplicate under a different one.
    const secondPass = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(secondPass).not.toBeNull();
    expect(secondPass!.length).toBe(12);
    expect(secondPass!.every((v) => v.characterId === 'mairin')).toBe(true);
    const sentenceIds = secondPass!.map((v) => v.sentenceIds[0]).sort((a, b) => a - b);
    expect(new Set(sentenceIds).size).toBe(12); // no duplicates

    // Discriminator (pass-4's repro table records exactly 1 audition for
    // this scenario pre-fix): the re-score must resolve the SAME 12 rows it
    // already has as real in-book anchors again, never falling through to
    // Option-B — so nothing is left pending a retry.
    expect((await readPendingAttempts(dir))?.mairin).toBeUndefined();
    const centroids = await readCentroids(dir);
    expect(centroids!['mairin'].referenceKind).toBe('in-book');
  });

  it('S8: a link recorded AFTER render between an orphaned narrator-voiced id and a real character never pools the orphan\'s rows into that character\'s anchors/verdicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-s8-late-link-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(dir), { recursive: true });

    // 12 real 'mairin' anchor rows (exact match, no stamp needed) plus 6
    // narrator-voiced ORPHAN rows rendered under 'mayrin' — at render time
    // 'mayrin' had NO cast/history bridge at all, so finalize never stamped
    // `resolvedCharacterId` on them (they carry no snapshot entry either).
    const mairinRows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) mairinRows.push({ characterId: 'mairin', sentenceIds: [i], vec: vec(0.02 * i) });
    const orphanRows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    const halfPi = Math.PI / 2;
    for (let i = 0; i < 6; i++) orphanRows.push({ characterId: 'mayrin', sentenceIds: [100 + i], vec: vec(halfPi + 0.02 * i) });
    const allRows = [...mairinRows, ...orphanRows];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), allRows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: [
        ...mairinRows.map((r) => ({ characterId: 'mairin', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
        // No `resolvedCharacterId` — unresolvable at render time.
        ...orphanRows.map((r) => ({ characterId: 'mayrin', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      ],
      // No snapshot entry for 'mayrin' at all — an orphaned id has no
      // per-character snapshot (matching the narrator-substitution shape).
      characterSnapshots: { mairin: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-mairin', modelKey: 'qwen3-tts-0.6b' } },
    }));

    // AFTER render: a link is recorded ({mayrin: mairin}) — a later
    // analysis pass decided the orphan really was Mairin after all.
    writeFileSync(
      castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }] }),
    );
    writeFileSync(castIdHistoryPath(dir), JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // Only the 12 real 'mairin' rows are scored — the 6 orphan rows never
    // joined 'mairin's anchors (which would have forced a bimodal/audition
    // fallback) and never appear as 'mairin' mismatches. Matching `main`'s
    // own behaviour (and 761d28a1's): an id absent from this chapter's own
    // snapshot stays unscored, regardless of a LATER link.
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12);
    expect(verdicts!.every((v) => v.characterId === 'mairin')).toBe(true);
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);

    const centroids = await readCentroids(dir);
    expect(centroids!['mairin'].referenceKind).toBe('in-book');
    // The centroid stays tight around the real cluster (θ≈0) — never
    // dragged/bimodal from the orphan's θ≈π/2 rows.
    expect(centroids!['mairin'].centroid[0]).toBeGreaterThan(0.9);
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
