/* POST /api/books/:bookId/cast/:characterId/voice-style/generate
   POST /api/books/:bookId/cast/voice-style/generate-all

   Generate (and persist) Gemini voice-design personas for cast members
   (plan 108, Wave 4 dependency). A persona is a short natural-language
   instruct — "a warm, gravelly older man, slow and deliberate, weary but
   kind" — that seeds the Qwen sidecar's bespoke voice-design flow.

   ONE Gemini call PER CHARACTER (never batched) so a persona can't be
   contaminated by a neighbouring character's traits; the batch route loops
   sequentially and is robust to per-character failures (collect + report,
   don't abort). The narrator is skipped by default — there's no character
   to design a voice for — but an explicit `includeNarrator: true` overrides
   that for the rare case the user wants a designed narrator voice.

   Persisted on the character in cast.json as `voiceStyle`, alongside
   `voiceId` / `gender` / the override map — it's part of the character's
   voice identity and round-trips through analysis reparses + reloads. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { generateVoiceStylePersona } from '../analyzer/voice-style.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

export const voiceStyleRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

/* Narrator detection mirrors routes/voices.ts:isNarratorId — by id
   ('narrator' / 'char-narrator') or by name. The narrator stays on a
   Kokoro preset (plan 108), so it has no bespoke persona by default. */
function isNarrator(c: CastCharacter): boolean {
  const lid = (c.id ?? '').toLowerCase();
  if (lid === 'narrator' || lid === 'char-narrator') return true;
  return (c.name ?? '').toLowerCase() === 'narrator';
}

voiceStyleRouter.post(
  '/:bookId/cast/:characterId/voice-style/generate',
  async (req: Request, res: Response<{ voiceStyle: string } | { error: string }>) => {
    const { bookId, characterId } = req.params;

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before generating voice styles.',
      });
    }

    const idx = cast.characters.findIndex((c) => c.id === characterId);
    if (idx === -1) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    try {
      const voiceStyle = await generateVoiceStylePersona(cast.characters[idx]);
      cast.characters[idx] = { ...cast.characters[idx], voiceStyle };
      await writeJsonAtomic(castJsonPath(bookDir), cast);
      console.log(
        `[voice-style] book=${bookId} character=${characterId} → "${voiceStyle.slice(0, 60)}"`,
      );
      return res.json({ voiceStyle });
    } catch (e) {
      console.error('[voice-style] generate failed', e);
      return res
        .status(500)
        .json({ error: (e as Error).message || 'Voice-style generation failed.' });
    }
  },
);

voiceStyleRouter.post(
  '/:bookId/cast/voice-style/generate-all',
  async (
    req: Request,
    res: Response<
      { voiceStyles: Record<string, string>; failures: Record<string, string> } | { error: string }
    >,
  ) => {
    const { bookId } = req.params;
    const includeNarrator = (req.body ?? {})?.includeNarrator === true;

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before generating voice styles.',
      });
    }

    const voiceStyles: Record<string, string> = {};
    const failures: Record<string, string> = {};

    /* ONE Gemini call per character, sequentially. The shared rate limiter
       already gates the call cadence, so a sequential loop keeps the code
       simple while staying inside the per-model RPM. A per-character throw
       is caught and recorded so one bad character can't abort the batch. */
    for (let i = 0; i < cast.characters.length; i++) {
      const c = cast.characters[i];
      if (!includeNarrator && isNarrator(c)) continue;
      try {
        const voiceStyle = await generateVoiceStylePersona(c);
        cast.characters[i] = { ...c, voiceStyle };
        voiceStyles[c.id] = voiceStyle;
      } catch (e) {
        failures[c.id] = (e as Error).message || 'Voice-style generation failed.';
        console.error('[voice-style] book=%s character=%s failed', bookId, c.id, e);
      }
    }

    /* Persist whatever succeeded — a partial batch still saves its wins. */
    if (Object.keys(voiceStyles).length > 0) {
      await writeJsonAtomic(castJsonPath(bookDir), cast);
    }
    console.log(
      `[voice-style] book=${bookId} generate-all → ${Object.keys(voiceStyles).length} ok, ` +
        `${Object.keys(failures).length} failed`,
    );
    return res.json({ voiceStyles, failures });
  },
);
