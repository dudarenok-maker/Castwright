/* POST /api/books/:bookId/cast/:characterId/design-voice

   Plan 108, Wave 4 — proxies the TTS sidecar's bespoke Qwen voice-DESIGN
   flow for one cast member. Designing a voice caches a reusable speaker
   embedding under a stable voiceId and returns an AUDITION preview; it
   does NOT persist the per-character override (the Profile Drawer's Save
   commits that via PUT /api/voices/:voiceId/override with scope:'series').

   Body: `{ persona?: string }` — defaults to the character's persisted
   `voiceStyle`. 400 when neither is present (the drawer always sends the
   edited textarea value, so this is the empty-persona guard).

   The derived cache voiceId is `qwen-${character.voiceId ?? characterId}`,
   stable across designs so re-designing overwrites the same embedding.
   It's echoed back in the `X-Qwen-Voice-Id` response header so the client
   can store it in `overrideTtsVoices.qwen.name` on Save.

   The preview PCM is streamed back verbatim (`audio/L16` + `X-Sample-Rate`)
   so the drawer can play it without a round-trip through the cache. A
   sidecar that's down → 502 with a clear message; the GPU semaphore is
   the sidecar's concern (we only proxy). */

import { Router, type Request, type Response } from 'express';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

export const qwenVoiceRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

/* Cold voice-design (load VoiceDesign model transiently + generate a
   reference clip + distil the clone prompt) can take noticeably longer
   than a warm synth on first call, so budget generously like the load
   proxy rather than the 2s health probe. */
const DESIGN_TIMEOUT_MS = 120_000;

/* Stable cache key for the designed voice — keyed on the character's
   voiceId when present (so a series-shared identity reuses one embedding)
   else the local character id. */
export function deriveQwenVoiceId(character: CastCharacter, characterId: string): string {
  return `qwen-${character.voiceId ?? characterId}`;
}

qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/design-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as { persona?: unknown };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before designing voices.',
      });
    }
    const character = cast.characters.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* Persona precedence: explicit body wins, else the persisted
       voiceStyle. Neither present → 400 (the user must generate or type
       a persona first). */
    const personaFromBody = typeof body.persona === 'string' ? body.persona.trim() : '';
    const persona = personaFromBody || (character.voiceStyle ?? '').trim();
    if (!persona) {
      return res.status(400).json({
        error:
          'No persona to design from — generate a voice style first or pass `persona` in the body.',
      });
    }

    const voiceId = deriveQwenVoiceId(character, characterId);
    const sidecarUrl = getResolvedSidecarUrl();
    const target = `${sidecarUrl}/qwen/design-voice`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESIGN_TIMEOUT_MS);
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, instruct: persona, language: 'English' }),
      });
      clearTimeout(timer);
      if (!upstream.ok) {
        let detail = '';
        try {
          detail = ((await upstream.json()) as { error?: string }).error ?? '';
        } catch {
          /* not json */
        }
        return res.status(502).json({
          error:
            detail ||
            `Sidecar /qwen/design-voice returned ${upstream.status} ${upstream.statusText}.`,
        });
      }
      const sampleRate = upstream.headers.get('X-Sample-Rate') ?? '24000';
      const pcm = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'audio/L16');
      res.setHeader('X-Sample-Rate', sampleRate);
      res.setHeader('X-Qwen-Voice-Id', voiceId);
      console.log(
        `[qwen-voice] book=${bookId} character=${characterId} voiceId=${voiceId} ` +
          `→ ${pcm.length} bytes @ ${sampleRate}Hz`,
      );
      return res.status(200).send(pcm);
    } catch (e) {
      clearTimeout(timer);
      const err = e as { name?: string; message?: string };
      const isTimeout = err.name === 'AbortError';
      return res.status(502).json({
        error: isTimeout
          ? `Sidecar /qwen/design-voice did not complete within ${DESIGN_TIMEOUT_MS}ms — voice design is unusually slow or the process is stuck.`
          : `TTS sidecar (${sidecarUrl}) is unreachable — ${err.message || 'request failed'}.`,
      });
    }
  },
);
