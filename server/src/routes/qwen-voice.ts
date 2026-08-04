/* POST /api/books/:bookId/cast/:characterId/design-voice

   Plan 108, Wave 4 — proxies the TTS sidecar's bespoke Qwen voice-DESIGN
   flow for one cast member. Designing a voice caches a reusable speaker
   embedding under a stable voiceId and returns an AUDITION preview; it
   does NOT persist the per-character override (the Profile Drawer's Save
   commits that via PUT /api/voices/:voiceId/override with scope:'series').

   Body: `{ persona?, sampleVoiceId, modelKey }`.
   - `persona` defaults to the character's persisted `voiceStyle`. 400 when
     neither is present (the drawer always sends the edited textarea value,
     so this is the empty-persona guard).
   - `sampleVoiceId` + `modelKey` are the cache identity the "Play 12s"
     player (voice-sample.ts) will later compute. The drawer passes the same
     values it would send to /sample.

   The derived sidecar voiceId is `qwen-${character.voiceId ?? characterId}`,
   stable across designs so re-designing overwrites the same embedding.

   One-pass reuse: the audition is synthesised from the character's OWN line
   (the longest evidence quote — exactly what voice-sample.ts picks) and the
   resulting MP3 is written into the SAME on-disk sample cache, under the
   filename the player computes for (sampleVoiceId, modelKey, line, voiceId).
   So designing a voice and then clicking "Play 12s" is a cache hit — one
   synthesis, not two. The response is JSON `{ voiceId, url }` pointing at
   that cached file. A sidecar that's down → 502 with a clear message. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { rename, rm, copyFile, stat } from 'node:fs/promises';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { sidecarLanguageName } from '../tts/language.js';
import {
  castJsonPath,
  qwenVoiceSidecarPath,
  qwenVoicePtPath,
  qwenVoiceWavPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { EMOTIONS, type Emotion } from '../handoff/schemas.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import { withDesignLock, isDesignBusy } from '../tts/design-lock.js';
import { buildHintFromCast, toVoiceLike, type CastCharacter } from '../tts/synthesise-chapter.js';
import { forEachMatchingCastCharacter } from './voices.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import {
  buildSampleText,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import { characterHasClonedSlot } from '../tts/clone-engines.js';
import { nanoid } from 'nanoid';

/* fs-38 Wave 1, Task 9 — the sidecar-POST + audition-cache mechanics, the
   SidecarDesignError shape, and the liveness watchdog now live in the
   scope-agnostic `tts/design-voice-core.ts` so the voice-library routes share
   the exact same path. Re-exported here so this module's existing importers
   (and its whole test file, which imports SidecarDesignError /
   evaluateDesignLiveness from './qwen-voice.js') are unaffected. */
import {
  postDesignAndCacheAudition,
  SidecarDesignError,
  evaluateDesignLiveness,
} from '../tts/design-voice-core.js';
import type { DesignLivenessResult } from '../tts/design-voice-core.js';
import { httpStatusForSidecarError } from './sidecar-error-status.js';
export { SidecarDesignError, evaluateDesignLiveness };
export type { DesignLivenessResult };

export const qwenVoiceRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

/* Stable cache key for the designed voice — keyed on the character's
   voiceId when present (so a series-shared identity reuses one embedding)
   else the local character id. */
export function deriveQwenVoiceId(character: CastCharacter, characterId: string): string {
  return `qwen-${character.voiceId ?? characterId}`;
}

/* fs-25 — the expressive emotions a variant can be designed for (the enum minus
   `neutral`, which IS the base voice, not a variant). */
export const VARIANT_EMOTIONS = EMOTIONS.filter((e) => e !== 'neutral') as Exclude<
  Emotion,
  'neutral'
>[];

/* #1954 — the single refusal message for "you cannot mint an emotion variant
   of a cloned voice", shared by the route's 409 and the design core's throw so
   the two can never drift. Names the character and says what to do instead —
   a bare "not supported" leaves the user with no next step. */
export function clonedVariantRefusal(name: string): string {
  return (
    `"${name}" uses a cloned voice, so emotion variants are unavailable — ` +
    `they are only offered for a designed voice. Minting one would re-derive a ` +
    `new performance of a real person's voice under a key their consent record ` +
    `does not cover and revoking consent does not erase. Assign a designed ` +
    `voice to this character to use emotion variants.`
  );
}

/* Emotion delivery clause sent to /qwen/mint-variant as `emotionInstruct`.
   The base persona is already baked into the base voice identity; this clause
   adds only the delivery modifier on top. Phrasings calibrated for the
   anchored-mint approach (Task 6): stronger contrast vs. base voice.

   fs-59 CJK (Task 4a.2): deliberately NOT localized per book language. This
   is a `Record<Exclude<Emotion,'neutral'>, string>` keyed purely by emotion —
   `p.language` (zh/ja included) never participates in the lookup, so it's
   safe by construction: no undefined, no crash, for any book language.
   Adding zh/ja-native phrasing is out of scope — Qwen VoiceDesign persona
   stays English regardless of book language (a documented won't-fix, see
   reference_qwen_voicedesign_persona_english), so an English delivery clause
   is the correct/consistent behaviour here too, not a gap. */
const EMOTION_INSTRUCT: Record<Exclude<Emotion, 'neutral'>, string> = {
  whisper:
    'Delivered as a barely-there whisper, almost silent, pure soft breath with no vocal tone at all, hushed and intimate, faint enough that you strain to hear it.',
  angry:
    'Delivered with explosive, furious rage, shouting at the top of the voice, harsh and seething, sharp and aggressive, utterly enraged.',
  excited:
    'Delivered with bright, happy, upbeat excitement, cheerful and thrilled, full of joyful, positive energy.',
  sad: 'Delivered with quiet, downcast sadness, slow and subdued, low and weary, heavy and dejected.',
};

/* fs-25 / fe-32 / srv-37 — record a designed emotion variant onto a
   character's qwen slot. A variant voiceId is derived from the series-unified
   base voiceId (`qwen-<voiceId>__<emotion>`), so — exactly like the base voice
   carried by `applyOverrideToCastFiles` — it must TRAVEL to every linked
   character (same `voiceId`) across the books in the series; a per-book variant
   slot would break the linked-cast premise (the same character would render the
   emotion in one book and fall back to base in another). When `seriesFilter` is
   given the slot propagates series-wide (standalones excluded); without it the
   write stays book-scoped (a standalone, or a caller with no series context).
   Preserves the base `name` (defaulting it to the derived base id when the slot
   is fresh) and any sibling variants. No-op for an unknown character. Shared by
   the single design-voice route and the bulk "Design full cast" job. */
export async function persistEmotionVariant(
  bookDir: string,
  characterId: string,
  emotion: Exclude<Emotion, 'neutral'>,
  variantVoiceId: string,
  seriesFilter?: { author: string; series: string },
): Promise<void> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!cast || !character) return;

  /* Add/overwrite the emotion slot on a character's qwen override, defaulting
     the base name when the slot is fresh and preserving sibling variants. */
  const addVariant = (c: CastCharacter, baseVoiceId: string): CastCharacter => {
    const map = { ...(c.overrideTtsVoices ?? {}) };
    const qwen = map.qwen ?? { name: baseVoiceId };
    map.qwen = {
      ...qwen,
      name: qwen.name ?? baseVoiceId,
      variants: { ...(qwen.variants ?? {}), [emotion]: { name: variantVoiceId } },
    };
    return { ...c, overrideTtsVoices: map };
  };

  if (seriesFilter) {
    /* Linked-cast propagation across the series (matches on the linked
       identity `voiceId ?? id`, the same key applyOverrideToCastFiles uses).
       forEachMatchingCastCharacter takes its own per-book cast lock as it
       walks — a locked leaf (cast-lock.ts rule 1) — so this branch stays
       unlocked and delegating; it must not gain a lock of its own. */
    const baseVoiceId = qwenStorageKey(character, characterId);
    await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) =>
      addVariant(c, baseVoiceId),
    );
    return;
  }

  /* Book-scoped write — this function carries no other lock, so the read
     above is an early-out optimisation only: a concurrent book-scoped writer
     can land between it and the write below. Re-read and re-decide inside
     the cast lock, including `baseVoiceId` (the default slot name), which
     must come from the FRESH character, not the one captured above. */
  await withCastLock(bookDir, async () => {
    const fresh = await readJson<CastFile>(castJsonPath(bookDir));
    const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
    if (!fresh || idx === -1) return;
    const freshCharacter = fresh.characters[idx];
    const baseVoiceId = qwenStorageKey(freshCharacter, characterId);
    fresh.characters[idx] = addVariant(freshCharacter, baseVoiceId);
    await writeJsonAtomic(castJsonPath(bookDir), fresh);
  });
}

/* srv-43 — ensure a character has an immutable voiceUuid BEFORE its bespoke
   voice is designed (the .pt is named from qwenStorageKey, which reads the
   uuid). Idempotent: returns the existing uuid untouched. Mints under the
   per-book design lock so two concurrent designs of one character can't mint
   two uuids. Stamps the SAME uuid onto every linked-cast sibling (matching
   voiceId ?? id) so a series-shared voice keeps one identity — series-scoped
   when seriesFilter is given (mirrors persistEmotionVariant), else book-scoped.
   Returns undefined for an unknown character. */
export async function ensureCharacterVoiceUuid(
  bookDir: string,
  characterId: string,
  seriesFilter?: { author: string; series: string },
): Promise<string | undefined> {
  return withDesignLock(bookDir, async () => {
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!cast || !character) return undefined;
    if (character.voiceUuid) return character.voiceUuid;

    if (seriesFilter) {
      /* forEachMatchingCastCharacter takes its own per-book cast lock as it
         walks — a locked leaf (cast-lock.ts rule 1) — so this branch stays
         unlocked and delegating; it must not gain a lock of its own. */
      const uuid = nanoid();
      const stamp = (c: CastCharacter): CastCharacter => ({ ...c, voiceUuid: uuid });
      await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, stamp);
      return uuid;
    }

    /* Book-scoped — the design lock above serialises only against OTHER
       design-lock holders (e.g. another design on this book), not against a
       non-design cast.json writer (e.g. cast-aliases), so the read above is
       an early-out optimisation only. Re-read and re-decide inside the cast
       lock: re-check `voiceUuid` (another concurrent mint may have landed)
       and re-derive the linked-sibling set from a FRESH cast, not the one
       captured above. */
    return withCastLock(bookDir, async () => {
      const freshCast = await readJson<CastFile>(castJsonPath(bookDir));
      const freshChar = freshCast?.characters?.find((c) => c.id === characterId);
      if (!freshCast || !freshChar) return undefined;
      if (freshChar.voiceUuid) return freshChar.voiceUuid;

      const uuid = nanoid();
      const linkId = freshChar.voiceId ?? freshChar.id;
      let dirty = false;
      for (let i = 0; i < freshCast.characters.length; i++) {
        if ((freshCast.characters[i].voiceId ?? freshCast.characters[i].id) === linkId) {
          freshCast.characters[i] = { ...freshCast.characters[i], voiceUuid: uuid };
          dirty = true;
        }
      }
      if (dirty) await writeJsonAtomic(castJsonPath(bookDir), freshCast);
      return uuid;
    });
  });
}

/* Preview/promote (plan 161). The A/B "current vs proposed" audition must NOT
   overwrite a character's live bespoke voice while the user is still deciding —
   but `deriveQwenVoiceId` is stable per character and the design route always
   (over)writes that embedding. So a comparison design stages under a sibling
   `-preview` id (a separate `.pt`/`.json` + a distinct audition cache file,
   since the cache key folds in the voiceId); the real voice is untouched until
   the user approves. `promote-voice` then moves the preview onto the real id
   (and evicts the sidecar's in-memory cache so the swap is seen); Cancel hits
   `discard-voice` to drop the preview. Keeping the COMMITTED id stable
   (`qwen-<id>`) avoids rippling the reuse/series/duplicate-detection logic that
   keys on it. */
const PREVIEW_SUFFIX = '-preview';
function previewVoiceIdFor(realVoiceId: string): string {
  return `${realVoiceId}${PREVIEW_SUFFIX}`;
}
/* fs-38 Wave 3b2 MINOR-1 — moved to workspace/paths.ts (cycle-free; this
   module imports from tts/synthesise-chapter.ts, which needs this helper
   too). Imported above (with the rest of this module's `paths.js` imports)
   and re-exported here — a bare `export { x } from 'mod'` does NOT bind `x`
   as a local name, and this module's own route handlers call
   `qwenVoicePtPath(...)` directly, so it needs both the import AND the
   re-export. Re-exported so this module's existing importers
   (voice-library.ts, workspace/purge-clone-artifacts.ts, qwen-voice.test.ts)
   are unaffected. */
export { qwenVoicePtPath };

/* GET /api/books/:bookId/cast/:characterId/designed-persona

   Plan 149 — surfaces the persona text (`instruct`) of a character's already
   DESIGNED Qwen voice, read from the voice sidecar JSON. The persona is
   persisted on the sidecar at design time but historically was NOT mirrored
   onto `character.voiceStyle` (and reuse copies only the override, never the
   persona) — so the Profile Drawer's "Voice persona" textarea reads blank for
   reused/origin characters whose voice is otherwise correctly designed. The
   drawer calls this lazily (only when `voiceStyle` is empty) to seed the
   textarea, so the persona shows and a re-design isn't blocked by the empty-
   persona 400 guard above.

   Returns 200 `{ instruct }` — an empty string when the sidecar/key is absent
   (a benign "no persona on disk", same as today's blank). 404 only for an
   unknown book/character. */
qwenVoiceRouter.get(
  '/:bookId/cast/:characterId/designed-persona',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* Same storage-key resolution as design-voice: an explicit per-character
       qwen override name (the storage key) wins, else the derived
       `qwenStorageKey` (so a REUSED character with an empty own override still
       resolves to its series-shared sidecar `.json`). */
    const voiceName =
      character.overrideTtsVoices?.qwen?.name ?? qwenStorageKey(character, characterId);
    const sidecar = await readJson<{ instruct?: string }>(qwenVoiceSidecarPath(voiceName)).catch(
      () => null,
    );
    const instruct = typeof sidecar?.instruct === 'string' ? sidecar.instruct : '';
    return res.status(200).json({ instruct });
  },
);

/* Shared design core — the sidecar `/qwen/design-voice` call + audition-cache
   write, extracted so BOTH the single-design route below and the bulk
   "Design full cast" job (server/src/routes/cast-design.ts) run the exact same
   path in-process (no HTTP-to-self). Serialized per book (`withDesignLock`) so
   two designs for one book can't corrupt the shared `.pt`/audition-cache. (VRAM
   arbitration against a concurrent generation/analysis is no longer a Node-side
   gate — the retired weighted `gpuSemaphore` is replaced by the sidecar's own
   capacity admission when SEG_CAPACITY_ADMISSION is on; wrapping design_voice in
   that admission is a flag-on-readiness follow-up, see plan 264.) Throws on sidecar/encode failure
   with a user-facing message; the caller maps it (502 for the route, a
   per-character failure for the bulk job). Does NOT persist the per-character
   override or the emotion variant — that stays with the callers. */
export interface DesignQwenVoiceParams {
  bookDir: string;
  character: CastCharacter;
  characterId: string;
  /** Resolved, non-empty persona (the caller applies its own precedence). */
  persona: string;
  sampleVoiceId: string;
  modelKey: TtsModelKey;
  /** Sidecar language name (e.g. 'english') — baked into the cached voice. */
  language: string;
  /** When set, designs an emotion VARIANT under `<baseVoiceId>__<emotion>`. */
  emotion?: Exclude<Emotion, 'neutral'>;
  /** Stage under a `-preview` sibling id (A/B compare) instead of in place. */
  preview?: boolean;
  /** External cancel — aborts the in-flight sidecar call (e.g. the bulk job's
      controller on a Cancel) in addition to the internal timeout. */
  signal?: AbortSignal;
  /** When present, forwarded to the sidecar so it can POST phase progress back
      to this server (AR2 design-progress feature). */
  progressToken?: string;
  progressUrl?: string;
}

export async function designQwenVoiceForCharacter(
  p: DesignQwenVoiceParams,
): Promise<{ voiceId: string; url: string; fellBackToDesignVoice?: boolean; fallbackReason?: 'not-installed' | 'corrupt' }> {
  /* #1954 — a VARIANT of a cloned voice is refused, not anchored. The guard
     sits here, at the choke point where the anchor is computed, because that
     is what made the defect reachable: `qwenStorageKey` below derives a
     DESIGNED-voice key (`qwen-<voiceUuid|voiceId>`), while a cloned voice's
     artifact lives at `qwen-<libraryUuid>` — a key `qwenStorageKey` cannot
     produce. So the mint anchored to a different voice's `.pt` (or to
     nothing), and wrote the variant under a key the render path never looks
     up (`pickVoiceForEngine` resolves a cloned qwen slot to
     `qwen-<libraryUuid>`, so `pickEmotionVariantVoice` asks for
     `qwen-<libraryUuid>__<emotion>`). Same `qwenStorageKey`-vs-`libraryUuid`
     confusion documented at tts/verify-designed-voice-language.ts:45-47.

     WHY REFUSE rather than fix the anchor (the issue left the choice open):
     `mint_variant` (tts-sidecar/main.py) would in fact accept a cloned `.pt`
     — a clone prompt and a designed prompt are the same `create_voice_clone_
     prompt` object — so anchoring is technically possible. It is nonetheless
     the wrong answer here, for three reasons that all point the same way:

       1. A minted variant is not the person's voice; it is the 1.7B model's
          re-performance of them, decoded and re-distilled through an
          emotion instruct ("explosive, furious rage"). Whether a consented
          clone may be re-performed that way is a product/consent decision
          — the consent record (personName/relationship/permittedUse) has no
          dimension for it — not something a bug fix should settle silently.
       2. The variant would be UNERASABLE by consent revocation.
          `purgeCloneArtifacts` (workspace/purge-clone-artifacts.ts) matches
          on `name === key || name.startsWith(key + '.')`; the boundary is a
          literal `.`, so `qwen-<uuid>__angry.pt` matches neither. Revoke
          would report clean erasure while a derived artifact of a real
          person survived on disk — the exact class of hole that module was
          written to close.
       3. `mint_variant` never writes `"clone": true` into the variant
          manifest, so the variant would also lose its clone provenance at
          the sidecar level. Fixing that reaches into main.py, and covering
          (2) reaches into the consent-erasure module — i.e. correct
          anchoring is a feature with its own blast radius, and features go
          through design, not through this fix.

     Whole-character `characterHasClonedSlot` (the fail-safe, provenance-only
     predicate), matching the base branch at cast-design.ts and the identical
     guard in single-design.ts — deliberately NOT the uuid-validating
     resolution predicates, so a malformed cloned slot still refuses. A
     coqui-cloned character loses nothing: `pickEmotionVariantVoice` is a
     strict no-op for every engine except qwen, so a qwen variant would never
     have been read for it anyway.

     Unreachable from the two callers today (the route below answers 409 first
     and the bulk job skips first) — deliberately. This is the invariant; those
     are the two places that report it nicely. */
  if (p.emotion && characterHasClonedSlot(p.character)) {
    throw new Error(clonedVariantRefusal(p.character.name ?? p.characterId));
  }
  const baseVoiceId = qwenStorageKey(p.character, p.characterId);
  const designedId = p.emotion ? `${baseVoiceId}__${p.emotion}` : baseVoiceId;
  const voiceId = p.preview ? previewVoiceIdFor(designedId) : designedId;
  const calibrationText = buildSampleText(toVoiceLike(p.character), buildHintFromCast(p.character));

  return withDesignLock(p.bookDir, async () => {
    const { withGpuLoad } = await import('../gpu/gpu-load.js');
    const { engineDeviceIsGpu } = await import('../gpu/engine-device.js');
    /* withGpuLoad's eviction-guard hint. Sidecar op — VRAM arbitration now
       lives in the sidecar's capacity admission (behind SEG_CAPACITY_ADMISSION),
       not a Node-side GPU token here; flag off, this runs in the normal
       sequential workflow (design happens in cast-review, poolWidth=1 renders
       serialize), matching the whole feature's flag-off model. */
    const onGpu = engineDeviceIsGpu('qwen');
    return withGpuLoad(async () => {
      const sidecarUrl = getResolvedSidecarUrl();

      /* Task 9 — the sidecar-POST + audition-cache mechanics now live in the
         scope-agnostic core; this thin wrapper just binds the character-coupled
         captures (sample scope, model key, cancel signal, log context). */
      const postDesignAndCache = (
        target: string,
        fetchBody: string,
        outVoiceId: string,
      ): Promise<{ voiceId: string; url: string }> =>
        postDesignAndCacheAudition({
          target,
          fetchBody,
          outVoiceId,
          cacheScope: p.sampleVoiceId,
          modelKey: p.modelKey,
          calibrationText,
          sidecarUrl,
          signal: p.signal,
          logContext: `book=${p.bookDir} character=${p.characterId}`,
        });

      /* AR2 design-progress: forward the token so the sidecar can POST phase
         progress back to this server. Spread into every body (base, mint,
         fallback) so progress works on all paths. */
      const progressFields =
        p.progressToken && p.progressUrl
          ? { progressToken: p.progressToken, progressUrl: p.progressUrl }
          : {};
      if (!p.emotion) {
        return await postDesignAndCache(`${sidecarUrl}/qwen/design-voice`, JSON.stringify({
          voiceId, voiceUuid: p.character.voiceUuid ?? null, instruct: p.persona, language: p.language, calibrationText,
          ...progressFields,
        }), voiceId);
      }

      // Variant: try the anchored mint, fall back on a deterministic 1.7B-Base failure.
      const mintBody = JSON.stringify({
        baseVoiceId, variantVoiceId: voiceId, emotionInstruct: EMOTION_INSTRUCT[p.emotion],
        voiceUuid: p.character.voiceUuid ?? null, language: p.language, calibrationText,
        ...progressFields,
      });
      try {
        return await postDesignAndCache(`${sidecarUrl}/qwen/mint-variant`, mintBody, voiceId);
      } catch (e) {
        const err = e as SidecarDesignError;
        const isFallback = err?.name === 'SidecarDesignError' && err.status === 503 && err.code === 'base17-unavailable'
          && (err.reason === 'not-installed' || err.reason === 'corrupt');
        if (!isFallback) throw e;  // OOM/500, cancel, unreachable, 409 → propagate

        // Resolve a persona: p.persona → base voice's sidecar .json instruct → decline.
        let persona = (p.persona ?? '').trim();
        if (!persona) {
          const baseVoiceName = p.character.overrideTtsVoices?.qwen?.name ?? qwenStorageKey(p.character, p.characterId);
          const sidecarJson = await readJson<{ instruct?: string }>(qwenVoiceSidecarPath(baseVoiceName)).catch(() => null);
          persona = (typeof sidecarJson?.instruct === 'string' ? sidecarJson.instruct : '').trim();
        }
        if (!persona) {
          throw new Error('1.7B-Base unavailable and no persona on disk to fall back with — design the base voice\'s persona first.');
        }

        const reason = err.reason as 'not-installed' | 'corrupt';
        console.warn(
          `[qwen-voice] 1.7B-Base unavailable (reason=${reason}) — minted ${p.emotion} variant for ${p.characterId} via design-voice fallback (lower fidelity).`,
        );
        const fallbackBody = JSON.stringify({
          voiceId, voiceUuid: p.character.voiceUuid ?? null,
          instruct: `${persona} ${EMOTION_INSTRUCT[p.emotion]}`,
          language: p.language, calibrationText,
          mintMethod: 'design-voice-fallback',
          fallbackFor: { baseVoiceId, emotion: p.emotion },
          ...progressFields,
        });
        const out = await postDesignAndCache(`${sidecarUrl}/qwen/design-voice`, fallbackBody, voiceId);
        return { ...out, fellBackToDesignVoice: true, fallbackReason: reason };
      }
    }, onGpu);
  });
}

qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/design-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      persona?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
      preview?: unknown;
      emotion?: unknown;
      progressToken?: unknown;
      progressUrl?: unknown;
    };

    /* fs-25 — optional emotion variant. When present it must be one of the
       expressive emotions (`neutral` is the base voice, not a variant). The
       variant is designed under `<baseVoiceId>__<emotion>`, its instruct gains
       the delivery clause, and the cast's qwen `variants[emotion]` slot is
       recorded on success. Absent → the original base-voice design. */
    let emotion: Exclude<Emotion, 'neutral'> | undefined;
    if (body.emotion !== undefined) {
      if (
        typeof body.emotion !== 'string' ||
        !(VARIANT_EMOTIONS as string[]).includes(body.emotion)
      ) {
        return res.status(400).json({
          error: `emotion must be one of: ${VARIANT_EMOTIONS.join(', ')} (neutral is the base voice).`,
        });
      }
      emotion = body.emotion as Exclude<Emotion, 'neutral'>;
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;
    /* Mutual exclusion: a bulk "Design full cast" run owns the book's designs
       (serializing via the per-book lock). Refuse a competing single design so
       a drawer click can't fight the bulk run for the same voiceId. */
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error:
          'A "Design full cast" run is in progress for this book. Wait for it to finish (or cancel it) before designing a single voice.',
      });
    }
    /* fs-2 — design the voice in the BOOK's language. The sidecar bakes this
       into the cached voice manifest, and for a DESIGNED voice that manifest
       language is what every later synth speaks. A Russian book therefore
       yields Russian-speaking designed voices.

       #1951 corrected the parenthetical that used to sit here ("synth itself
       carries no language"): synth now CAN carry one. Node sends a per-request
       language for a CLONED voice only, where it overrides the manifest — a
       clone's manifest permanently says "English", so without it a clone reads
       every book in English. Designed voices are unaffected: no language is
       sent for them, so the baked manifest word still wins, exactly as before.
       See tts/sidecar.ts `resolveWireLanguage`. */
    const designLanguage = sidecarLanguageName(bookStateLanguage(located.state));

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

    /* #1954 — refuse an emotion variant for a cloned character. The design
       core holds the same invariant (see its comment for WHY refusal is the
       chosen resolution); this is the user-facing half, refused before any
       persona resolution or GPU work so the answer is an honest 409 rather
       than a 502 from the core's throw. Mirrors single-design.ts's
       `clone_protected` 409 — same code, so the drawer's existing handling
       reads it identically. Only the VARIANT path is gated: a base design on
       this route writes `qwen-<voiceUuid>.pt` and persists no override, so it
       never touches the clone. */
    if (emotion && characterHasClonedSlot(character)) {
      return res.status(409).json({
        error: clonedVariantRefusal(character.name ?? characterId),
        code: 'clone_protected',
      });
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

    /* Cache identity — the same (voiceId path, modelKey) the /sample player
       uses, so the audition we render here lands on the file it later reads.
       Required: without them we can't reproduce the player's cache key. */
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    if (!sampleVoiceId) {
      return res.status(400).json({
        error: '`sampleVoiceId` is required so the preview can be cached as the 12s sample.',
      });
    }
    if (!isTtsModelKey(body.modelKey)) {
      return res.status(400).json({
        error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}`,
      });
    }
    const modelKey = body.modelKey;

    /* Plan 161 — `preview:true` stages the design under a `-preview` sibling id
       so the live voice isn't overwritten during an A/B comparison; the drawer
       promotes it on approve. Default false keeps the original in-place design. */
    const isStandalone = located.state?.isStandalone === true;
    const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
    /* srv-43 — mint/persist a voiceUuid before the core names the .pt, but ONLY
       for a BASE design (which writes the `.pt` at the resulting `qwen-<uuid>`
       key). A VARIANT must NOT mint: it doesn't write the base `.pt`, so a fresh
       uuid would flip the base's storage key while its embedding stays at the
       old key — orphaning it (#1057). A variant reuses the character's existing
       voiceUuid and anchors on the base's current key. */
    const voiceUuid = emotion
      ? character.voiceUuid
      : await ensureCharacterVoiceUuid(bookDir, characterId, seriesInfo ?? undefined);
    const characterForDesign: CastCharacter = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };
    try {
      const { voiceId, url } = await designQwenVoiceForCharacter({
        bookDir,
        character: characterForDesign,
        characterId,
        persona,
        sampleVoiceId,
        modelKey,
        language: designLanguage,
        emotion,
        preview: body.preview === true,
        progressToken: typeof body.progressToken === 'string' ? body.progressToken : undefined,
        progressUrl: typeof body.progressUrl === 'string' ? body.progressUrl : undefined,
      });
      /* fs-25 — record a (non-preview) emotion variant onto the character's
         qwen slot so generation can resolve it (Wave 2) and the cast UI can show
         the Variants badge. The base-voice design itself still persists via the
         drawer's Save. */
      if (emotion && body.preview !== true) {
        /* Propagate the variant across the series (linked cast) — book-scoped
           only for a standalone. Mirrors the base-voice series scope. */
        await persistEmotionVariant(
          bookDir,
          characterId,
          emotion,
          voiceId,
          seriesInfo ?? undefined,
        );
      }
      /* srv-43 — return voiceUuid so the drawer can stamp it locally without
         a refetch; the /sample player needs it to hit the uuid-keyed cache. */
      return res.status(200).json({ voiceId, url, voiceUuid });
    } catch (e) {
      /* The core throws a user-facing message for sidecar/encode/timeout
         failures. Map the sidecar's OWN status through (#1801) — a 503 is the
         retryable "no GPU capacity, free VRAM and retry" signal, and flattening
         it to 502 left the caller unable to tell it apart from a broken
         gateway. Unreachable/cancelled (status 0) still lands on 502. */
      const { GpuBusyError } = await import('../gpu/gpu-load.js');
      if (e instanceof GpuBusyError) {
        return res.status(409).json({ error: e.message, code: 'gpu_busy' });
      }
      return res
        .status(httpStatusForSidecarError(e))
        .json({ error: (e as Error).message || 'Voice design failed.' });
    }
  },
);

/* Tear down a designed emotion variant: delete its `.pt`/`.json` embedding +
   persona sidecar and evict it from the sidecar's in-memory prompt cache.
   Best-effort throughout — a missing file or unreachable sidecar is non-fatal.
   Does NOT touch cast.json; the caller owns the slot mutation + atomic write so
   it can batch multiple removals into a single write. Shared by the per-emotion
   DELETE route and the redesign-invalidation in promote-voice. */
async function tearDownEmotionVariant(designedId: string): Promise<void> {
  await rm(qwenVoicePtPath(designedId), { force: true }).catch(() => {});
  await rm(qwenVoiceSidecarPath(designedId), { force: true }).catch(() => {});
  try {
    await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: designedId }),
    });
  } catch {
    /* sidecar unreachable — non-fatal */
  }
}

/* POST /api/books/:bookId/cast/:characterId/promote-voice

   Plan 161 — commit a previewed design (from the drawer's A/B "Design &
   compare") onto the character's stable `qwen-<id>` voice. Moves the preview
   `.pt`/`.json` onto the real id, refreshes the cached audition under the real
   id so "Play 12s" serves the approved take, and evicts the sidecar's
   in-memory prompt cache so a synth that loaded the OLD embedding earlier this
   session can't keep serving it. Body: `{ previewVoiceId, sampleVoiceId,
   modelKey }`. Returns `{ voiceId, url }` (the real id + its audition URL). */
qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/promote-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      previewVoiceId?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    const realVoiceId = qwenStorageKey(character, characterId);
    const expectedPreview = previewVoiceIdFor(realVoiceId);
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    if (previewVoiceId !== expectedPreview) {
      return res.status(400).json({ error: `previewVoiceId must be "${expectedPreview}".` });
    }
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    if (!sampleVoiceId) return res.status(400).json({ error: '`sampleVoiceId` is required.' });
    if (!isTtsModelKey(body.modelKey)) {
      return res
        .status(400)
        .json({ error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` });
    }
    const modelKey = body.modelKey;

    /* Move the staged embedding onto the stable id. rm-then-rename so a Windows
       rename over an existing file can't EPERM. A missing preview `.pt` means
       nothing was staged (e.g. a double-promote) → 409 — checked via `stat`
       BEFORE the live `.pt` is removed (#1804), so a double-promote can't
       delete a live artifact when the replacement was never staged. */
    try {
      await stat(qwenVoicePtPath(previewVoiceId));
    } catch (e) {
      return res
        .status(409)
        .json({ error: `No staged preview voice to promote (${(e as Error).message}).` });
    }
    await rm(qwenVoicePtPath(realVoiceId), { force: true });
    await rename(qwenVoicePtPath(previewVoiceId), qwenVoicePtPath(realVoiceId));
    await rm(qwenVoiceSidecarPath(realVoiceId), { force: true }).catch(() => {});
    await rename(qwenVoiceSidecarPath(previewVoiceId), qwenVoiceSidecarPath(realVoiceId)).catch(
      () => {},
    );
    /* Fix wave (consent-erasure gap) — carry the preview's retained reference
       clip (§2.3, written by the sidecar's design_voice) onto the real key too.
       Best-effort like the .json above (only the .pt is required): a voice
       designed before this fix, or one whose sidecar never wrote a clip, has
       no `-preview__master.wav` to move — must not 409 the whole promote. */
    await rm(qwenVoiceWavPath(`${realVoiceId}__master`), { force: true }).catch(() => {});
    await rename(
      qwenVoiceWavPath(`${previewVoiceId}__master`),
      qwenVoiceWavPath(`${realVoiceId}__master`),
    ).catch(() => {});

    /* Refresh the cached audition under the real id (same text, voiceName flips
       preview → real). Best-effort — a miss just means the next "Play 12s"
       synthesises fresh from the promoted `.pt`. */
    const calibrationText = buildSampleText(toVoiceLike(character), buildHintFromCast(character));
    const previewMp3 = voiceSampleFilePath(
      voiceSampleFileName({
        cacheScope: sampleVoiceId,
        modelKey,
        text: calibrationText,
        voiceName: previewVoiceId,
      }),
    );
    const realFileName = voiceSampleFileName({
      cacheScope: sampleVoiceId,
      modelKey,
      text: calibrationText,
      voiceName: realVoiceId,
    });
    await copyFile(previewMp3, voiceSampleFilePath(realFileName)).catch(() => {});
    await rm(previewMp3, { force: true }).catch(() => {});

    /* Evict the real id from the sidecar's in-memory prompt cache. Best-effort:
       a down/empty sidecar has nothing cached, and generation reads the fresh
       `.pt` from disk regardless. */
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: realVoiceId }),
      });
    } catch {
      /* sidecar unreachable — non-fatal */
    }

    /* A redesign replaces the base embedding in place, so every emotion variant
       minted from the OLD embedding is now stale (each was anchored to a PT that
       no longer exists). Invalidate them: drop the whole `variants` map from
       cast.json FIRST — so a mid-teardown failure can never leave cast.json
       referencing a `.pt` we've already deleted — then delete each variant's
       `.pt`/`.json` + evict it from the sidecar, addressing each by its stored
       `name` (the authoritative on-disk id) rather than reconstructing it. The
       character's tagged emotions then re-register as missing demand, so the
       cast's "Design full cast → Emotion variants" scope re-mints the ones the
       user still wants from the new base. */
    let staleVariantIds: string[] = [];
    /* Narrow by design. The artifact moves and the sidecar evict above stay OUTSIDE
       this lock: that fetch has no AbortSignal, so a hung sidecar would otherwise
       stall every cast write for this book. Global order: no other lock is held
       here (cast is last — see cast-lock.ts rule 4). */
    await withCastLock(located.bookDir, async () => {
      const fresh = await readJson<CastFile>(castJsonPath(located.bookDir));
      const freshChar = fresh?.characters?.find((c) => c.id === characterId);
      if (!fresh || !freshChar) return; // deleted mid-promotion — artifacts already moved
      const freshSlot = freshChar.overrideTtsVoices?.qwen;
      /* KEEP this guard — it is the current behaviour (qwen-voice.ts:788) and it
         encloses the write. Without it every promote-voice writes cast.json and
         takes the lock even when the character has no emotion variants, which is
         the common path. Evaluated against the FRESH slot, per rule 2. */
      if (freshSlot?.variants && Object.keys(freshSlot.variants).length > 0) {
        staleVariantIds = Object.values(freshSlot.variants)
          .map((v) => v?.name)
          .filter((n): n is string => !!n);
        delete freshSlot.variants;
        await writeJsonAtomic(castJsonPath(located.bookDir), fresh);
      }
    });
    /* Teardown stays outside: filesystem work, and holding the lock across it
       reintroduces exactly the stall this narrowing avoids. */
    for (const variantId of staleVariantIds) {
      await tearDownEmotionVariant(variantId);
    }

    /* srv-43 — return voiceUuid so the drawer can stamp it locally; the
       /sample player needs it to hit the uuid-keyed cache on the next play. */
    return res
      .status(200)
      .json({ voiceId: realVoiceId, url: voiceSamplePublicUrl(realFileName), voiceUuid: character.voiceUuid });
  },
);

/* POST /api/books/:bookId/cast/:characterId/discard-voice

   Plan 161 — drop a staged preview design (Cancel in the A/B compare).
   Best-effort cleanup of the preview `.pt`/`.json` + its cached audition;
   never touches the live voice. Body: `{ previewVoiceId, sampleVoiceId?,
   modelKey? }`. Always 200 `{ ok: true }` once the id is validated. */
qwenVoiceRouter.post(
  '/:bookId/cast/:characterId/discard-voice',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      previewVoiceId?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    const expectedPreview = previewVoiceIdFor(qwenStorageKey(character, characterId));
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    if (previewVoiceId !== expectedPreview) {
      return res.status(400).json({ error: `previewVoiceId must be "${expectedPreview}".` });
    }

    await rm(qwenVoicePtPath(previewVoiceId), { force: true }).catch(() => {});
    await rm(qwenVoiceSidecarPath(previewVoiceId), { force: true }).catch(() => {});
    // Fix wave (consent-erasure gap) — the preview design may also have
    // written its own retained reference clip (§2.3); erase it on reject too,
    // matching the pt/json cleanup above. No-op when absent (plain clone /
    // pre-fix design never wrote one).
    await rm(qwenVoiceWavPath(`${previewVoiceId}__master`), { force: true }).catch(() => {});
    if (typeof body.sampleVoiceId === 'string' && isTtsModelKey(body.modelKey)) {
      const calibrationText = buildSampleText(toVoiceLike(character), buildHintFromCast(character));
      const previewMp3 = voiceSampleFilePath(
        voiceSampleFileName({
          cacheScope: body.sampleVoiceId.trim(),
          modelKey: body.modelKey,
          text: calibrationText,
          voiceName: previewVoiceId,
        }),
      );
      await rm(previewMp3, { force: true }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  },
);

/* DELETE /api/books/:bookId/cast/:characterId/emotion-variant/:emotion

   fs-34 (fs-25 Wave 5e) — drop a designed emotion variant. Removes the
   `overrideTtsVoices.qwen.variants[emotion]` slot from cast.json and deletes the
   variant's `.pt` + `.json` on disk, so a bad design is discardable without
   touching the base voice. The base `qwen.name` and every other variant are
   preserved; an empty `variants` map is cleaned up so the Variants badge clears.
   Idempotent: removing an absent variant still returns 200. */
qwenVoiceRouter.delete(
  '/:bookId/cast/:characterId/emotion-variant/:emotion',
  async (req: Request, res: Response) => {
    const { bookId, characterId, emotion } = req.params;

    if (!(VARIANT_EMOTIONS as readonly string[]).includes(emotion)) {
      return res.status(400).json({
        error: `emotion must be one of: ${VARIANT_EMOTIONS.join(', ')}`,
      });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    /* #1981 — the read is inside the lock; the 404 and the variant-map
       mutation are both decisions derived from it. The teardown call below
       (embedding + sidecar file deletion, sidecar cache evict) touches no
       cast.json state, but stays inside the lock's closure anyway — it's the
       simplest shape and it doesn't itself take another lock on this book,
       so there's no ordering hazard (rule 1). */
    return withCastLock(located.bookDir, async () => {
      const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
      const character = cast?.characters?.find((c) => c.id === characterId);
      if (!character || !cast) {
        return res.status(404).json({ error: `Character "${characterId}" not found.` });
      }

      /* Drop the slot from cast.json (preserving base + sibling variants). */
      const qwenSlot = character.overrideTtsVoices?.qwen;
      if (qwenSlot?.variants && emotion in qwenSlot.variants) {
        delete qwenSlot.variants[emotion as Exclude<Emotion, 'neutral'>];
        if (Object.keys(qwenSlot.variants).length === 0) delete qwenSlot.variants;
        await writeJsonAtomic(castJsonPath(located.bookDir), cast);
      }

      /* Delete the designed embedding + persona sidecar and evict it (best-effort). */
      await tearDownEmotionVariant(`${qwenStorageKey(character, characterId)}__${emotion}`);

      return res.status(200).json({ ok: true, removed: emotion });
    });
  },
);
