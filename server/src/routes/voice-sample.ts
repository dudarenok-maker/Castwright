/* POST /api/voices/:voiceId/sample
   Synthesises a ~12-second voice preview via the TTS provider selected by
   `modelKey` (local sidecar or Gemini) and serves it from the static /audio
   mount. Files are cached on disk keyed by voiceId + modelKey + paramHash,
   so a repeat click is instant and engine-specific. Encoded to MP3 via the
   same `encodePcmToAudio` boundary used by chapter audio (plan 28). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { safeSegment } from '../util/safe-path.js';
import {
  canonicalModelKeyForEngine,
  engineForModelKey,
  isTtsModelKey,
  selectTtsProvider,
  TTS_MODEL_LABELS,
  type TtsEngine,
  type TtsModelKey,
} from '../tts/index.js';
import { cloneStorageKey, isCloneEngine, manifestSlotFor } from '../tts/clone-engines.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import { pcmDurationSec } from '../tts/pcm.js';
import { pickVoiceForEngine, type CharacterHint, type VoiceLike } from '../tts/voice-mapping.js';
import {
  buildSampleText,
  djb2,
  voiceSampleAudioDir,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { clonedVoiceLacksConsent, readEntry } from '../workspace/voice-library.js';

export const voiceSampleRouter = Router();

/* Fixed neutral preview script used by the "Base voices" tab and the
   family-header Play buttons. Same text for every (engine, speaker)
   combination so the user can A/B compare without the prompt changing
   under them. Kept short (~12s spoken) to stay under the sidecar's
   synth budget. */
const RAW_SAMPLE_TEXT =
  'Hello — this is the unmodified model voice. ' +
  'Listen for tone, pacing, and pronunciation; ' +
  'no profile attributes have been applied.';

function isTtsEngine(value: unknown): value is TtsEngine {
  return value === 'coqui' || value === 'gemini' || value === 'piper' || value === 'kokoro';
}

voiceSampleRouter.post('/:voiceId/sample', async (req: Request, res: Response) => {
  const { voiceId } = req.params;
  const body = (req.body ?? {}) as {
    modelKey?: unknown;
    voice?: VoiceLike;
    text?: string;
    characterHint?: CharacterHint;
    rawEngine?: unknown;
    rawSpeaker?: unknown;
    /** fs-59 W4b — book/character BCP-47 language, e.g. 'zh'. Optional;
        absent means "use the sidecar's boot-time default" (unchanged,
        backward-compatible for English). Threaded straight through to
        provider.synthesize — SidecarTtsProvider applies the Coqui-only
        zh→zh-cn wire-format map, never here. */
    language?: string;
  };

  if (!isTtsModelKey(body.modelKey)) {
    return res.status(400).json({
      code: 'invalid_model',
      message: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}`,
    });
  }
  const modelKey: TtsModelKey = body.modelKey;
  const voice: VoiceLike = body.voice ?? { id: voiceId };

  /* Compute the synthesis inputs up front so the cache filename can include
     a hash of (text, voiceName). Otherwise an attribute edit (gender, age,
     tone) that picks a different prebuilt voice or evidence line would
     silently return the previous run's audio.

     Raw-sample branch: when the client sets `rawEngine` + `rawSpeaker`, the
     picker is bypassed entirely and the named speaker is synthesised
     directly with the fixed neutral script. The cache key drops the voiceId
     and shifts onto `raw-<engine>-<speaker>` so unused base voices share
     one cache slot across every voiceId path the request happened to land
     on, and so toggling between auto-resolved and raw samples for the same
     voiceId doesn't trample each other. */
  const isRawSample =
    isTtsEngine(body.rawEngine) &&
    typeof body.rawSpeaker === 'string' &&
    body.rawSpeaker.trim().length > 0;

  let engine: TtsEngine;
  let text: string;
  let voiceName: string;
  let cacheScope: string;
  let effectiveModelKey: TtsModelKey = modelKey;
  if (isRawSample) {
    engine = body.rawEngine as TtsEngine;
    voiceName = (body.rawSpeaker as string).trim();
    text = (body.text && body.text.trim()) || RAW_SAMPLE_TEXT;
    cacheScope = `raw-${engine}-${djb2(voiceName).toString(36).slice(0, 6)}`;
    /* The client may have passed any modelKey it had handy (whatever the
       project's currently set to). Re-pick one that actually routes to the
       requested engine, otherwise selectTtsProvider would send a Coqui speaker
       name to the Gemini provider or vice versa.

       canonicalModelKeyForEngine (../tts/model-keys.ts) is the ONE
       engine→modelKey table on this side of the wire; the frontend mirror is
       modelKeyForEngineChoice (src/lib/tts-models.ts). Behaviour here is
       unchanged — under this guard the local table it replaced agreed on every
       reachable input. */
    if (engineForModelKey(modelKey) !== engine) {
      effectiveModelKey = canonicalModelKeyForEngine(engine, modelKey);
    }
  } else {
    engine = engineForModelKey(modelKey);
    text = (body.text && body.text.trim()) || buildSampleText(voice, body.characterHint);
    voiceName = pickVoiceForEngine(engine, voice, body.characterHint);
    cacheScope = voiceId;
  }

  /* fs-38 Wave 3c, Task 2 — a cloned voice whose consent has been revoked
     must never be played again, from either branch, cache hit or not. This
     runs BEFORE the existsSync short-circuit below: a cache entry written
     while consent was valid must not outlive a later revoke. Keyed off the
     RESOLVED (engine, voiceName) rather than the client-supplied `voice`
     object — the raw-speaker bypass (isRawSample, above) has no character
     context at all, so a client could otherwise hand a cloned storage key
     straight to `rawSpeaker` and skip any character-level gate entirely.
     Mirrors the consent check in routes/voice-library.ts:428 (now shared via
     clonedVoiceLacksConsent). A designed (non-cloned) voice resolves to the
     identical `qwen-<uuid>` key shape (see voice-mapping.ts qwenStorageKey)
     — provenance, not key shape, is what distinguishes them, so this reads
     the library entry rather than trusting the client-supplied `provenance`
     field. */
  if (isCloneEngine(engine)) {
    /* GATE 1 fix (C4) — the prefix test is CASE-FOLDED, matching the two
       sibling guards added in this same wave (voice-override-linked.ts's
       `nameLower.startsWith(prefix)` and preserve-cast-voices.ts's). This was
       the only clone-key check on the branch that wasn't, and it sits on the
       one route that actually PLAYS audio: `rawSpeaker: 'XTTS-<uuid>'` failed
       the case-sensitive `startsWith`, so `readEntry` was never called, the
       403 never fired, and a revoked person's voice rendered. The sidecar
       resolves it anyway — main.py's `re.sub(r"[^A-Za-z0-9_.-]", "_", …)`
       preserves case and `os.path.isfile` is case-insensitive on NTFS/APFS,
       so `XTTS-<uuid>.pt` opens the real `xtts-<uuid>.pt`. Two aggravating
       consequences the fold also closes: the sidecar's `_evict_epoch` /
       `_latents_cache` are dicts keyed on the RAW voice_id, so a render under
       a case-varied key had its own epoch at 0 and was never interrupted by
       the evict-epoch stop; and `asciiFileScope` preserves case, so the
       resulting audition cached under a `raw-coqui-<djb2>` scope no purge
       sweep ever computes.

       Only the PREFIX is folded — the uuid tail is sliced verbatim, never
       lower-cased. `randomUUID()` and `nanoid()` both mint mixed-case uuids,
       so lower-casing the tail would break `readEntry` on a case-sensitive
       filesystem. A case-varied UUID is not a bypass either way: on NTFS/APFS
       `readEntry`'s own `existsSync` matches it exactly as the sidecar's
       `os.path.isfile` does, and on a case-sensitive filesystem neither
       resolves. */
    const prefix = `${manifestSlotFor(engine)}-`; // manifestSlotFor already returns lower-case
    if (voiceName.toLowerCase().startsWith(prefix)) {
      const libraryUuid = voiceName.slice(prefix.length);
      const entry = await readEntry(libraryUuid);
      if (clonedVoiceLacksConsent(entry)) {
        return res.status(403).json({
          error: 'This cloned voice has no valid consent and cannot be played.',
        });
      }
      /* Fix wave (cache-scope gap) — for a CLONED voice reached via the
         normal (non-raw) branch, cache under the resolved storage key
         (`qwen-<uuid>` / `xtts-<uuid>`) instead of the character id,
         mirroring what routes/voice-library.ts:440 already does for its own
         /sample route. This makes the scope derivable from `voiceUuid`
         alone, so the EXISTING storageKey-scoped sweep in
         purge-clone-artifacts.ts reaches it on revoke — previously a file
         cached here (character-id scoped) was unreachable by any purge and
         outlived a revoke on disk (the consent gate above still stopped it
         being served, but "present but unreachable" fails total erasure).
         Only cloned slots: a designed/imported voice's cache scope must
         stay byte-for-byte unchanged. The raw branch is untouched — it
         already caches under its own engine+speaker scope, unrelated to
         `voiceId`. Note: a cloned audition cached under the OLD
         (character-id) scope before this change is now a cache miss and
         re-renders once — acceptable, and the stale file itself is inert
         (the gate above already refuses to serve any revoked voice
         regardless of cache scope). */
      if (!isRawSample && entry?.provenance === 'cloned') {
        cacheScope = cloneStorageKey(engine, libraryUuid);
      }
    }
  }

  const fileName = voiceSampleFileName({ cacheScope, modelKey: effectiveModelKey, text, voiceName });
  const filePath = voiceSampleFilePath(safeSegment(fileName));
  const publicUrl = voiceSamplePublicUrl(fileName);

  if (existsSync(filePath)) {
    return res.json({ url: publicUrl, durationSec: null, cached: true, modelKey });
  }

  await mkdir(voiceSampleAudioDir(), { recursive: true });

  let provider;
  try {
    provider = selectTtsProvider(effectiveModelKey);
  } catch (err) {
    return res.status(500).json({
      code: 'provider_unavailable',
      message: (err as Error).message,
    });
  }

  console.info(
    `[tts] ${cacheScope} → ${voiceName} (engine=${engine}, model=${effectiveModelKey}, ${text.length} chars, file=${fileName})`,
  );

  try {
    const { pcm, sampleRate } = await provider.synthesize({
      text,
      voiceName,
      modelKey: effectiveModelKey,
      ...(typeof body.language === 'string' && body.language ? { language: body.language } : {}),
    });
    /* Compute duration from raw PCM before encode — MP3 frame counting would
       force a probe step. PCM bytes/sec is exact for 16-bit mono. */
    const durationSec = pcmDurationSec(pcm.length, sampleRate);
    /* No loudnorm for voice samples — only chapter audio gets the EBU R128
       pass (plan 71). Voice samples are short auditions where program-level
       normalisation has no listening benefit and would add ~20 % latency to
       every Play-sample click. */
    const mp3 = await encodePcmToAudio(pcm, sampleRate);
    await writeFile(filePath, mp3);
    return res.json({ url: publicUrl, durationSec, cached: false, modelKey });
  } catch (err) {
    /* #1839 — the GPU is genuinely full and admission gave up. Name what's
       holding it (Coqui / Kokoro, each with its own actionable remedy) rather
       than falling through to the generic 502 `tts_failed` below. */
    if (err instanceof NoCapacityError) {
      return res.status(503).json({
        code: 'no_capacity',
        message: err.message,
        blockers: err.blockers,
      });
    }
    const msg = (err as Error).message ?? 'TTS synthesis failed.';
    /* GATE 1 — the sidecar's `voice_language_unsupported` 409 (main.py's
       /synthesize handler): the voice IS cloned and its artifact loaded, the
       loaded XTTS model just doesn't list the requested language. Its detail
       text contains neither `voice_not_designed` nor "not been designed yet",
       so without this arm it missed the arm below and fell through to the
       generic 502 `tts_failed` — telling the user their sample failed for an
       unknown gateway reason instead of the one thing they can act on.
       Ordered FIRST, mirroring the sidecar's own MIN-4 ordering (the Python
       exception is a SUBCLASS of VoiceNotDesignedError), so a future widening
       of the arm below can't swallow this one. Chapter render is NOT affected
       — it never routes through this route's catch. */
    if (/voice_language_unsupported/i.test(msg)) {
      return res.status(409).json({
        code: 'voice_language_unsupported',
        message:
          'This voice cannot speak the requested language on the loaded voice model — re-cloning it will not help; pick a supported language or a different engine.',
      });
    }
    /* #1063 — the sidecar returns 409 `voice_not_designed` when the requested
       voice/variant has no cached embedding (a bad-input condition, not an
       engine fault). Surface it as a clean 4xx with a distinct code + actionable
       message instead of re-wrapping it as the generic 502 `tts_failed` below,
       so the UI can say "design this voice first". The raw `msg` is the
       "Local voice engine returned 409: {json}" wrapper (sidecar.ts) — we
       replace it with friendly copy rather than echo the JSON body. */
    if (/voice_not_designed|not been designed yet/i.test(msg)) {
      return res.status(409).json({
        code: 'voice_not_designed',
        message:
          'This voice or emotion variant has not been designed yet — design it first, then play the sample.',
      });
    }
    /* ffmpeg-not-on-PATH is a deploy issue, not a runtime TTS issue —
       surface it as its own code so the UI can hint at the install fix
       (scripts/start-app.ps1 preflight should normally prevent this). */
    const isEncoderMissing = /Failed to spawn ffmpeg/i.test(msg);
    const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(msg);
    const isRateLimit = /429|rate|quota/i.test(msg);
    const status = isEncoderMissing ? 503 : isSidecarDown ? 503 : isRateLimit ? 429 : 502;
    const code = isEncoderMissing
      ? 'encoder_unavailable'
      : isSidecarDown
        ? 'sidecar_down'
        : isRateLimit
          ? 'rate_limited'
          : 'tts_failed';
    return res.status(status).json({ code, message: msg });
  }
});
