/* #1945 — replaces the impossible-to-trip B-06 manual acceptance step
   (docs/testing/fs38-wave3-onbox-acceptance.md) with an automated test.

   B-06 asked an operator to degrade the clone's SOURCE clip until the
   advisory clone-fidelity cosine (assessCloneFidelity, tts/clone-fidelity.ts)
   dropped below CLONE_FIDELITY_MIN. That can't work: the metric cosines the
   clone's audition preview against its OWN master clip, so degrading the
   source degrades both sides of the comparison together and the cosine barely
   moves (on-box: clean 0.891/0.881 vs. band-limited-source 0.881 — *not
   lower*; see #1945's implementation-brief comment). The threshold is being
   KEPT as a documented catastrophe-only backstop (fires on a wrong-speaker
   clone, e.g. the on-box 0.158 datapoint), not recalibrated or deleted — see
   clone-fidelity.ts's file-header comment for the full rationale.

   This test proves the backstop is actually WIRED UP end-to-end through the
   real POST /api/voice-library/clone route, stubbing the boundary the brief
   specifies — `embedSegment` (tts/embed-client.ts) — rather than the
   assessCloneFidelity function itself (already stubbed a level up in
   voice-library.test.ts) or trying to synthesise audio that scores low. Both
   assertions compare against the live CLONE_FIDELITY_MIN constant, not a
   hardcoded number, so the test fails if the threshold is later moved past
   either injected cosine — proof it is wired to the threshold, not to a
   string. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const { deriveMock, decodeMock, embedSegmentMock } = vi.hoisted(() => ({
  deriveMock: vi.fn(),
  decodeMock: vi.fn(),
  embedSegmentMock: vi.fn(),
}));
vi.mock('../tts/derive-engine-artifact.js', () => ({ deriveEngineArtifact: deriveMock }));
vi.mock('../tts/embed-client.js', () => ({ embedSegment: embedSegmentMock }));
vi.mock('../tts/mp3.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, decodeAudioToPcm: decodeMock };
});

let dir: string;
let app: Express;
let CLONE_FIDELITY_MIN: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-voicelib-fidelity-'));
  process.env.WORKSPACE_DIR = dir;
  process.env.VOICE_SAMPLE_AUDIO_DIR = join(dir, 'audio-voices');
  vi.resetModules();

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factory above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
  const { voiceLibraryRouter } = await import('./voice-library.js');
  const cloneFidelityMod = await import('../tts/clone-fidelity.js');
  const modelPaths = await import('../tts/model-paths.js');
  CLONE_FIDELITY_MIN = cloneFidelityMod.CLONE_FIDELITY_MIN;

  app = express();
  app.use(express.json());
  app.use('/api/voice-library', voiceLibraryRouter);

  deriveMock.mockReset();
  // Use the actual current base model so cloned entries are fresh, not stale
  const currentModel = modelPaths.currentQwenBaseModel();
  deriveMock.mockResolvedValue({ previewPcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24_000, baseModel: currentModel });
  embedSegmentMock.mockReset();
  decodeMock.mockReset();
  decodeMock.mockResolvedValue(Buffer.from([0, 0, 0, 0]));
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function seedCandidate(candidateId: string) {
  const { writeCandidate } = await import('../workspace/clone-candidate.js');
  await writeCandidate(
    candidateId,
    {
      sampleRate: 24000,
      durationSeconds: 12,
      transcript: 'my own voice sample',
      transcriptSource: 'whisper',
      captureMethod: 'upload',
    },
    Buffer.from('RIFFfake-wav-bytes'),
  );
}

function postClone(candidateId: string) {
  return request(app)
    .post('/api/voice-library/clone')
    .send({
      candidateId,
      /* #1959 — family-with-permission now requires attestedBy up front. */
      consent: {
        personName: 'Mum',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedBy: 'Mum',
      },
    });
}

describe('POST /api/voice-library/clone — clone-fidelity advisory (#1945)', () => {
  /* ── CLONE_FIDELITY_MIN pin ──────────────────────────────────────────────
     #1945 weighed three options and chose "keep 0.3 as a catastrophe-only
     backstop" over recalibrating upward (~0.6) — rejected because, with about
     four datapoints and short-clip embeddings measured at 0.56-0.71, a higher
     threshold risks false-warning on legitimate clones.

     Without this pin that decision is enforced NOWHERE: the cases below inject
     0.9 and 0.0, so they only fail if the constant moves above 0.9 or below 0.
     A change to 0.6 — the exact option that was rejected — would keep the whole
     suite green and land silently. Same idiom as render-integrity's CUTOFFS pin
     in score.test.ts. If you are deliberately recalibrating, update #1945's
     disposition and this pin together. */
  it('pins CLONE_FIDELITY_MIN at its deliberated value', () => {
    expect(CLONE_FIDELITY_MIN).toBe(0.3);
  });

  it('persists NO warning when the embed boundary scores the clone above CLONE_FIDELITY_MIN', async () => {
    // Two near-aligned (not identical) unit vectors -> cosine 0.9, comfortably
    // above the current 0.3 threshold but not an unreachable 1.0 ceiling, so
    // the assertion below still catches a threshold raised past this value.
    embedSegmentMock
      .mockResolvedValueOnce(Float32Array.from([1, 0, 0]))
      .mockResolvedValueOnce(Float32Array.from([0.9, Math.sqrt(1 - 0.9 * 0.9), 0]));

    await seedCandidate('cand-above');
    const res = await postClone('cand-above');

    expect(res.status).toBe(200);
    expect(res.body.provenance).toBe('cloned');
    const cosine = res.body.sampleMeta.qualityChecks.cloneCosine as number;
    expect(cosine).toBeGreaterThanOrEqual(CLONE_FIDELITY_MIN);
    expect(cosine).toBeCloseTo(0.9, 5);
    expect(res.body.sampleMeta.qualityChecks.cloneFidelityWarning).toBeUndefined();
  });

  it('persists a warning AND still saves the clone when the embed boundary scores below CLONE_FIDELITY_MIN', async () => {
    // Orthogonal vectors -> cosine 0, well below any sane threshold.
    embedSegmentMock
      .mockResolvedValueOnce(Float32Array.from([1, 0, 0]))
      .mockResolvedValueOnce(Float32Array.from([0, 1, 0]));

    await seedCandidate('cand-below');
    const res = await postClone('cand-below');

    // Non-blocking: the clone still saves as a ready, cloned entry.
    expect(res.status).toBe(200);
    expect(res.body.provenance).toBe('cloned');
    expect(res.body.engines.qwen.status).toBe('ready');

    const cosine = res.body.sampleMeta.qualityChecks.cloneCosine as number;
    expect(cosine).toBeLessThan(CLONE_FIDELITY_MIN);
    expect(res.body.sampleMeta.qualityChecks.cloneFidelityWarning).toMatch(/loosely/i);

    // The candidate is consumed either way — the warning doesn't block cleanup.
    const { readCandidate } = await import('../workspace/clone-candidate.js');
    expect(await readCandidate('cand-below')).toBeNull();
  });
});
