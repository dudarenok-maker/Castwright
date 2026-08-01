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
import { withCastLock } from '../workspace/cast-lock.js';
import { generateVoiceStylePersona } from '../analyzer/voice-style.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { preparePersonaBatch } from '../tts/persona-gpu-plan.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { writeVoiceStylePersona } from './cast-design.js';

export const voiceStyleRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

/* Narrator detection mirrors routes/voices.ts:isNarratorId — by id (the
   shared NARRATOR_CHARACTER_IDS pair, #1895) or by name. The narrator stays
   on a Kokoro preset (plan 108), so it has no bespoke persona by default. */
function isNarrator(c: CastCharacter): boolean {
  const lid = (c.id ?? '').toLowerCase();
  if (NARRATOR_CHARACTER_IDS.includes(lid)) return true;
  return (c.name ?? '').toLowerCase() === 'narrator';
}

voiceStyleRouter.post(
  '/:bookId/cast/:characterId/voice-style/generate',
  async (req: Request, res: Response<{ voiceStyle: string } | { error: string }>) => {
    const { bookId, characterId } = req.params;

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    /* #1981 — the read is inside the lock, and so is the whole
       generate-then-write span: the character index used for the write is
       derived from this read. */
    return withCastLock(bookDir, async () => {
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
        const prep = await preparePersonaBatch(bookDir);
        const voiceStyle = await generateVoiceStylePersona(cast.characters[idx], prep);
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
    });
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

    /* #1981 review fix round — this NO LONGER holds the book's cast lock
       across the batch. The original mechanical conversion wrapped
       `preparePersonaBatch` + every `generateVoiceStylePersona` LLM call +
       the final write in one `withCastLock`, which on a 30-character cast
       holds the book's hottest lock for MINUTES — every other writer on
       this book (`/assign`, `add-alias`, the cast slice of `PUT
       /:bookId/state`) would block for the whole batch. That's the exact
       shape `cast-design.ts`'s bulk design job was deliberately carved OUT
       of locking this broadly, for this exact reason — this route just
       hadn't caught up.

       This initial read is OUTSIDE any lock and is NOT the source of truth
       for what gets written — it only decides which characters to ATTEMPT
       a persona for. Each attempt persists through `writeVoiceStylePersona`
       (cast-design.ts), which re-reads the cast FRESH inside its OWN
       per-character lock immediately before writing — so a concurrent edit
       elsewhere in the batch's runtime is never clobbered, and neither is a
       concurrent edit from a completely different route. */
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before generating voice styles.',
      });
    }

    const voiceStyles: Record<string, string> = {};
    const failures: Record<string, string> = {};

    /* Resolve the GPU plan once for the whole batch — one evict / one decision,
       not per-character — then thread prep into every generateVoiceStylePersona
       call. ONE Gemini/Ollama call per character; the shared rate limiter gates
       cadence. A per-character throw is caught and recorded so one bad character
       can't abort the batch. Neither this nor the LLM call below ever runs
       inside a cast lock. */
    const prep = await preparePersonaBatch(bookDir);
    for (const c of cast.characters) {
      if (!includeNarrator && isNarrator(c)) continue;
      try {
        const voiceStyle = await generateVoiceStylePersona(c, prep);
        /* Semantic change from the pre-fix-round behaviour: each character's
           persona now lands via its OWN locked read-modify-write the moment
           it's generated, against whatever the cast looks like AT THAT
           MOMENT — not the single stale snapshot read at the top of this
           handler. That's what lets a concurrent edit elsewhere survive a
           long-running batch instead of being blocked for its duration or
           silently overwritten at the end.

           It also means a character deleted mid-batch (by a concurrent
           merge/unlink/etc.) is explicitly handled, not accidentally
           resurrected: `writeVoiceStylePersona` returns `false` when its own
           fresh read no longer finds the character, and that write is a
           genuine no-op. Such a character is deliberately left out of BOTH
           `voiceStyles` and `failures` below — the LLM call still "succeeded"
           in isolation, but reporting it as a persisted win would be
           misleading, and it isn't a failure either. */
        const written = await writeVoiceStylePersona(bookDir, c.id, voiceStyle);
        if (written) voiceStyles[c.id] = voiceStyle;
      } catch (e) {
        failures[c.id] = (e as Error).message || 'Voice-style generation failed.';
        console.error('[voice-style] book=%s character=%s failed', bookId, c.id, e);
      }
    }

    console.log(
      `[voice-style] book=${bookId} generate-all → ${Object.keys(voiceStyles).length} ok, ` +
        `${Object.keys(failures).length} failed`,
    );
    return res.json({ voiceStyles, failures });
  },
);
