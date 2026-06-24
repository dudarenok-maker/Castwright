/* Integration tests for the voice-sample router. Stubs the TTS provider so
   the encoder boundary (real ffmpeg) is the only system dependency. Forces
   the on-disk cache root into a tempdir via VOICE_SAMPLE_AUDIO_DIR so a
   run doesn't leak files into the dev server's audio dir. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* vi.hoisted so the inner factory below can close over the same vi.fn()
   instance we drive from the tests. selectTtsProvider() returns this stub
   provider; every test orchestrates synthesize() to choose the path. */
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));

vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: vi.fn(() => ({ synthesize })),
  };
});

let audioDir: string;
let app: Express;

beforeAll(async () => {
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-voice-sample-test-'));
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;

  /* Defer import so the route module reads VOICE_SAMPLE_AUDIO_DIR at load
     time (it's captured in a module-level const). */
  const { voiceSampleRouter } = await import('./voice-sample.js');

  app = express();
  app.use(express.json());
  app.use('/api/voices', voiceSampleRouter);
});

afterAll(() => {
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

beforeEach(() => {
  synthesize.mockReset();
  /* Default: 0.5 s of silence at 24 kHz mono int16. ffmpeg encodes this in
     well under a second, so the suite stays fast. */
  const pcm = Buffer.alloc(24_000 * 2 * 0.5, 0);
  synthesize.mockResolvedValue({ pcm, sampleRate: 24_000, mimeType: 'audio/L16' });
  /* Reset disk cache so cache-miss/hit ordering is deterministic. */
  for (const f of readdirSync(audioDir)) rmSync(join(audioDir, f), { force: true });
});

function isMp3Magic(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  /* ID3v2 tag header. */
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  /* Raw MPEG-2 Layer III frame sync: 11 set bits at the start. */
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

describe('voice-sample router', () => {
  describe('happy path', () => {
    it('synthesises, encodes to MP3, caches; second call short-circuits', async () => {
      const body = {
        modelKey: 'coqui-xtts-v2',
        voice: { id: 'v_marlow', character: 'Marlow', attributes: ['Male'] },
        text: 'Hello world. This is a voice sample.',
      };

      const res1 = await request(app).post('/api/voices/v_marlow/sample').send(body);

      expect(res1.status).toBe(200);
      expect(res1.body.modelKey).toBe('coqui-xtts-v2');
      expect(res1.body.cached).toBe(false);
      expect(res1.body.url).toMatch(/^\/audio\/voices\/v_marlow-coqui-xtts-v2-[a-z0-9]+\.mp3$/);
      expect(typeof res1.body.durationSec).toBe('number');
      expect(res1.body.durationSec).toBeGreaterThan(0);

      /* File on disk is a real MP3 (not raw PCM with a misleading suffix). */
      const fileName = res1.body.url.split('/').pop() as string;
      const fileBuf = readFileSync(join(audioDir, fileName));
      expect(isMp3Magic(fileBuf)).toBe(true);
      expect(fileBuf.length).toBeGreaterThan(0);
      expect(synthesize).toHaveBeenCalledTimes(1);

      /* Second identical request — disk cache hit, no re-synth. */
      const res2 = await request(app).post('/api/voices/v_marlow/sample').send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.cached).toBe(true);
      expect(res2.body.url).toBe(res1.body.url);
      expect(synthesize).toHaveBeenCalledTimes(1);
    });

    it('different text under the same voice produces a distinct cache entry', async () => {
      const base = {
        modelKey: 'coqui-xtts-v2',
        voice: { id: 'v_oduvan', character: 'Oduvan', attributes: ['Male'] },
      };
      const a = await request(app)
        .post('/api/voices/v_oduvan/sample')
        .send({ ...base, text: 'First line.' });
      const b = await request(app)
        .post('/api/voices/v_oduvan/sample')
        .send({ ...base, text: 'Second different line.' });

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.url).not.toBe(b.body.url);
      expect(a.body.url).toMatch(/\.mp3$/);
      expect(b.body.url).toMatch(/\.mp3$/);
      expect(synthesize).toHaveBeenCalledTimes(2);
    });
  });

  describe('validation', () => {
    it('400 invalid_model when modelKey is unknown', async () => {
      const res = await request(app)
        .post('/api/voices/v_marlow/sample')
        .send({ modelKey: 'nope', text: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_model');
      expect(synthesize).not.toHaveBeenCalled();
    });

    it('400 invalid_model when modelKey is missing', async () => {
      const res = await request(app).post('/api/voices/v_marlow/sample').send({ text: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_model');
      expect(synthesize).not.toHaveBeenCalled();
    });
  });

  describe('error mapping', () => {
    it('maps a sidecar "voice not designed" 409 to a clean 409 voice_not_designed (#1063)', async () => {
      // The sidecar now returns 409 `voice_not_designed` for a missing .pt;
      // sidecar.ts surfaces it as "Local voice engine returned 409: {json}".
      // The route must re-map that to a distinct 4xx + actionable copy, NOT the
      // generic 502 tts_failed.
      synthesize.mockRejectedValueOnce(
        new Error(
          'Local voice engine returned 409: {"detail":"Qwen voice \'qwen-x\' has not been designed yet. Design it first via POST /qwen/design-voice.","code":"voice_not_designed"}',
        ),
      );
      const res = await request(app)
        .post('/api/voices/v_x/sample')
        .send({ modelKey: 'qwen3-tts-0.6b', voice: { id: 'v_x', character: 'X' }, text: 'Hi.' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('voice_not_designed');
      expect(res.body.message).toMatch(/design it first/i);
      // The friendly copy must not echo the raw sidecar JSON / path.
      expect(res.body.message).not.toMatch(/\.pt|POST \/qwen/);
    });

    it('still maps an unrecognised synth failure to 502 tts_failed', async () => {
      synthesize.mockRejectedValueOnce(new Error('some unexpected boom'));
      const res = await request(app)
        .post('/api/voices/v_y/sample')
        .send({ modelKey: 'coqui-xtts-v2', voice: { id: 'v_y', character: 'Y' }, text: 'Hi.' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('tts_failed');
    });
  });

  describe('evidence-driven sample text (no text in body)', () => {
    /* The route's buildSampleText is internal, but we can verify its
       behaviour through synthesize's call arguments — the route hands
       the selected text straight to the provider. */
    it('picks the longest evidence quote when ≥1 quote is long enough', async () => {
      const short = 'Cold supper it is, then.'; // 24 chars
      const medium =
        '“Hard to starboard,” he said, not loudly, because Halloran had never had to be loud to be obeyed.'; // ~95 chars
      const long =
        '“Mr. Vance, you will reef the topsails before the next bell. You will do it without comment, and you will report back to me when it is done — and not, sir, a moment before.”'; // ~180 chars

      const res = await request(app)
        .post('/api/voices/v_halloran/sample')
        .send({
          modelKey: 'coqui-xtts-v2',
          voice: { id: 'v_halloran', character: 'Halloran', attributes: ['Male'] },
          /* Intentionally unsorted to exercise the defensive resort.
             CharacterHint.evidence is string[] on the wire (see
             server/src/tts/voice-mapping.ts), not {quote}[]. */
          characterHint: { evidence: [short, long, medium] },
        });

      expect(res.status).toBe(200);
      expect(synthesize).toHaveBeenCalledTimes(1);
      const args = synthesize.mock.calls[0][0] as { text: string };
      /* The longest quote (with surrounding quote marks stripped) is what
         gets synthesized. We strip the same way buildSampleText does. */
      const expected = long.replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '').trim();
      expect(args.text).toBe(expected);
    });

    it('uses short real quotes verbatim — never pads with "<character> said:" or any other fabrication', async () => {
      const shortReal = '“Cold supper it is, then, and may the wind take the rest.”'; // ~50 chars
      const res = await request(app)
        .post('/api/voices/v_marcus/sample')
        .send({
          modelKey: 'coqui-xtts-v2',
          voice: { id: 'v_marcus', character: 'Marcus', attributes: ['Male'] },
          characterHint: {
            evidence: [shortReal, '“Aye.”'],
          },
        });

      expect(res.status).toBe(200);
      const args = synthesize.mock.calls[0][0] as { text: string };
      /* The longest real quote is returned as-is (smart-quote-stripped),
         no "Marcus said: " prefix, no padding text. The user accepts a
         shorter sample over an invented longer one. */
      const expected = shortReal.replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '').trim();
      expect(args.text).toBe(expected);
      expect(args.text.startsWith('Marcus said:')).toBe(false);
      expect(args.text).not.toContain("I'm Marcus");
    });

    it('uses the longest available evidence even when every quote is well under 80 chars', async () => {
      const res = await request(app)
        .post('/api/voices/v_terse/sample')
        .send({
          modelKey: 'coqui-xtts-v2',
          voice: { id: 'v_terse', character: 'Terse', attributes: ['Male'] },
          /* All quotes short — there's no quote that meets the old
             MIN_CHARS threshold. Used to fall through to the canned
             "Hello. I'm…" script; now must use the longest real one. */
          characterHint: {
            evidence: ['Aye.', 'Yes.', 'No, sir.'],
          },
        });

      expect(res.status).toBe(200);
      const args = synthesize.mock.calls[0][0] as { text: string };
      expect(args.text).toBe('No, sir.');
      expect(args.text).not.toContain("I'm Terse");
    });

    it('falls back to the generic "Hello. I\'m …" script ONLY when the evidence array is genuinely empty', async () => {
      const res = await request(app)
        .post('/api/voices/v_new/sample')
        .send({
          modelKey: 'coqui-xtts-v2',
          voice: { id: 'v_new', character: 'Newcomer', attributes: ['Female', 'Alto'] },
          characterHint: { evidence: [] },
        });

      expect(res.status).toBe(200);
      const args = synthesize.mock.calls[0][0] as { text: string };
      expect(args.text.startsWith("Hello. I'm Newcomer.")).toBe(true);
    });

    it('treats whitespace-only / quote-mark-only evidence entries as empty for fallback purposes', async () => {
      /* The verifier will normally drop these upstream, but defensively
         the route must also collapse them to "no evidence" before the
         canned-script fallback fires (rather than synthesising a
         zero-length string). */
      const res = await request(app)
        .post('/api/voices/v_blank/sample')
        .send({
          modelKey: 'coqui-xtts-v2',
          voice: { id: 'v_blank', character: 'Blank', attributes: ['Male'] },
          characterHint: { evidence: ['  ', '“”', '\n'] },
        });

      expect(res.status).toBe(200);
      const args = synthesize.mock.calls[0][0] as { text: string };
      expect(args.text.startsWith("Hello. I'm Blank.")).toBe(true);
    });
  });

  describe('raw-speaker bypass (Base voices tab)', () => {
    /* When the client sets rawEngine + rawSpeaker, the picker is bypassed
       and the named speaker is synthesised directly. This is what the
       "Base voices" tab and family-header Play buttons rely on so an
       unmodified preview of a specific speaker is reproducible. */

    it('passes rawSpeaker directly to the provider, skipping pickVoiceForEngine', async () => {
      const res = await request(app)
        .post('/api/voices/v_anything/sample')
        .send({
          modelKey: 'coqui-xtts-v2',
          /* Voice profile attributes that would normally land on a male-deep
             pick — we want to confirm the override wins regardless. */
          voice: {
            id: 'v_anything',
            character: 'Brann',
            attributes: ['Male', 'Deep', 'Authoritative'],
          },
          characterHint: { gender: 'male' },
          rawEngine: 'coqui',
          rawSpeaker: 'Asya Anara',
        });

      expect(res.status).toBe(200);
      expect(synthesize).toHaveBeenCalledTimes(1);
      const args = synthesize.mock.calls[0][0] as { voiceName: string; text: string };
      expect(args.voiceName).toBe('Asya Anara');
      /* Default raw sample text — engine-agnostic neutral sentence. */
      expect(args.text).toMatch(/unmodified model voice/i);
    });

    it('caches raw samples by (engine, speaker), independent of the voiceId path', async () => {
      /* Same raw speaker on two different voiceId paths should resolve to
         the same on-disk file so unused base voices don't get re-synthesised
         once per voiceId they happen to ride along. */
      const a = await request(app).post('/api/voices/v_one/sample').send({
        modelKey: 'coqui-xtts-v2',
        rawEngine: 'coqui',
        rawSpeaker: 'Asya Anara',
      });
      const b = await request(app).post('/api/voices/v_two/sample').send({
        modelKey: 'coqui-xtts-v2',
        rawEngine: 'coqui',
        rawSpeaker: 'Asya Anara',
      });

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.url).toBe(b.body.url);
      expect(synthesize).toHaveBeenCalledTimes(1);
      /* Cache scope must NOT include the voiceId path component. */
      expect(a.body.url).not.toContain('v_one');
      expect(a.body.url).not.toContain('v_two');
      expect(a.body.url).toMatch(/raw-coqui-/);
    });

    it('uses a Gemini-compatible modelKey when the project is on Coqui but the raw voice is Gemini', async () => {
      /* A user clicking Play on Gemini · Charon while the project's
         modelKey is coqui-xtts-v2 must still route to a Gemini provider —
         otherwise the synth would send "Charon" to the Coqui sidecar and
         500 mid-synth. */
      const res = await request(app).post('/api/voices/v_x/sample').send({
        modelKey: 'coqui-xtts-v2',
        rawEngine: 'gemini',
        rawSpeaker: 'Charon',
      });
      expect(res.status).toBe(200);
      /* Cache filename should reflect the effective modelKey (gemini-2.5-flash)
         so a later Coqui-routed request for the same character doesn't
         collide with this entry. */
      expect(res.body.url).toMatch(/gemini-2\.5-flash/);
    });
  });

  describe('srv-43 voiceUuid resolution', () => {
    /* A Qwen /sample whose voice carries voiceUuid should resolve the
       storage key as `qwen-<uuid>`, not `qwen-<name>`. The profile drawer
       must include voiceUuid on the voice it POSTs so the player hits the
       cache the design route wrote under that uuid key. */
    it('resolves qwen-<uuid> when voice carries voiceUuid (not qwen-<name>)', async () => {
      const res = await request(app)
        .post('/api/voices/v_wren/sample')
        .send({
          modelKey: 'qwen3-tts-0.6b',
          voice: {
            id: 'v_wren',
            character: 'Wren',
            attributes: [],
            voiceUuid: 'U1',
            overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
          },
          text: 'Hello from Wren.',
        });

      expect(res.status).toBe(200);
      expect(synthesize).toHaveBeenCalledTimes(1);
      const args = synthesize.mock.calls[0][0] as { voiceName: string };
      /* With voiceUuid present the storage key MUST be qwen-U1, not qwen-wren. */
      expect(args.voiceName).toBe('qwen-U1');
    });
  });

  describe('provider errors', () => {
    it('503 sidecar_down when the sidecar is unreachable', async () => {
      synthesize.mockRejectedValueOnce(new Error('sidecar not reachable at http://localhost:9000'));
      const res = await request(app)
        .post('/api/voices/v_marlow/sample')
        .send({ modelKey: 'coqui-xtts-v2', text: 'x' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('sidecar_down');
    });

    it('429 rate_limited when the upstream rate-limits', async () => {
      synthesize.mockRejectedValueOnce(new Error('Gemini returned 429: rate limit exceeded'));
      const res = await request(app)
        .post('/api/voices/v_marlow/sample')
        .send({ modelKey: 'coqui-xtts-v2', text: 'x' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    });

    it('502 tts_failed on a generic synthesis failure', async () => {
      synthesize.mockRejectedValueOnce(new Error('Something else went wrong.'));
      const res = await request(app)
        .post('/api/voices/v_marlow/sample')
        .send({ modelKey: 'coqui-xtts-v2', text: 'x' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('tts_failed');
    });
  });
});
