/* Per-chapter synthesis pipeline.

   Strategy: fold the chapter's sentences into consecutive same-speaker runs
   ("sentence groups"), synthesise each group as one TTS call, then concatenate
   the PCM in narrative order. Per-group durations become segments on the
   chapter output. This dramatically cuts the call count vs per-sentence while
   still giving us per-group timing for the future playback slice. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { pickVoiceForEngine, type CharacterHint, type VoiceLike } from './voice-mapping.js';
import type { TtsEngine, TtsModelKey, TtsProvider } from './index.js';
import { resolveCharacterEngine } from './per-character-engine.js';
import { normaliseForTts } from './text-normalize.js';
import { pcmDurationSec } from './pcm.js';
import { resamplePcm16 } from './resample-pcm16.js';
import { withTtsRetry } from './retry.js';
import { gpuSemaphore } from '../gpu/semaphore.js';

/** Matches the on-disk cast.json shape (see `server/src/routes/voices.ts`
    `CastJsonCharacter` and the analyzer's Character output). The hint fields
    — description/role/gender/ageRange/tone/evidence — are what drives
    `pickVoiceForEngine` away from the narrator fallback for non-narrator
    characters. Dropping them here forces every character without a gendered
    word in its name/attributes to land on narrator-cool, which manifested as
    Elwin and Ro speaking in the narrator's voice. */
export interface CastCharacter {
  id: string;
  name?: string;
  role?: string;
  voiceId?: string;
  attributes?: string[];
  description?: string;
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  /** cast.json stores evidence as `{ quote?, note? }[]`; `pickVoiceForEngine`
      consumes a `string[]` of bare quotes. `buildHintFromCast` does the
      flattening. */
  evidence?: Array<{ quote?: string; note?: string } | string>;
  /** Per-engine user-set voice overrides. The active synth engine reads
      its own slot; missing slots fall through to attribute inference.
      Persisted in cast.json so it survives reloads + analysis reparses.
      Switching engines (Coqui ↔ Kokoro) preserves cast assignments
      because each engine has its own slot. */
  overrideTtsVoices?: Partial<Record<TtsEngine, { name: string }>> | null;
  /** @deprecated Legacy singular override. Read paths normalise this
      into `overrideTtsVoices` at cast.json load time (see
      `normaliseCastCharacter` in routes/voices.ts). Kept on the type so
      cast.json files written by older clients still satisfy this
      interface before normalisation. */
  overrideTtsVoice?: { engine: TtsEngine; name: string } | null;
  /** Per-character engine (plan 108). When set, this character is synthesised
      through this engine (e.g. `'qwen'` for a bespoke voice) regardless of the
      run's default engine; absent → the run default. The narrator typically
      leaves this unset and stays on the default (Kokoro). */
  ttsEngine?: TtsEngine | null;
}

export interface SentenceGroup {
  /** Position in narrative order (0-based). */
  index: number;
  characterId: string;
  /** Sentence ids folded into this group, in order. */
  sentenceIds: number[];
  /** Concatenated sentence text. */
  text: string;
}

export interface ChapterSegment {
  groupIndex: number;
  characterId: string;
  sentenceIds: number[];
  /** Inclusive start time in the chapter audio, in seconds. */
  startSec: number;
  /** Exclusive end time in the chapter audio, in seconds. */
  endSec: number;
  /** Discriminator for synthetic segments that aren't backed by a manuscript
      sentence. `'title'` marks the narrator-voiced chapter-title beat
      prepended to each chapter (see CHAPTER_LEAD_SILENCE_SEC below). Body
      sentences leave this field undefined so the on-disk segments.json
      shape stays backwards-compatible with pre-title chapters. */
  kind?: 'title';
}

/** Silence padding bookending the spoken chapter-title narration. Each chapter
    MP3 now opens with `[lead silence] + [narrator: title] + [post silence] +
    [body sentences]`. Defaults match standard audiobook chapter breaks —
    3.0 s of total padding is enough for the listener to register the
    boundary without dragging. Tuned together with the documented invariant
    in `docs/features/28-chapter-audio-format.md`; adjust both at once. */
const CHAPTER_LEAD_SILENCE_SEC = 1.5;
const CHAPTER_POST_TITLE_SILENCE_SEC = 1.5;

/** Build a zero-filled mono 16-bit LE PCM buffer of the requested duration.
    Matches the per-chapter PCM contract — same byte layout as what the TTS
    providers return, so the rest of the synth pipeline (concat, encode,
    loudnorm) treats it identically to spoken audio. */
function buildSilencePcm16(sampleRate: number, seconds: number): Buffer {
  const samples = Math.round(sampleRate * seconds);
  return Buffer.alloc(samples * 2);
}

export interface ChapterSynthesisResult {
  /** Concatenated 16-bit signed LE mono PCM, sample rate per `sampleRate`. */
  pcm: Buffer;
  sampleRate: number;
  durationSec: number;
  segments: ChapterSegment[];
}

export interface SynthesiseChapterOpts {
  sentences: SentenceOutput[];
  cast: CastCharacter[];
  provider: TtsProvider;
  modelKey: TtsModelKey;
  /** The run's DEFAULT engine — used for any character that doesn't carry its
      own `ttsEngine`, and the engine `provider`/`modelKey` below speak. Must
      match the engine behind `provider`. */
  engine: TtsEngine;
  /** Per-character engine routing (plan 108). When provided, each group + the
      title beat resolve their character's engine via `resolveCharacterEngine`
      and look up that engine's provider + modelKey here; absent → every
      character uses the default `provider`/`modelKey`/`engine` (byte-identical
      to pre-108). The caller (generation.ts) builds + caches one provider per
      engine so a mixed-engine chapter never reconstructs providers per group. */
  resolveForEngine?: (engine: TtsEngine) => { provider: TtsProvider; modelKey: TtsModelKey };
  /** Notification fired *before* each group's TTS call starts. Needed because
      a single group can be a multi-minute call on CPU (e.g. a long narrator
      block folded into one synth), and without a tick at the start the SSE
      goes silent and the UI's 30s "Worker has gone quiet" banner fires for
      what is actually healthy in-progress work. Letting the route handler
      emit a "synthesising group N" tick here resets the client-side stall
      timer at each group boundary. */
  onGroupStart?: (e: { group: SentenceGroup; totalGroups: number; accumulatedSec: number }) => void;
  /** Notification on each group completion. Optional. */
  onGroupComplete?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
  }) => void;
  /** Notification fired before each auto-retry sleep when the provider
      throws a transient error. `attempt` is the 1-indexed attempt
      number that's about to start (so the first retry passes attempt=2).
      The route handler can wire this to the SSE stream to surface a
      "retrying group N (attempt 2/3) — sidecar 503" hint while the
      auto-retry runs; persistent failures still throw out of
      `synthesiseChapter` exactly as before. */
  onGroupRetry?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    attempt: number;
    backoffMs: number;
    reason: string;
  }) => void;
  /** Optional abort signal — checked between groups and forwarded to the
      provider so an in-flight TTS call can be cancelled mid-call. Used by
      the per-bookId server mutex to stop a stale generation handler when a
      new POST arrives for the same book. */
  signal?: AbortSignal;
  /** Pre-built spoken phrase for the chapter title (e.g. `"Chapter 2.
      Moolark."`). Built by `buildChapterTitleNarration` in
      `chapter-title-narration.ts` from `chapter.id` + parsed `chapter.title`.
      When non-empty, the synth loop prepends
      `[CHAPTER_LEAD_SILENCE_SEC of silence] + [narrator voicing this string]
      + [CHAPTER_POST_TITLE_SILENCE_SEC of silence]` ahead of the body
      sentences. The title's TTS response anchors the chapter's sample rate
      (same rule the first body group used before this feature). Undefined or
      blank skips the title beat AND the silence padding — legacy behaviour
      for callers that don't opt in. */
  chapterTitleNarration?: string;
  /** Cast id used to look up the voice for the chapter-title narration.
      Defaults to `'narrator'`, the special-cased narrator character
      (`src/views/listen.tsx:139`). The picker falls through to a
      narrator-voice bucket when the character has no gender / age / tone
      hints, which is the correct routing for the title regardless of
      whether the cast actually contains a `'narrator'` row. */
  narratorCharacterId?: string;
  /** Tick BEFORE the chapter-title TTS call begins. Lets the SSE route emit
      a "Synthesising chapter title…" hint so the client's stall detector
      doesn't fire while the (potentially multi-second) title synth runs.
      Mirrors `onGroupStart` for body groups. */
  onTitleStart?: () => void;
  /** Tick AFTER the chapter-title TTS call completes. The accumulated
      duration is the audio time at the end of the title segment (i.e. the
      moment the post-title silence begins). */
  onTitleComplete?: (e: { accumulatedSec: number }) => void;
  /** How many sentence groups to *attempt* concurrently (plan 107). Each
      `provider.synthesize` already acquires the global `gpuSemaphore`
      (`server/src/tts/sidecar.ts`), so this width never oversubscribes the
      GPU — it only governs how many groups are dispatched before we await
      results. Defaults to `gpuSemaphore.maxConcurrency` (read from
      `GPU_CONCURRENCY` once at module load), so at the conservative default
      `GPU_CONCURRENCY=1` the width is 1 and dispatch is byte-identical to the
      old serial loop. An explicit value is mainly for tests, which need to
      exercise width>1 without touching process env. Clamped to >= 1. */
  sentenceConcurrency?: number;
}

/** One group per sentence. Plan 70d — earlier code folded consecutive
    same-speaker sentences into one synth call to cut HTTP roundtrips.
    Two production failures pushed us to per-sentence:
      1. A 207-sentence narrator block on the canonical Keeper book
         folded into one Kokoro call that ran longer than the 30 s
         "Worker has gone quiet" client watchdog, then either timed out
         on the model side or hung at very large context sizes — never
         emitting a chapter_complete.
      2. Voice drift inside a long same-speaker group as Kokoro / XTTS
         context-position pressure shifts prosody mid-chunk.
    Per-sentence also gives the SSE stream a progress tick per sentence
    so the UI's "line N of M" caption advances continuously instead of
    sitting on `1 of 207` for the whole call.
    Order preserved. */
export function buildSentenceGroups(sentences: SentenceOutput[]): SentenceGroup[] {
  return sentences.map((s, i) => ({
    index: i,
    characterId: s.characterId,
    sentenceIds: [s.id],
    text: s.text,
  }));
}

/** Build the VoiceLike payload that pickVoiceForEngine consumes from a
    confirmed-cast Character. Uses voiceId when present so the same character
    in the library stays on the same prebuilt voice; falls back to characterId.

    Passes BOTH the new per-engine map and the legacy singular field; the
    picker prefers the map when present and the synth engine matches a
    slot. The legacy field is only consulted as a fallback for cast.json
    files that haven't yet round-tripped through the normaliser. */
export function toVoiceLike(c: CastCharacter): VoiceLike {
  return {
    id: c.voiceId ?? c.id,
    character: c.name,
    attributes: c.attributes ?? [],
    overrideTtsVoices: c.overrideTtsVoices ?? null,
    overrideTtsVoice: c.overrideTtsVoice ?? null,
  };
}

/** Project the cast.json shape onto the CharacterHint the voice picker wants.
    Without this, `inferGender` falls back to the description/attribute scan
    and almost always returns 'unknown' (the analyzer's attributes are
    personality traits, not gendered nouns), which routes every character to
    narrator-cool. */
export function buildHintFromCast(c: CastCharacter): CharacterHint {
  const evidence = (c.evidence ?? [])
    .map((e) => (typeof e === 'string' ? e : e?.quote))
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
  return {
    description: c.description,
    role: c.role,
    gender: c.gender,
    ageRange: c.ageRange,
    tone: c.tone,
    evidence: evidence.length ? evidence : undefined,
  };
}

export async function synthesiseChapter(
  opts: SynthesiseChapterOpts,
): Promise<ChapterSynthesisResult> {
  const {
    sentences,
    cast,
    provider,
    modelKey,
    engine,
    resolveForEngine,
    onGroupStart,
    onGroupComplete,
    onGroupRetry,
    signal,
    chapterTitleNarration,
    narratorCharacterId = 'narrator',
    onTitleStart,
    onTitleComplete,
    sentenceConcurrency = gpuSemaphore.maxConcurrency,
  } = opts;

  /* Per-character engine resolver (plan 108). Returns the engine + its
     provider + modelKey for a given character. When the caller supplied
     `resolveForEngine`, each character routes to its own engine's provider;
     otherwise everything uses the run default — byte-identical to pre-108. */
  const routeFor = (
    c: CastCharacter,
  ): { engine: TtsEngine; provider: TtsProvider; modelKey: TtsModelKey } => {
    const charEngine = resolveCharacterEngine(c, engine);
    if (resolveForEngine && charEngine !== engine) {
      const r = resolveForEngine(charEngine);
      return { engine: charEngine, provider: r.provider, modelKey: r.modelKey };
    }
    return { engine: charEngine, provider, modelKey };
  };

  const castById = new Map(cast.map((c) => [c.id, c]));
  const groups = buildSentenceGroups(sentences);

  /* Pool width — how many groups we *attempt* at once. Real GPU concurrency
     is still capped by the global `gpuSemaphore` each `synthesize` acquires,
     so a width > the semaphore cap just queues; it never oversubscribes. At
     the default `GPU_CONCURRENCY=1` this is 1 → byte-identical to the old
     serial loop. Clamp to >= 1 (a width of 0 would dispatch nothing). */
  const poolWidth = Math.max(1, Math.floor(sentenceConcurrency));

  const chunks: Buffer[] = [];
  const segments: ChapterSegment[] = [];
  let runningBytes = 0;
  let sampleRate = 24000; // first call sets this; default matches Gemini's documented rate.

  /* Title beat: when the caller supplies a pre-built spoken phrase, prepend
     `[lead silence] + [narrator voicing the title] + [post silence]` ahead
     of the body groups. The title's TTS response anchors the chapter's
     sample rate, so the silence buffers can be sized correctly without
     guessing — we synth the title first, set the anchor from its response,
     then bracket it with silence. The title contributes one synthetic
     segment with `kind: 'title'` and an empty sentenceIds[]; the silence
     padding is deliberately NOT recorded as segments (it's not narration,
     it's structural padding, and the listen view's timeline shouldn't show
     dead-air rows). */
  const titleText = chapterTitleNarration?.trim();
  if (titleText) {
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const narratorChar =
      castById.get(narratorCharacterId) ?? { id: narratorCharacterId, name: 'Narrator' };
    /* The title beat speaks in the narrator's engine — which, per plan 108, is
       usually the default (Kokoro) since the narrator rarely carries a bespoke
       per-character engine. routeFor honours an explicit narrator ttsEngine if
       one is set. */
    const titleRoute = routeFor(narratorChar);
    const narratorVoice = pickVoiceForEngine(
      titleRoute.engine,
      toVoiceLike(narratorChar),
      buildHintFromCast(narratorChar),
    );

    onTitleStart?.();

    const titleResult = await withTtsRetry(
      () =>
        titleRoute.provider.synthesize({
          text: normaliseForTts(titleText),
          voiceName: narratorVoice,
          modelKey: titleRoute.modelKey,
          signal,
        }),
      { signal },
    );

    sampleRate = titleResult.sampleRate;
    const leadSilence = buildSilencePcm16(sampleRate, CHAPTER_LEAD_SILENCE_SEC);
    const postSilence = buildSilencePcm16(sampleRate, CHAPTER_POST_TITLE_SILENCE_SEC);

    chunks.push(leadSilence);
    runningBytes += leadSilence.length;
    const titleStartSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(titleResult.pcm);
    runningBytes += titleResult.pcm.length;
    const titleEndSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(postSilence);
    runningBytes += postSilence.length;

    segments.push({
      groupIndex: -1,
      characterId: narratorChar.id,
      sentenceIds: [],
      startSec: titleStartSec,
      endSec: titleEndSec,
      kind: 'title',
    });

    onTitleComplete?.({ accumulatedSec: titleEndSec });
  }

  /* Per-group synth: pick the voice, fire the stall-resetting `onGroupStart`
     tick, then run the (auto-retrying) provider call. Factored out of the
     dispatch loop so the up-front anchor synth (groups[0]) and the worker
     pool share one code path — and so a future engine-specific tweak lands
     in exactly one place. Returns the RAW provider result; the caller stores
     it by index and concatenates later, so this never touches `chunks`,
     `runningBytes`, or `segments` (which would race under parallel workers). */
  async function synthGroup(group: SentenceGroup): Promise<{ pcm: Buffer; sampleRate: number }> {
    const character = castById.get(group.characterId) ?? { id: group.characterId };
    /* Per-character engine routing (plan 108): resolve this character's engine
       + its provider + modelKey, then pick a voice from THAT engine. A
       narrator-on-Kokoro + hero-on-Qwen chapter routes each group correctly;
       the index-order concat below resamples any per-engine sample-rate
       mismatch to the chapter anchor, so mixed engines reassemble cleanly. */
    const route = routeFor(character);
    const voiceName = pickVoiceForEngine(
      route.engine,
      toVoiceLike(character),
      buildHintFromCast(character),
    );

    /* Tick BEFORE the synth call. Each TTS call can be minutes on CPU, and
       the client's stall detector only sees inactivity, not "active work on
       a long call" — so without this beat the user sees "Worker has gone
       quiet" for what is actually a healthy in-flight synth. The accumulated
       time is a running estimate; the authoritative per-segment timing is
       computed in the deterministic index-order pass after all groups
       settle. */
    onGroupStart?.({
      group,
      totalGroups: groups.length,
      accumulatedSec: pcmDurationSec(runningBytes, sampleRate),
    });

    /* Scrub all-caps runs and em/en-dashes immediately before the synth.
       XTTS otherwise spells multi-word all-caps openers letter-by-letter
       (chapter 1's "ONE" → "oh-en-ee" in 1.15s) and loops on em-dashes,
       which together produced ~60s of garbled audio at the top of
       chapter 2 of the canonical Keeper manuscript. The transform is
       idempotent; segment metadata still references the original
       SentenceOutput so UI captions and quote audits are unaffected.

       Wrapped in `withTtsRetry` so the queue absorbs flaky transients
       (sidecar 5xx mid-load, brief connection refused while the user
       toggled Stop, network blip). Non-transient throws (4xx, poisoned
       CUDA state, retry-exhausted) bubble out of the wrapper unchanged
       and surface as today's per-chapter `chapter_failed`. */
    const result = await withTtsRetry(
      () =>
        route.provider.synthesize({
          text: normaliseForTts(group.text),
          voiceName,
          modelKey: route.modelKey,
          signal,
        }),
      {
        signal,
        onRetry: (info) =>
          onGroupRetry?.({
            group,
            totalGroups: groups.length,
            attempt: info.attempt,
            backoffMs: info.backoffMs,
            reason: info.reason,
          }),
      },
    );
    return { pcm: result.pcm, sampleRate: result.sampleRate };
  }

  /* Body groups — bounded-concurrency dispatch (plan 107). Replaces the old
     serial `for (const group of groups)` loop with `poolWidth` workers that
     pull from a shared cursor (mirrors plan 87's chapter worker pool in
     `server/src/routes/generation.ts`). The semaphore inside every
     `provider.synthesize` is the real GPU governor; this pool only governs
     how many groups are *in flight* at the Node layer.

     Determinism under parallelism rests on three rules, all paired with
     tests in `synthesise-chapter.test.ts`:

       1. PCM ORDER — each worker writes its raw `synthesize` result into a
          pre-sized `results[group.index]` slot. We never push to `chunks`
          from a worker; concat happens in a single index-order pass AFTER
          all workers settle, so completion order can't reorder the audio.
       2. SAMPLE-RATE ANCHOR — the anchor is fixed BEFORE dispatch: the title
          rate when a title beat ran, else `groups[0]`'s rate (lowest index),
          NOT the first group to complete. The old `chunks.length === 0`
          "first to finish" rule was non-deterministic the moment two groups
          could finish in either order, so we synth `groups[0]` first to read
          its rate, then fan the rest out.
       3. STALL WATCHDOG — `onGroupStart` fires as each group BEGINS its synth
          (inside the worker, before the `synthesize` call) so the 30 s client
          watchdog (`STALL_THRESHOLD_MS`, `src/store/chapters-slice.ts`) keeps
          resetting. `onGroupComplete` fires per group as it finishes. The
          final per-segment `startSec`/`endSec` are computed in the index-order
          pass below — only there is the cumulative offset deterministic. */

  type GroupResult = { pcm: Buffer; sampleRate: number };
  const results: (GroupResult | undefined)[] = new Array(groups.length);
  let completedCount = 0;

  /* Anchor the chapter's output rate before dispatch. If a title beat ran,
     `chunks` already holds the title PCM and `sampleRate` is its rate — keep
     it (same rule as before this feature). Otherwise synth the lowest-index
     body group up front so its rate becomes the deterministic anchor,
     regardless of which group the pool finishes first. */
  let bodyStartIndex = 0;
  if (chunks.length === 0 && groups.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const anchorGroup = groups[0];
    const result = await synthGroup(anchorGroup);
    results[anchorGroup.index] = { pcm: result.pcm, sampleRate: result.sampleRate };
    sampleRate = result.sampleRate;
    completedCount += 1;
    onGroupComplete?.({
      group: anchorGroup,
      totalGroups: groups.length,
      accumulatedSec: 0, // recomputed deterministically in the index-order pass.
    });
    bodyStartIndex = 1;
  }

  /* Index-pulling worker pool over the remaining groups. `poolWidth` workers
     share `nextIndex`; each pulls the next group, synths it, and stores the
     raw result by `group.index`. At `poolWidth === 1` this is a plain serial
     walk — byte-identical to the old loop. */
  let nextIndex = bodyStartIndex;
  const effectiveWidth = Math.min(poolWidth, Math.max(1, groups.length - bodyStartIndex));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < effectiveWidth; w++) {
    workers.push(
      (async () => {
        for (;;) {
          /* Cheap abort check before claiming the next group — covers the
             common case where the outer handler decides to stop (per-bookId
             mutex, request close, etc.) and the next TTS call would otherwise
             burn another minute or two of sidecar time. The provider also
             receives the signal so a mid-call abort is honoured. */
          if (signal?.aborted) {
            throw new DOMException('synthesiseChapter aborted', 'AbortError');
          }
          const i = nextIndex++;
          if (i >= groups.length) return;
          const group = groups[i];
          const result = await synthGroup(group);
          results[group.index] = { pcm: result.pcm, sampleRate: result.sampleRate };
          completedCount += 1;
          onGroupComplete?.({
            group,
            totalGroups: groups.length,
            // recomputed deterministically in the index-order pass below.
            accumulatedSec: 0,
          });
        }
      })(),
    );
  }
  await Promise.all(workers);

  /* Single index-order pass: walk `results` by group index, resample any
     mismatched rate to the anchor, append in order, and compute the final
     per-segment `startSec`/`endSec` against the now-known cumulative offset.
     This is the ONLY place audio is concatenated, so completion order can
     never reorder PCM or shuffle segment timing. */
  for (const group of groups) {
    const r = results[group.index];
    /* Defensive: a worker that returned early on abort can leave a hole.
       The abort would already have thrown out of `Promise.all`, so this is
       belt-and-braces for a future refactor. */
    if (!r) continue;
    let pcmForGroup = r.pcm;
    if (r.sampleRate !== sampleRate) {
      pcmForGroup = resamplePcm16(r.pcm, r.sampleRate, sampleRate);
    }
    const startSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(pcmForGroup);
    runningBytes += pcmForGroup.length;
    const endSec = pcmDurationSec(runningBytes, sampleRate);
    segments.push({
      groupIndex: group.index,
      characterId: group.characterId,
      sentenceIds: group.sentenceIds.slice(),
      startSec,
      endSec,
    });
  }
  void completedCount;

  const pcm = Buffer.concat(chunks);
  return {
    pcm,
    sampleRate,
    durationSec: pcmDurationSec(pcm.length, sampleRate),
    segments,
  };
}
