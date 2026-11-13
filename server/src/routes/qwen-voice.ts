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
import { rename, rm, copyFile, stat, readdir, readFile, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { findBookByBookId, requireBookStateLanguage, BookLanguageUnsetError } from '../workspace/scan.js';
import { BOOK_GONE, peekBook, withBookOp, withBookOps, type BookHandle } from '../workspace/book-op-lock.js';
import { runBookJob } from '../workspace/book-jobs.js';
import { sidecarLanguageName } from '../tts/language.js';
import {
  castJsonPath,
  qwenVoiceSidecarPath,
  qwenVoicePtPath,
  qwenVoiceWavPath,
  qwenVoicesDir,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { renameWithRetry, RENAME_RETRY_DELAYS_MS, RETRYABLE_CODES } from '../workspace/atomic-rename.js';
import { withCastLock, withCastLocks } from '../workspace/cast-lock.js';
import {
  forgetSeparatedVoice,
  isSeparatedVoice,
  isOwnSeparatedVoice,
  isSeparatedVoiceSync,
  markDeclineSeparatedVoice,
  recordSeparatedVoice,
  UNNAMED_OWN_STAMP,
} from '../workspace/separated-voices.js';
import { isFsError, isLockAcquisitionTimeout, requestFailureMessage, requestFailureMessageFs } from '../workspace/file-lock.js';
import { EMOTIONS, type Emotion } from '../handoff/schemas.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import { withDesignLock, isDesignBusy } from '../tts/design-lock.js';
import { buildHintFromCast, toVoiceLike, type CastCharacter } from '../tts/synthesise-chapter.js';
import { forEachMatchingCastCharacter, hasClonedSlotAmongMatches } from './voices.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { refuseGatedSeriesFanOut } from '../workspace/repaired-series-refusal.js';
import {
  buildSampleText,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import { characterHasClonedSlot } from '../tts/clone-engines.js';
import {
  legacyKeyHolderBookIds,
  namedQwenVoices,
  scanVoiceHolders,
  voiceHeldBy,
  type VoiceScan,
  mustSeparateOnDecline,
  mustSeparateOnDesign,
  type LinkFollower,
  readBookId,
  readBookCastConfirmed,
  readBookOwnStamp,
  RetryableForkError,
} from '../workspace/voice-uuid-fork.js';
import { nanoid } from 'nanoid';
import { readBaseRev, stampBaseRedesign, stampKeyVoiceId, stampVariantBaseRev } from '../workspace/variant-base-rev.js';
import { STAGING_MAX_AGE_MS } from '../workspace/portable-staging.js';

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
    `"${name}" is linked to a cloned voice — on this character, or a linked one elsewhere in ` +
    `the series — so emotion variants are unavailable — ` +
    `they are only offered for a designed voice. Minting one would re-derive a ` +
    `new performance of a real person's voice under a key their consent record ` +
    `does not cover and revoking consent does not erase. Remove the clone from ` +
    `every linked book to use emotion variants for this character.`
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
export type PersistEmotionVariantOutcome = 'applied' | 'skippedClone' | 'notFound';

export async function persistEmotionVariant(
  bookDir: string,
  characterId: string,
  emotion: Exclude<Emotion, 'neutral'>,
  variantVoiceId: string,
  seriesFilter?: { author: string; series: string },
): Promise<PersistEmotionVariantOutcome> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!cast || !character) return 'notFound';
  /* #4028 — the base the variant LANDED on (`<base>__<emotion>`): only a row
     whose key is still that base takes the slot, so a row a decline moved after
     the design landed is never handed a variant its new key does not have. The
     book-scoped branch checks it too (pass 11, Y4): a variant id naming another
     base is not this row's. */
  const suffix = `__${emotion}`;
  const landedBase = variantVoiceId.endsWith(suffix)
    ? variantVoiceId.slice(0, -suffix.length)
    : qwenStorageKey(character, characterId);

  /* Add/overwrite the emotion slot on a character's qwen override, defaulting
     the base name when the slot is fresh and preserving sibling variants. */
  const addVariant = (c: CastCharacter, baseVoiceId: string, slotName = variantVoiceId): CastCharacter => {
    const map = { ...(c.overrideTtsVoices ?? {}) };
    const qwen = map.qwen ?? { name: baseVoiceId };
    map.qwen = {
      ...qwen,
      name: qwen.name ?? baseVoiceId,
      variants: { ...(qwen.variants ?? {}), [emotion]: { name: slotName } },
    };
    return { ...c, overrideTtsVoices: map };
  };

  if (seriesFilter) {
    /* Linked-cast propagation across the series (matches on the linked
       identity `voiceId ?? id`, the same key applyOverrideToCastFiles uses).
       forEachMatchingCastCharacter takes its own per-book cast lock as it
       walks — a locked leaf (cast-lock.ts rule 1) — so this branch stays
       unlocked and delegating; it must not gain a lock of its own.

       I4 — unlike the book-scoped branch below, `baseVoiceId` here is NOT
       re-derived per target book inside that per-book lock: it is computed
       once, from the id the variant landed on (#4028), and propagated as-is
       into every matching book's locked write, to rows still on that base.
       That is deliberate — the point of this branch is stamping the
       source's key onto the series, not re-deriving each target's own — but
       it does leave a staleness window (a concurrent redesign of the source
       between this read and a given target's write still propagates the OLD
       key). Cross-book propagation staleness is tracked on #2006, not fixed
       here. */
    const baseVoiceId = landedBase;

    /* Fresh, series-wide re-check immediately before the walk — replaces the
       caller's stale pre-GPU snapshot. A hit refuses the WHOLE propagation:
       no book is written. See the qwen-voice spec's "Series-wide check,
       reused, not reimplemented". */
    const stillCloned = await seriesClonedOnRowsVoice(character, seriesFilter);
    if (stillCloned) return 'skippedClone';

    /* Residual-window backstop: the walk still takes nonzero time after the
       scan above passed. Threading the walk's own returned count through
       (rather than discarding it, as an earlier revision did) is what lets
       'applied' and 'notFound' be told apart below. */
    let residualSkip = false;
    const scopedUuid = await separatedUuidOf(character);
    const updated = await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) => {
      /* A separated row's variant lands only on rows holding its uuid (the scan above
         counted only their clones), so a clone on any other row is not a race. */
      if (scopedUuid && c.voiceUuid !== scopedUuid) return c;
      if (characterHasClonedSlot(c)) {
        residualSkip = true;
        return c; // unchanged — this book's own write correctly declined
      }
      /* #3992 — a variant anchored on one base cannot belong to a row with a
         different base (a declined, forked row still shares the voiceId). Compared
         by storage key, so a legacy row (no uuid) and a separated one never trade
         slots either (P10-2): render re-derives `<row's key>__<emotion>`. */
      if (qwenStorageKey(c, c.id) === baseVoiceId) return addVariant(c, baseVoiceId);
      /* #4037 — a mint re-keyed this row after the variant landed on the legacy key. */
      const followed = variantOnMintedKey(c, baseVoiceId, emotion, variantVoiceId);
      return followed ? addVariant(c, qwenStorageKey(c, c.id), followed) : c;
    });
    if (residualSkip) {
      console.warn(
        `[persistEmotionVariant] residual-window skip: a clone appeared on a linked book for ${characterId} between the series-wide scan and this walk reaching it (${updated} linked character(s) still received the variant).`,
      );
    }
    if (updated > 0) return 'applied';
    /* `updated === 0` is ambiguous on its own: it means either "nothing in
       scope matched this character at all" (the pre-existing 'notFound'
       fallthrough the caller documents as a benign empty write) or "every
       match was declined by the residual-window clone check" (a genuine
       refusal that must reach the caller's 409, same as the upfront
       `stillCloned` check above). `residualSkip` disambiguates the two. */
    return residualSkip ? 'skippedClone' : 'notFound';
  }

  /* Book-scoped write — this function carries no other lock, so the read
     above is an early-out optimisation only: a concurrent book-scoped writer
     can land between it and the write below. Re-read and re-decide inside
     the cast lock, including `baseVoiceId` (the default slot name), which
     must come from the FRESH character, not the one captured above. I4 —
     this is the mirror image of the series branch above, which propagates
     the SOURCE's baseVoiceId by design instead of re-deriving it per book;
     see that branch's comment. */
  return withCastLock(bookDir, async () => {
    const fresh = await readJson<CastFile>(castJsonPath(bookDir));
    const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
    if (!fresh || idx === -1) return 'notFound';
    const freshCharacter = fresh.characters[idx];
    if (characterHasClonedSlot(freshCharacter)) return 'skippedClone';
    const baseVoiceId = qwenStorageKey(freshCharacter, characterId);
    /* #4037 — moved since the variant landed: by a mint (the take follows it) or by
       anything else (not this row's). */
    const followed =
      baseVoiceId === landedBase
        ? variantVoiceId
        : variantOnMintedKey(freshCharacter, landedBase, emotion, variantVoiceId);
    if (!followed) return 'notFound';
    fresh.characters[idx] = addVariant(freshCharacter, baseVoiceId, followed);
    await writeJsonAtomic(castJsonPath(bookDir), fresh);
    return 'applied';
  });
}

/* #4037 — a variant landed on the legacy key `landedBase` (`qwen-<voiceId>`), and a
   series or book-scoped mint re-keyed the row to `qwen-<uuid>` before the slot was
   recorded. The take follows the mint: its family is copied to `<new key>__<emotion>`
   (a copy of the base is already there, so the json's `baseRev` still matches it) and
   the new name is returned; null when this row is not a mint's to follow.
   A row is the mint's only while its new key still holds the base the take was made
   on: `qwen-<uuid>.pt` byte-equal to `<landedBase>.pt`. A uuid alone proves nothing,
   since a row also takes one by its own design (kept through a link-prior), a
   redesign of the shared key replaces the base, and "Don't reuse" mints one: the
   copy would overwrite a design the mint never wrote, so those rows keep what they
   have. A library slot's variants hang off the library key. A new-key take that is
   current against its base is never replaced by one that is not. */
function variantOnMintedKey(
  c: CastCharacter,
  landedBase: string,
  emotion: string,
  variantVoiceId: string,
): string | null {
  if (landedBase !== `qwen-${c.voiceId ?? c.id}` || !c.voiceUuid || c.overrideTtsVoices?.qwen?.libraryUuid) return null;
  if (isSeparatedVoiceSync(c.voiceUuid)) return null;
  const newKey = `qwen-${c.voiceUuid}`;
  const dir = dirname(qwenVoicePtPath(landedBase));
  const landedPt = fileSha(join(dir, `${landedBase}.pt`));
  if (landedPt === null || landedPt !== fileSha(join(dir, `${newKey}.pt`))) return null;
  const dest = `${newKey}__${emotion}`;
  const newRev = jsonField(dir, newKey, 'rev');
  const destCurrent = existsSync(join(dir, `${dest}.pt`)) && jsonField(dir, dest, 'baseRev') === newRev;
  if (destCurrent && jsonField(dir, variantVoiceId, 'baseRev') !== newRev) return dest;
  const same = VARIANT_MEMBERS.every((s) => fileSha(join(dir, `${variantVoiceId}${s}`)) === fileSha(join(dir, `${dest}${s}`)));
  if (!same) {
    replaceFamilyMembers(
      VARIANT_MEMBERS.map((s) => ({ src: join(dir, `${variantVoiceId}${s}`), dest: join(dir, `${dest}${s}`) })),
    );
  }
  return existsSync(join(dir, `${dest}.pt`)) ? dest : null;
}

/* A sidecar json's `rev` / `baseRev` (variant-base-rev.ts), read synchronously for a
   decision inside a cast lock's sync transform; undefined when absent or unreadable. */
function jsonField(dir: string, key: string, field: 'rev' | 'baseRev'): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as Record<string, unknown>)[field];
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

/* #3992 — the character vanished (deleted, merged away) between an early read and
   the locked write of its separation. There is no uuid to design under, and
   falling back to the one read before would write the earlier book's
   `qwen-<uuid>.pt`, so the request fails instead. Routes answer 404. */
export class CharacterGoneError extends Error {
  constructor(message = 'Character no longer exists.') {
    super(message);
    this.name = 'CharacterGoneError';
  }
}

/* PR #4007 pass 11, P11-5 (owner decision: discard and retry) — the key each
   in-flight design may land on, by `bookId|characterId`. It starts as the row's
   key when the render begins and moves only with the design's own uuid step and
   with a separation that moves the row (separateVoiceLocked): any other writer
   that changes the row's key (a link made mid-render, a re-analysis) leaves it
   behind, and the landing then discards the render instead of following it onto
   another book's voice. `separated` (#4067) is set when a separation moved the
   watcher, so the landing reports a separation some other writer performed
   mid-render, not only the design's own uuid step. */
type DesignWatcher = { key: string; linkId: string; separated?: boolean };
const designWatchers = new Map<string, DesignWatcher>();
const watchTag = (bookId: string, characterId: string): string => `${bookId}|${characterId}`;

/* PR #4007 pass 11, P11-2 (owner decision: refuse only mid-save) — the voice keys
   whose base family a landing, a promote or a series mint is writing right now
   (`active` writers), and how many writes have ever begun on each, so a
   separation can tell a `.pt` missing mid-save from one nobody designed. One
   small entry per key saved by this process; never pruned, so `begun` is never
   reset under a reader. */
const savingKeys = new Map<string, { active: number; begun: number }>();
export async function whileSaving<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const s = savingKeys.get(key) ?? { active: 0, begun: 0 };
  savingKeys.set(key, s);
  s.active++;
  s.begun++;
  try {
    return await fn();
  } finally {
    s.active--;
  }
}
const savesOf = (key: string): { active: number; begun: number } => ({ ...(savingKeys.get(key) ?? { active: 0, begun: 0 }) });

/* P11-5 — the render was discarded because the row's voice changed under it. */
export class DesignVoiceChangedError extends RetryableForkError {
  constructor() {
    super("This character's voice changed while it was being designed. Design it again.");
    this.name = 'DesignVoiceChangedError';
  }
}

/* #4031 — a `skipIfSlotted` landing found the row already carrying a qwen slot
   (picked while the render was in flight): the render is discarded, not landed. */
export class DesignSlotTakenError extends Error {
  constructor() {
    super('This character was given a voice while it was being designed.');
    this.name = 'DesignSlotTakenError';
  }
}

/* #3992 — the base artifact family of one voice key (no emotion variants). */
function familyPath(kind: 'pt' | 'json' | 'wav', name: string): string {
  return kind === 'pt'
    ? qwenVoicePtPath(name)
    : kind === 'json'
      ? qwenVoiceSidecarPath(name)
      : qwenVoiceWavPath(name);
}

/* #3992 — copy the base artifact family of `oldKey` to `newKey` (never the
   emotion variants). Returns the files written, for cleanup. Only an ABSENT
   source (ENOENT) is skipped (a voice nobody designed yet has nothing to copy);
   any other failure (EBUSY, EPERM, ENOSPC, or the destination already existing)
   removes what was copied so far and rethrows, so the caller never stamps a uuid
   whose `.pt` is missing. The rethrown fs error carries an absolute path: every
   route that reaches it curates it through `requestFailureMessageFs`. */
async function copyBaseFamily(oldKey: string, newKey: string): Promise<string[]> {
  const family: Array<['pt' | 'json' | 'wav', string]> = [
    ['pt', ''],
    ['json', ''],
    ['pt', '__1.7b'],
    ['wav', '__master'],
  ];
  const copied: string[] = [];
  for (const [kind, suffix] of family) {
    const dest = familyPath(kind, `${newKey}${suffix}`);
    try {
      await copyFile(familyPath(kind, `${oldKey}${suffix}`), dest, fsConstants.COPYFILE_EXCL);
      copied.push(dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // source absent
      await removeFiles(copied);
      throw e;
    }
  }
  await stampKeyVoiceId(newKey).catch((e) =>
    console.error('[qwen-voice] could not record the copied key in the voice json', e),
  );
  return copied;
}

const removeFiles = async (files: string[]): Promise<void> => {
  await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => {})));
};

/* #4037 — copy every emotion variant family of the legacy key `oldKey`
   (`<oldKey>__<emotion>.pt|.json|__1.7b.pt|__master.wav`) to `<newKey>__<emotion>.*`,
   for the series mint only (a separation drops its variants on purpose). The
   emotions are the closed VARIANT_EMOTIONS set, so the base family's own
   `__1.7b` / `__master` suffixes are never taken for one. Same contract as
   copyBaseFamily: returns the files written; any failure removes what this call
   copied and rethrows, so the caller never stamps a row whose variants are
   half-copied. */
async function copyVariantFamilies(oldKey: string, newKey: string): Promise<string[]> {
  const dir = dirname(qwenVoicePtPath(oldKey));
  const names = new Set<string>();
  try {
    const present = new Set(await readdir(dir));
    for (const e of VARIANT_EMOTIONS) {
      for (const s of VARIANT_MEMBERS) {
        if (present.has(`${oldKey}__${e}${s}`)) names.add(`${oldKey}__${e}${s}`);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const copied: string[] = [];
  for (const name of names) {
    const dest = join(dir, `${newKey}${name.slice(oldKey.length)}`);
    try {
      await copyFile(join(dir, name), dest, fsConstants.COPYFILE_EXCL);
      copied.push(dest);
      /* a copy keeps its source's mtime on Windows: stamp it now so the startup
         sweep's age guard reads it as the fresh file it is */
      const now = new Date();
      await utimes(dest, now, now);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // removed since the listing
      await removeFiles(copied);
      throw e;
    }
  }
  return copied;
}

/* #4037 — point a stamped row's stored variant names at the new key. The slot's own
   name follows the same rule (#4067's rule for a separation): a name on the legacy
   key becomes `<to>`, and a library slot's name is kept. Every caller re-keys only
   after the base was copied to `<to>`. */
function withRekeyedVariants(c: CastCharacter, from: string, to: string): CastCharacter {
  const slot = c.overrideTtsVoices?.qwen;
  if (!slot) return c;
  const qwen = slot.name === from && !slot.libraryUuid ? { ...slot, name: to } : slot;
  if (!qwen.variants) {
    return qwen === slot ? c : { ...c, overrideTtsVoices: { ...c.overrideTtsVoices, qwen } };
  }
  const variants = Object.fromEntries(
    Object.entries(qwen.variants).map(([e, v]) => [
      e,
      v && v.name.startsWith(`${from}__`) ? { ...v, name: `${to}${v.name.slice(from.length)}` } : v,
    ]),
  );
  return { ...c, overrideTtsVoices: { ...c.overrideTtsVoices, qwen: { ...qwen, variants } } };
}

/* #4037 (PR #4052 review, P1-2 / P2-1 / Q1) — the series mint copies the variant
   families once, up front, but stamps each book later, under that book's cast
   lock; a variant landing on another book of the series (its own locks only) can
   fall in between. So each stamp first makes `qwen-<uuid>__<emotion>` hold what the
   legacy name holds at that moment, for every slot the fresh row names on the
   legacy key. `prints` is what the mint itself wrote at each new-key file (sha256),
   which is the only thing it may overwrite: a new-key family whose files differ
   from it was designed by someone else, and stands. A source member that is absent
   is never a delete (a slot's files outlive it, #4026), so it is skipped and a
   copy is never removed. A landing straddling the copy (#4040's moveStaged renames
   .pt, then .json, then .wav) can leave a mixed family (new .pt beside the old
   .json); accepted: render reads only the .pt and the json's language, and a later
   base redesign retires the copies. Each member is staged next to its destination and renamed into
   place only once the whole family is staged, so a failed copy leaves the earlier
   copy whole. Synchronous: it runs inside forEachMatchingCastCharacter's `mutate`, and
   no other JS interleaves between the check and the copy. Every file it creates
   joins `copied`, for the caller's rollback. The json is copied as is, so the
   variant's `baseRev` (#4040) still names the base it was designed against. */
const VARIANT_MEMBERS = ['.pt', '.json', '__master.wav', '__1.7b.pt'];
/* Bounded synchronous retry of a transient rename failure (an AV / indexer scan, or
   the sidecar holding the destination open on Windows): the same codes and first
   backoffs as renameWithRetry, which is async and cannot run inside the mutate. */
function renameSyncWithRetry(src: string, dest: string): void {
  const delays = RENAME_RETRY_DELAYS_MS.slice(0, 3);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(src, dest);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === delays.length) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
    }
  }
}
const fileSha = (path: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};
function recordMintPrints(prints: Map<string, string | null>, files: string[]): void {
  for (const f of files) prints.set(f, fileSha(f));
}
function refreshVariantCopies(
  c: CastCharacter,
  oldKey: string,
  newKey: string,
  prints: Map<string, string | null>,
  copied: string[],
): void {
  const dir = dirname(qwenVoicePtPath(oldKey));
  for (const v of Object.values(c.overrideTtsVoices?.qwen?.variants ?? {})) {
    const emotion = v?.name.startsWith(`${oldKey}__`) ? v.name.slice(oldKey.length + 2) : undefined;
    if (!emotion || !(VARIANT_EMOTIONS as readonly string[]).includes(emotion)) continue;
    const members = VARIANT_MEMBERS.map((s) => ({
      src: join(dir, `${oldKey}__${emotion}${s}`),
      dest: join(dir, `${newKey}__${emotion}${s}`),
    }));
    if (members.some((m) => fileSha(m.dest) !== (prints.get(m.dest) ?? null))) continue; // not the mint's
    const changed = members.some((m) => {
      const src = fileSha(m.src);
      return src !== null && src !== (prints.get(m.dest) ?? null);
    });
    if (!changed) continue;
    for (const r of replaceFamilyMembers(members)) {
      if (!prints.has(r.dest) || prints.get(r.dest) === null) copied.push(r.dest);
      prints.set(r.dest, r.sha);
    }
  }
}
/* Replace each `dest` with its `src`, a member whose src is absent skipped. Each is
   staged (copy, stamped fresh) next to its destination, and each destination it
   replaces is backed up, before any rename; if a rename still fails after its
   retries, the members already replaced are put back from their backups (or removed,
   when there was none) and the error rethrown, so a failed refresh never leaves a mix
   of old and new members for a book that already names the copy. A backup whose
   restore failed is kept: it is then the only copy of the old member. Returns what
   was written, with each file's sha256. */
function replaceFamilyMembers(
  members: Array<{ src: string; dest: string }>,
): Array<{ dest: string; sha: string | null }> {
  const staged: Array<{ tmp: string; dest: string; bak: string | null; sha: string | null }> = [];
  const keepBak = new Set<string>();
  try {
    for (const m of members) {
      if (!existsSync(m.src)) continue;
      const tmp = `${m.dest}.mint-${nanoid(8)}.tmp`;
      const bak = existsSync(m.dest) ? `${m.dest}.mint-${nanoid(8)}.tmp` : null;
      staged.push({ tmp, dest: m.dest, bak, sha: null });
      copyFileSync(m.src, tmp, fsConstants.COPYFILE_EXCL);
      utimesSync(tmp, new Date(), new Date()); // a copy keeps its source's mtime on Windows
      staged[staged.length - 1].sha = fileSha(tmp);
      if (bak) {
        copyFileSync(m.dest, bak, fsConstants.COPYFILE_EXCL);
        utimesSync(bak, new Date(), new Date());
      }
    }
    const replaced: typeof staged = [];
    try {
      for (const s of staged) {
        renameSyncWithRetry(s.tmp, s.dest);
        replaced.push(s);
      }
    } catch (err) {
      for (const { dest, bak } of replaced.reverse()) {
        try {
          if (bak) renameSyncWithRetry(bak, dest);
          else rmSync(dest, { force: true });
        } catch {
          if (bak) keepBak.add(bak);
        }
      }
      throw err;
    }
    return staged.map((s) => ({ dest: s.dest, sha: s.sha }));
  } finally {
    for (const { tmp, bak } of staged) {
      rmSync(tmp, { force: true });
      if (bak && !keepBak.has(bak)) rmSync(bak, { force: true });
    }
  }
}

/* #3992 — stamp a new uuid onto one row and drop its qwen `variants` map in the
   same write. Render never reads a stored variant name: `pickEmotionVariantVoice`
   re-derives `qwen-<uuid>__<emotion>` from the row's uuid, and the copies are the
   base family only, so a surviving slot would ask for a `.pt` that does not exist
   (`voice_not_designed` at synth). Same reason and shape as voice-library.ts's
   assign route. The earlier book's variant files and its own slots are
   untouched. #4067 — the slot's stored `name` follows the uuid to `qwen-<uuid>`
   (the key the base family was copied to), so a reader of the name, not the uuid,
   never gets the earlier book's voice. A library-assigned slot's key is its
   `libraryUuid`, not this row's uuid, so its name is left alone. */
function withForkedUuid(c: CastCharacter, newUuid: string): CastCharacter {
  const qwen = c.overrideTtsVoices?.qwen;
  const renamed = qwen?.name && !qwen.libraryUuid;
  return {
    ...c,
    voiceUuid: newUuid,
    ...(qwen && (qwen.variants || renamed)
      ? {
          overrideTtsVoices: {
            ...c.overrideTtsVoices,
            qwen: { ...qwen, ...(renamed ? { name: `qwen-${newUuid}` } : {}), variants: undefined },
          },
        }
      : {}),
  };
}

type MarkedCharacter = CastCharacter & {
  matchedFrom?: { bookId?: string } | null;
  voiceState?: string;
  declinedVoiceFrom?: string[];
  declinedVoiceUuids?: string[];
};

/* #3992 — the "Don't reuse" marker: `declinedVoiceFrom` names the book, and
   `declinedVoiceUuids` the voice the row held when it was separated from it (the
   linker, the merge and voice-match skip both). The cleared link mirrors the
   reducer's declineMatch: `matchedFrom` goes only when it is the link being
   declined, and a lock/tune is never dropped. */
function withDeclineMark(row: MarkedCharacter, fromBookId: string | undefined, leftUuid: string | undefined): MarkedCharacter {
  const next: MarkedCharacter = { ...row };
  if (fromBookId && !(row.declinedVoiceFrom ?? []).includes(fromBookId)) {
    next.declinedVoiceFrom = [...(row.declinedVoiceFrom ?? []), fromBookId];
  }
  if (leftUuid && !(row.declinedVoiceUuids ?? []).includes(leftUuid)) {
    next.declinedVoiceUuids = [...(row.declinedVoiceUuids ?? []), leftUuid];
  }
  if (fromBookId && row.matchedFrom?.bookId === fromBookId) {
    delete next.matchedFrom;
    if (row.voiceState !== 'locked' && row.voiceState !== 'tuned') next.voiceState = 'generated';
  }
  return next;
}

/* #3992 — the books a separation must hold: the row's own and those of its
   followers, the whole chain that leads down to it (they move with it). Lock-free and read-only; the locked step re-scans
   and fails when the set it finds is not covered. Throws CharacterGoneError for a
   row that is not there. `fromBookId` is the book a decline declines (never a
   follower's book). F1 — a decline also holds the books of the rows an earlier
   decline left behind (`stranded`), which a repeat decline carries. */
export async function separationPlan(
  bookDir: string,
  characterId: string,
  fromBookId?: string,
): Promise<{ bookIds: string[]; followers: LinkFollower[]; stranded: LinkFollower[] }> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const x = cast?.characters?.find((c) => c.id === characterId) as MarkedCharacter | undefined;
  if (!x) throw new CharacterGoneError();
  const xBookId = await readBookId(bookDir);
  if (!xBookId) throw new Error('Cannot separate a voice in a book that has no bookId.');
  const scan = await scanVoiceHolders(bookDir, x, voiceHeldBy(x), fromBookId);
  const stranded = fromBookId ? (scan.stranded ?? []) : [];
  return {
    bookIds: [...new Set([xBookId, ...scan.followers.map((f) => f.bookId), ...stranded.map((f) => f.bookId)])],
    followers: scan.followers,
    stranded,
  };
}

/* The books an `unconfirmed` separation holds: the row's own, alone (it moves no
   other book). Throws CharacterGoneError for a row that is not there. */
async function ownBookPlan(
  bookDir: string,
  characterId: string,
): Promise<{ bookIds: string[]; followers: LinkFollower[]; stranded: LinkFollower[] }> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  if (!cast?.characters?.some((c) => c.id === characterId)) throw new CharacterGoneError();
  const bookId = await readBookId(bookDir);
  if (!bookId) throw new Error('Cannot separate a voice in a book that has no bookId.');
  return { bookIds: [bookId], followers: [], stranded: [] };
}

/* Review pass 3 (C) — does an unconfirmed design isolate this row? Whenever another
   book's row holds its key (a follower included), and also when a book that could
   not be read may hold it (an unreadable holder is not an absent one) unless the row's
   uuid is already known to be its own, which keeps a second design from isolating
   again and dropping the takes the first one made. Review pass 4 (🟠1): "known to be its
   own" means a record that names THIS book at its CURRENT edit epoch (an unconfirmed
   mint or isolation, separated-voices.ts `OwnStamp`); a "Don't reuse" record, or one
   another book or an earlier generation (Re-parse, Start fresh) wrote, is not proof.
   Never a refusal: the isolation writes only this book. */
async function mustIsolateUnconfirmed(row: MarkedCharacter, scan: VoiceScan, bookDir: string): Promise<boolean> {
  if (scan.heldElsewhere || scan.followers.length > 0) return true;
  if (!scan.unreadableMayHold) return false;
  if (!row.voiceUuid) return true;
  const stamp = await readBookOwnStamp(bookDir);
  return !(stamp && (await isOwnSeparatedVoice(row.voiceUuid, stamp)));
}

/* Writes one book's cast.json. Each caller builds it INSIDE its own withCastLocks
   callback, so every cast write of a separation sits under the cast locks the
   caller holds (cast-lock.guard.test.ts reads that nesting from the text). */
export type CastWriter = (dir: string, cast: CastFile) => Promise<void>;

export interface SeparationResult {
  /** The row's voiceUuid after the step. */
  voiceUuid: string | undefined;
  /** The row (and its followers) moved to a fresh uuid. */
  separated: boolean;
  /** The row as it now stands on disk. */
  row: MarkedCharacter;
  /** Other rows in the row's own book that moved with it (same voice key). */
  movedSameBook: string[];
}

/* F1 — move the rows an earlier decline left behind (`stranded`, each book locked
   by the caller) onto X's own voice, as a decline moves its followers
   (withForkedUuid): the rows of each book on the voice a stranded row holds, with
   its link id. Returns each book written with the cast it had, for a rollback; a
   failure puts back what was written and rethrows. */
type CarriedBook = { dir: string; before: CastFile; writeCast: CastWriter };
async function carryStranded(stranded: LinkFollower[], x: MarkedCharacter, writeCast: CastWriter): Promise<CarriedBook[]> {
  const written: CarriedBook[] = [];
  try {
    for (const dir of new Set(stranded.map((f) => resolve(f.dir)))) {
      const cast = await readJson<CastFile>(castJsonPath(dir));
      if (!cast?.characters) continue;
      const ids = new Set(stranded.filter((f) => resolve(f.dir) === dir).map((f) => f.characterId));
      const rows = cast.characters.filter((c) => ids.has(c.id));
      const onSameVoice = (c: CastCharacter) =>
        rows.some((r) => voiceHeldBy(r)(c) && (r.voiceId ?? r.id) === (c.voiceId ?? c.id));
      let changed = false;
      const characters = cast.characters.map((c) => {
        if (!onSameVoice(c)) return c;
        changed = true;
        return withForkedUuid(c, x.voiceUuid as string);
      });
      if (!changed) continue;
      await writeCast(dir, { ...cast, characters });
      written.push({ dir, before: cast, writeCast });
    }
  } catch (e) {
    await rollBack(written);
    throw e;
  }
  console.log(`[qwen-voice] ${x.id}: carried ${written.length} book(s) an earlier decline left behind onto qwen-${x.voiceUuid}`);
  return written;
}

async function rollBack(written: CarriedBook[]): Promise<void> {
  for (const w of [...written].reverse()) {
    try {
      await w.writeCast(w.dir, w.before);
    } catch (e) {
      console.error('[qwen-voice] could not roll a carried row back', e);
    }
  }
}

/* #3992 — the ONE separation step, shared by the decline route and a design of a
   row declined before the route did this. The caller holds the row's book's design
   lock, then `withBookOps` over `separationPlan`'s books (X's handle resolving to
   `bookDir`), then `withCastLocks` over every locked folder (CLAUDE.md's global
   order: design -> book-op -> cast), and passes `writeCast` built inside that
   `withCastLocks` callback: every cast write goes through it.

   Re-reads and re-decides on a fresh read inside the locks: `decline` set applies
   mustSeparateOnDecline and records the marker; unset applies
   mustSeparateOnDesign and records nothing but the voice it left. Separating mints
   U', copies the base family of the row's current key (`qwen-<uuid>`, or the
   legacy `qwen-<voiceId ?? id>`) to `qwen-<U'>` with COPYFILE_EXCL, and stamps U'
   (dropping `variants`) onto the row, the same-book rows on its key, and every
   follower's rows on that key; a follower set that differs from `planned` fails
   with a retry sentence before anything is copied. Any failure rolls every written book back and
   removes the copies, so the step lands whole or not at all; a follower whose
   rollback also failed keeps the copies it now points at.
   F1 (owner decision: refuse while unreadable) — a decline that must separate
   while a book that may be in the row's chain cannot be read (scanVoiceHolders'
   `chainUnreadable`) fails with the retry sentence before anything is written, so
   no follower is ever left on the voice the row leaves. A repeat decline carries
   the rows an earlier decline left behind (`plannedStranded`, re-checked here)
   onto the row's own voice. */
export async function separateVoiceLocked(
  bookDir: string,
  characterId: string,
  lockedDirs: string[],
  planned: LinkFollower[],
  writeCast: CastWriter,
  decline?: { fromBookId: string; plannedStranded?: LinkFollower[] },
  /** F8 (review pass 1) — a design in a book whose cast is not confirmed: separate
      the row whenever another book's row holds its key, and record no declined uuid. */
  unconfirmed?: boolean,
  /** Review pass 2 — with `unconfirmed`, a preview id staged under the old key that
      is carried to the new key by the caller instead of being dropped. */
  keepPreviewId?: string,
): Promise<SeparationResult> {
  const fresh = await readJson<CastFile>(castJsonPath(bookDir));
  const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
  if (!fresh || idx === -1) throw new CharacterGoneError();
  const x = fresh.characters[idx] as MarkedCharacter;
  const holds = voiceHeldBy(x);
  const scan = await scanVoiceHolders(bookDir, x, holds, decline?.fromBookId);
  /* Review pass 2 — `unconfirmed` (F8) moves this book's rows only and never writes
     another book: whoever else holds the key (a follower included) is a reason to
     separate, never a row to move, and no book in the chain needs reading. */
  const followers = unconfirmed ? [] : scan.followers;
  const separate = decline
    ? mustSeparateOnDecline(x, scan, decline.fromBookId)
    : unconfirmed
      ? await mustIsolateUnconfirmed(x, scan, bookDir)
      : mustSeparateOnDesign(x, scan);

  const locked = new Set(lockedDirs.map((d) => resolve(d)));
  const chainKey = (fs: LinkFollower[]) => fs.map((f) => `${resolve(f.dir)}|${f.characterId}`).sort().join('\n');
  if (!separate) {
    /* F1 — a repeat decline: the rows an earlier decline left behind (it went
       through with a chain member unreadable) move onto the row's own voice now,
       under the same locks, before the marker. A set that differs from the plan's
       is not the one the locks were taken for. */
    const stranded = decline && x.voiceUuid ? (scan.stranded ?? []) : [];
    if (decline && x.voiceUuid) {
      /* Review pass 2 (owner decision: refuse while unreadable) — a repeat decline
         refuses too, so no row of an unreadable book is left behind. */
      if (scan.chainUnreadable) {
        throw new RetryableForkError('A book in this series could not be read while the voice was being separated; try again.');
      }
      if (chainKey(stranded) !== chainKey(decline.plannedStranded ?? []) || stranded.some((f) => !locked.has(resolve(f.dir)))) {
        throw new RetryableForkError('A book in this series changed while the voice was being separated; try again.');
      }
    }
    const carried = stranded.length ? await carryStranded(stranded, x, writeCast) : [];
    const marked = withDeclineMark(x, decline?.fromBookId, undefined);
    /* PR #4007 pass 13 — a decline that needed no separation leaves the row on a
       uuid no other book's row holds but its followers: the decliner's own voice,
       recorded like a separation's (separated-voices.ts) before the marker lands. A
       failed write takes back only a record this step made. PR #4109 review pass 3: a
       uuid already recorded as an OwnStamp (a design before Confirm) gets the decline
       flag, so the rebaseline keeps it apart as a "Don't reuse" voice. */
    const undoRecord = decline && x.voiceUuid ? await markDeclineSeparatedVoice(x.voiceUuid) : undefined;
    if (JSON.stringify(marked) !== JSON.stringify(x)) {
      fresh.characters[idx] = marked;
      try {
        await writeCast(bookDir, fresh);
      } catch (e) {
        if (undoRecord) await undoRecord();
        await rollBack(carried);
        throw e;
      }
    }
    return { voiceUuid: x.voiceUuid ?? undefined, separated: false, row: marked, movedSameBook: [] };
  }

  /* A book the plan found in the chain, locked on that basis, that cannot be read
     now is NOT skipped: skipping it would leave a row linked into the chain on the
     old voice while X moves. A chain that differs in any way from the plan's (a
     link that landed or left after the plan, a row that joined or left the voice)
     is not the set the locks were taken for. Fail; nothing has been written.
     F1 — neither is a book that could not be read from the start, when it may be in
     the chain (any book of X's series but a declined one): every separation, a
     decline's or a design's (owner decision, review pass 1), refuses. */
  const unreadable = new Set(scan.unreadableDirs);
  if (!unconfirmed && (planned.some((f) => unreadable.has(resolve(f.dir))) || scan.chainUnreadable)) {
    throw new RetryableForkError('A book in this series could not be read while the voice was being separated; try again.');
  }
  if (chainKey(followers) !== chainKey(planned) || followers.some((f) => !locked.has(resolve(f.dir)))) {
    throw new RetryableForkError('A book in this series changed while the voice was being separated; try again.');
  }

  const linkId = x.voiceId ?? x.id;
  const oldUuid = x.voiceUuid ?? undefined;
  const newUuid = nanoid();
  const oldKey = oldUuid ? `qwen-${oldUuid}` : `qwen-${linkId}`;
  const savesBefore = savesOf(oldKey);
  /* PR #4007 pass 13 — U' is recorded as separated before any row moves onto it
     (separated-voices.ts): a first design by any row on it is never shared. Every
     failure below that leaves no row on U' takes the record back. An unconfirmed
     isolation names its book and generation (review pass 4, 🟠1); a decline's record
     names nobody. PR #4109 review pass 4 (🟠1): an isolation of a decline-marked row
     is a "Don't reuse" voice too, so its stamp carries the decline flag. */
  await recordSeparatedVoice(
    newUuid,
    unconfirmed ? declinedIf(hasDeclineMarker(x), (await readBookOwnStamp(bookDir)) ?? UNNAMED_OWN_STAMP) : undefined,
  );
  let copied: string[];
  try {
    copied = await copyBaseFamily(oldKey, `qwen-${newUuid}`);
  } catch (e) {
    await forgetSeparatedVoice(newUuid);
    throw e;
  }
  /* PR #4007 pass 11, P11-2 (owner decision: refuse only mid-save) — a missing
     source `.pt` is a voice nobody designed (or one deleted by hand), and the row
     moves onto the empty key like any other, UNLESS a landing, promote or mint of
     that key was saving it across the copy (a first save: absent until its
     rename — a redesign renames over the old file, so its source is whole): then
     the step fails, retryably, before anything is written. */
  if (!copied.includes(qwenVoicePtPath(`qwen-${newUuid}`))) {
    const savesAfter = savesOf(oldKey);
    if (savesBefore.active > 0 || savesAfter.active > 0 || savesAfter.begun !== savesBefore.begun) {
      await removeFiles(copied);
      await forgetSeparatedVoice(newUuid);
      throw new RetryableForkError("This character's voice is being saved right now; try again.");
    }
  }
  /* Every row moved, by book: their previews staged under the old key go (#4028). */
  const moved: Array<{ bookId: string; characterId: string }> = [];
  const movedSameBook: string[] = [];

  /* Every book written so far, with the cast it had before: a failure at any later
     write puts these back, so a follower is never left on the new uuid while the
     row it links to is still on the old one. */
  const written: Array<{ dir: string; before: CastFile }> = [];
  try {
    for (const dir of new Set(followers.map((f) => resolve(f.dir)))) {
      const cast = await readJson<CastFile>(castJsonPath(dir));
      if (!cast?.characters) continue;
      const followerIds = new Set(followers.filter((f) => resolve(f.dir) === dir).map((f) => f.characterId));
      const linkIds = new Set(cast.characters.filter((c) => followerIds.has(c.id)).map((c) => c.voiceId ?? c.id));
      let changed = false;
      const followerBookId = followers.find((f) => resolve(f.dir) === dir)!.bookId;
      const characters = cast.characters.map((c) => {
        if (!holds(c) || !linkIds.has(c.voiceId ?? c.id)) return c;
        changed = true;
        moved.push({ bookId: followerBookId, characterId: c.id });
        return withForkedUuid(c, newUuid);
      });
      if (!changed) continue;
      await writeCast(dir, { ...cast, characters });
      written.push({ dir, before: cast });
    }

    const ownBookId = await readBookId(bookDir);
    for (let i = 0; i < fresh.characters.length; i++) {
      const c = fresh.characters[i];
      if ((c.voiceId ?? c.id) !== linkId || !holds(c)) continue;
      fresh.characters[i] = withForkedUuid(c, newUuid);
      if (ownBookId) moved.push({ bookId: ownBookId, characterId: c.id });
      if (c.id !== characterId) movedSameBook.push(c.id);
    }
    fresh.characters[idx] = withDeclineMark(
      fresh.characters[idx] as MarkedCharacter,
      decline?.fromBookId,
      unconfirmed ? undefined : oldUuid,
    );
    await writeCast(bookDir, fresh);
  } catch (e) {
    /* Put every follower already written back (still inside the locks, so nothing
       else has touched them). Restored: the copies are strays, remove them. A
       restore that fails leaves that follower on the copy, so the copies stay, and
       the original failure is the one reported. */
    let restored = true;
    for (const w of written.reverse()) {
      try {
        await writeCast(w.dir, w.before);
      } catch (restoreErr) {
        restored = false;
        console.error('[qwen-voice] separation: could not roll a follower back', restoreErr);
      }
    }
    if (restored) {
      await removeFiles(copied);
      await forgetSeparatedVoice(newUuid);
    }
    throw e;
  }
  /* P11-5 — a design in flight on a moved row follows it to the new voice. */
  for (const m of moved) {
    const w = designWatchers.get(watchTag(m.bookId, m.characterId));
    if (w?.key === oldKey) {
      w.key = `qwen-${newUuid}`;
      w.separated = true;
    }
  }
  await dropStagedPreviews(oldKey, moved, keepPreviewId);
  console.log(
    `[qwen-voice] ${characterId}: separated from ${oldKey} onto qwen-${newUuid}` +
      ` (${followers.length} follower(s) moved)`,
  );
  return { voiceUuid: newUuid, separated: true, row: fresh.characters[idx] as MarkedCharacter, movedSameBook };
}

/* #3992 — a design of a row declined before the decline route separated it (see
   mustSeparateOnDesign): run the route's separation once, under the same locks,
   then design the row's own key. Caller holds the design lock. Returns the row's
   uuid after the step, and whether the locked re-decision did separate it (#4067). */
async function separateDeclinedVoiceForDesign(
  bookDir: string,
  characterId: string,
  unconfirmed = false,
  keepPreviewId?: string,
): Promise<UuidStep> {
  const plan = unconfirmed ? await ownBookPlan(bookDir, characterId) : await separationPlan(bookDir, characterId);
  const out = await withBookOps(plan.bookIds, (books) => {
    const own = books.find((b) => b.bookId === plan.bookIds[0]);
    if (!own || resolve(own.bookDir) !== resolve(bookDir)) {
      throw new RetryableForkError('A book in this series changed while the voice was being separated; try again.');
    }
    return withCastLocks(
      books.map((b) => b.bookDir),
      () =>
        separateVoiceLocked(
          bookDir,
          characterId,
          books.map((b) => b.bookDir),
          plan.followers,
          (dir, cast) => writeJsonAtomic(castJsonPath(dir), cast),
          undefined,
          unconfirmed,
          keepPreviewId,
        ),
    );
  });
  if (out === BOOK_GONE) {
    throw new RetryableForkError('A book in this series was removed while the voice was being separated; try again.');
  }
  return { uuid: out.voiceUuid, separated: out.separated };
}

/* F8 (owner decision: "not until confirmed"; review passes 1-2) — in a book whose
   cast is not confirmed, a design (base or emotion) never writes a key another
   book's row uses: the analysis-time linker stamps an earlier book's uuid onto a
   freshly analysed row, and that match may be wrong. Such a row (any other book's
   row on its key, a follower included) moves onto a uuid of its own first, with a
   copy of its voice's base family (the same step and locks as a declined row's
   design separation, narrowed to this book): only this book's rows move and no other
   book is written. The caller holds the design lock. `keepPreviewId` is a preview
   the caller carries to the new key. */
async function isolateUnconfirmedRow(bookDir: string, characterId: string, keepPreviewId?: string): Promise<UuidStep> {
  const row = (await readJson<CastFile>(castJsonPath(bookDir)))?.characters?.find((c) => c.id === characterId);
  if (!row) return { uuid: undefined, separated: false };
  const scan = await scanVoiceHolders(bookDir, row, voiceHeldBy(row));
  if (!(await mustIsolateUnconfirmed(row as MarkedCharacter, scan, bookDir))) return { uuid: row.voiceUuid ?? undefined, separated: false };
  return separateDeclinedVoiceForDesign(bookDir, characterId, true, keepPreviewId);
}

/* Review pass 2 — Keep (promote) in an unconfirmed book: a preview moves nothing, so
   the row is isolated here, and the preview it staged under the old key goes with it
   to the new one, whose id it returns (the promote then expects that id, not the
   one the design answered). Only for a preview this row staged (anything else
   promote answers itself). The caller holds the design lock.
   Review pass 3: (D) a row with no uuid that nothing isolated is given one here
   (a book-scoped mint, recorded as separated), because a preview mints none; (F) a
   body the promote would refuse isolates nothing, and the row's own stale preview id
   (its key moved since, e.g. an earlier Keep isolated it and then failed) is carried
   to the key it is on now, so a retry lands. */
async function isolateForKeep(
  bookDir: string,
  bookId: string,
  characterId: string,
  body: { previewVoiceId: string; sampleVoiceId: unknown; modelKey: unknown },
): Promise<string | undefined> {
  if (await bookCastConfirmedOrRetry(bookDir)) return undefined; // the common case reads no cast.json
  if (typeof body.sampleVoiceId !== 'string' || !body.sampleVoiceId.trim() || !isTtsModelKey(body.modelKey)) return undefined;
  const readRow = async () => (await readJson<CastFile>(castJsonPath(bookDir)))?.characters?.find((c) => c.id === characterId);
  const row = await readRow();
  if (!row) return undefined;
  const staged = body.previewVoiceId;
  const expected = previewVoiceIdFor(qwenStorageKey(row, characterId), bookId, characterId);
  if (staged !== expected) {
    if (!(await keysAreIsolationCopies(bookDir, staged, row, bookId, characterId))) return undefined;
    /* Review pass 4 (🟠3) -- a retry after an earlier Keep carried the preview and then
       failed: it already sits under the name the row expects now. */
    if (!(await exists(qwenVoicePtPath(staged)))) return (await exists(qwenVoicePtPath(expected))) ? expected : undefined;
  }
  if (!(await exists(qwenVoicePtPath(staged)))) return undefined;
  await isolateUnconfirmedRow(bookDir, characterId, staged);
  let after = await readRow();
  if (after && !after.voiceUuid) {
    await mintBookVoiceUuid(bookDir, characterId, true);
    after = await readRow();
  }
  if (!after) return undefined;
  const next = previewVoiceIdFor(qwenStorageKey(after, characterId), bookId, characterId);
  if (next === staged) return undefined;
  await renameWithRetry(qwenVoicePtPath(staged), qwenVoicePtPath(next));
  await renameWithRetry(qwenVoiceSidecarPath(staged), qwenVoiceSidecarPath(next)).catch(() => {});
  await renameWithRetry(qwenVoiceWavPath(`${staged}__master`), qwenVoiceWavPath(`${next}__master`)).catch(() => {});
  return next;
}

/* Review pass 4 (🟠3) -- Keep carries a preview the row staged under a key it has left
   only when the row reached its current key by an isolation FROM that key: a BASE
   preview (an emotion take is not the base, and promoting it would write the take over
   the base), whose key's base `.pt` is byte-equal to the current key's (an isolation
   copies the base family; a re-point to another row's voice, or any other move, leaves
   a different file, or none). Anything else answers promote's own 400. */
async function keysAreIsolationCopies(bookDir: string, staged: string, row: CastCharacter, bookId: string, characterId: string): Promise<boolean> {
  if (!isOwnStalePreview(staged, bookId, characterId)) return false;
  const stagedKey = staged.slice(0, staged.length - `${PREVIEW_SUFFIX}-${previewTag(bookId, characterId)}`.length);
  if (VARIANT_EMOTIONS.some((e) => stagedKey.endsWith(`__${e}`))) return false;
  const currentKey = qwenStorageKey(row, characterId);
  if (stagedKey === currentKey) return false;
  const readBase = (key: string) =>
    readFile(qwenVoicePtPath(key)).catch((e: NodeJS.ErrnoException) => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
  try {
    const [was, now] = await Promise.all([readBase(stagedKey), readBase(currentKey)]);
    if (was && now) return was.equals(now);
    if (was || now) return false;
    /* Review pass 5 -- a row nobody designed has no base file at either key (the common
       first design): the move is proven by the book's own separation record for the
       row's uuid, which an isolation or a book-scoped mint writes. */
    const stamp = await readBookOwnStamp(bookDir);
    return !!(row.voiceUuid && stamp && (await isOwnSeparatedVoice(row.voiceUuid, stamp)));
  } catch {
    return false;
  }
}

/* A state.json that cannot be read is not "unconfirmed" (review pass 1): the design
   refuses and writes nothing. */
async function bookCastConfirmedOrRetry(bookDir: string): Promise<boolean> {
  try {
    return await readBookCastConfirmed(bookDir);
  } catch (err) {
    console.error('[qwen-voice] book state unreadable at the design uuid step', err);
    throw new RetryableForkError('This book could not be read right now; try again.');
  }
}

/* The uuid step's answer: the row's uuid, and whether the step separated the row. */
interface UuidStep {
  uuid: string | undefined;
  separated: boolean;
}

/* #3992 — is this row one a design must separate first? Only a row carrying the
   decline marker is ever looked at; the decision itself is mustSeparateOnDesign. */
async function needsDesignSeparation(bookDir: string, character: MarkedCharacter): Promise<boolean> {
  if (!character.declinedVoiceFrom?.length) return false;
  return mustSeparateOnDesign(character, await scanVoiceHolders(bookDir, character, voiceHeldBy(character)));
}

/* #3992 — the variant path's uuid: the row's current one, NEVER minted (#1057: a
   fresh uuid would move the base's storage key while its embedding stays at the
   old one). The one exception is a row declined before the decline route
   separated it, which is separated first exactly like a base design (its base
   family is copied, so nothing is orphaned). The caller holds the design lock
   (designQwenVoiceForCharacter). */
async function forkDeclinedVoiceUuidIfShared(bookDir: string, characterId: string): Promise<UuidStep> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!character) return { uuid: undefined, separated: false };
  if (await needsDesignSeparation(bookDir, character)) return separateDeclinedVoiceForDesign(bookDir, characterId);
  return { uuid: character.voiceUuid ?? undefined, separated: false };
}

/* #3992 — check the uuid a design is about to run under, for a character the
   caller has JUST read from cast.json. A BASE design ensures (mints) one; a VARIANT
   never mints (#1057). An `undefined` answer for a character that is known to
   exist means it vanished, or lost its uuid, since that read, and the caller's
   fallback (`voiceUuid ?? character.voiceUuid`) would be the uuid it held before a
   separation: the design would overwrite the earlier book's `.pt`. So it throws
   CharacterGoneError instead. A variant on a row that never had a uuid
   legitimately has none. */
export function requireDesignVoiceUuid(
  character: CastCharacter,
  emotion: boolean,
  uuid: string | undefined,
): string | undefined {
  if (!uuid && (!emotion || character.voiceUuid)) throw new CharacterGoneError();
  return uuid;
}

/* PR #4007 pass 11 — stamp `uuid` onto the designing row under its book's cast
   lock (re-read inside it); with `sameBookLinkId`, also onto the same book's
   uuid-less rows on that link id. A row that gained a uuid meanwhile keeps it,
   and a row that is gone answers undefined. */
async function stampOwnRow(
  bookDir: string,
  characterId: string,
  uuid: string,
  sameBookLinkId?: string,
  rekey?: { from: string; to: string; prints: Map<string, string | null>; copied: string[] },
): Promise<string | undefined> {
  return withCastLock(bookDir, async () => {
    const fresh = await readJson<CastFile>(castJsonPath(bookDir));
    const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
    if (!fresh || idx === -1) return undefined;
    const row = fresh.characters[idx];
    if (row.voiceUuid) return row.voiceUuid;
    for (let i = 0; i < fresh.characters.length; i++) {
      const c = fresh.characters[i];
      if (c.voiceUuid) continue;
      if (i === idx || (sameBookLinkId !== undefined && (c.voiceId ?? c.id) === sameBookLinkId)) {
        const stamped = { ...c, voiceUuid: uuid };
        if (rekey) refreshVariantCopies(c, rekey.from, rekey.to, rekey.prints, rekey.copied);
        fresh.characters[i] = rekey ? withRekeyedVariants(stamped, rekey.from, rekey.to) : stamped;
      }
    }
    await writeJsonAtomic(castJsonPath(bookDir), fresh);
    return uuid;
  });
}

/* srv-43 — ensure a character has an immutable voiceUuid BEFORE its bespoke
   voice is designed (the .pt is named from qwenStorageKey, which reads the
   uuid). Idempotent for a live character: returns the existing uuid untouched.
   The caller holds the per-book design lock (designQwenVoiceForCharacter runs
   this inside its one span) so two concurrent designs of one character can't
   mint two uuids. Stamps the SAME uuid onto every linked-cast
   sibling (matching voiceId ?? id) so a series-shared voice keeps one identity
   — series-scoped when seriesFilter is given (mirrors persistEmotionVariant;
   since pass 11 only after copying the legacy key's designed base family to the
   new key, and only the designing row when there is nothing to copy: then the
   landing shares the design with the linked rows when it writes the key's first
   file, shareFirstDesign), else book-scoped. Returns
   undefined for an unknown character.

   #3992: no design decides anything about a shared voice. "Don't reuse" already
   moved a declining row onto a voice of its own (cast-decline-voice-link.ts), so
   a design writes the row's own key. The one exception is a row declined before
   the route did that, still on the voice it declined: it is separated first,
   once, with the route's own step (separateDeclinedVoiceForDesign). */
export async function ensureCharacterVoiceUuid(
  bookDir: string,
  characterId: string,
  seriesFilter?: { author: string; series: string },
): Promise<string | undefined> {
  return (await ensureCharacterVoiceUuidStep(bookDir, characterId, seriesFilter)).uuid;
}

/* #4067 — ensureCharacterVoiceUuid, also saying whether the step separated the row
   (a separation renames its qwen slot and drops its variants, which the design
   events must tell a client: a first mint on a row with no uuid looks the same by
   the uuid alone). */
async function ensureCharacterVoiceUuidStep(
  bookDir: string,
  characterId: string,
  seriesFilter?: { author: string; series: string },
  /** Review pass 3 (C) — a mint in an unconfirmed book is recorded as separated. */
  unconfirmed?: boolean,
): Promise<UuidStep> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!cast || !character) return { uuid: undefined, separated: false };
  if (await needsDesignSeparation(bookDir, character)) return separateDeclinedVoiceForDesign(bookDir, characterId);
  return { uuid: await readOrMintVoiceUuid(bookDir, characterId, character, seriesFilter, unconfirmed), separated: false };
}

/* #4072 (owner decision: the second mint adopts the first one's uuid) — the series
   mints in flight, by series and link id, each to the uuid it stamps on its row.
   The design lock is per book, so two books of one series can mint the same
   uuid-less link at once ("Design full cast" on two books); each minting its own
   uuid let their walks race and split the link across two voices. */
const seriesMints = new Map<string, Promise<string | undefined>>();
const seriesMintKey = (series: { author: string; series: string }, linkId: string): string =>
  JSON.stringify([series.author, series.series, linkId]);

async function readOrMintVoiceUuid(
  bookDir: string,
  characterId: string,
  character: CastCharacter,
  seriesFilter?: { author: string; series: string },
  unconfirmed?: boolean,
): Promise<string | undefined> {
  if (character.voiceUuid) return character.voiceUuid;

  if (seriesFilter) {
    const linkId = character.voiceId ?? character.id;
    const key = seriesMintKey(seriesFilter, linkId);
    /* #4072 — a mint of this link already in flight: wait for it and take its uuid
       onto this row (its walk has usually stamped the row already; stampOwnRow then
       answers that uuid and writes nothing). Never a mint of its own, unless the
       one in flight failed or left no uuid. Checked and registered with no await in
       between, so two mints can never both miss each other. */
    for (let inFlight = seriesMints.get(key); inFlight; inFlight = seriesMints.get(key)) {
      /* #4072 (review pass 1) — a mint that stamped some books and then failed
         still names its uuid (withStampedUuid): adopt that one, never a new one. */
      const adopted = await inFlight.catch((e: unknown) => (e as { stampedVoiceUuid?: string } | undefined)?.stampedVoiceUuid);
      if (adopted) return stampOwnRow(bookDir, characterId, adopted, linkId);
    }
    const minting = mintSeriesVoiceUuid(bookDir, characterId, linkId, seriesFilter);
    seriesMints.set(key, minting);
    try {
      return await minting;
    } finally {
      if (seriesMints.get(key) === minting) seriesMints.delete(key);
    }
  }
  return mintBookVoiceUuid(bookDir, characterId, unconfirmed);
}

/* #4072 — a series mint's failure after it stamped a book carries the uuid it
   stamped, so a mint waiting on it adopts that uuid rather than splitting the link. */
function withStampedUuid(e: unknown, uuid: string | undefined): unknown {
  if (!uuid || !(e instanceof Error)) return e;
  return Object.assign(e, { stampedVoiceUuid: uuid });
}

/* The series mint proper (readOrMintVoiceUuid registers it as in flight). */
async function mintSeriesVoiceUuid(
  bookDir: string,
  characterId: string,
  linkId: string,
  seriesFilter: { author: string; series: string },
): Promise<string | undefined> {
  /* forEachMatchingCastCharacter takes its own per-book cast lock as it
     walks — a locked leaf (cast-lock.ts rule 1) — so this branch stays
     unlocked and delegating; it must not gain a lock of its own. */
  const uuid = nanoid();
  /* PR #4007 pass 11, P11-3 (owner decision: the mint copies before it stamps) —
     a linked legacy row is stamped only once `qwen-<uuid>` holds a copy of the
     legacy key's base family, so a stamped row always has its file: a design
     that never lands (Design & compare then Cancel, a failed landing, a decline
     in between) leaves every stamped book speaking its own voice. With nothing
     to copy (nobody designed the legacy key) only the designing row is stamped.
     The caller holds the design lock. */
  /* P11-2 — the mint's key is saving until its walk ends (savingKeys). */
  return whileSaving(`qwen-${uuid}`, async () => {
    const legacyKey = `qwen-${linkId}`;
    const copied = await copyBaseFamily(legacyKey, `qwen-${uuid}`);
    if (!copied.includes(qwenVoicePtPath(`qwen-${uuid}`))) {
      await removeFiles(copied);
      /* Owner decision (share a first design): the landing shares it when it
         writes the key's first file, under its locks (shareFirstDesign). */
      return stampOwnRow(bookDir, characterId, uuid);
    }
    /* #4037 — the emotion variants travel with the base, before any row is stamped
       (a failed copy removes its own files; the base copy goes too). */
    /* What the mint wrote at each new-key variant file (refreshVariantCopies). */
    const prints = new Map<string, string | null>();
    try {
      const variants = await copyVariantFamilies(legacyKey, `qwen-${uuid}`);
      copied.push(...variants);
      recordMintPrints(prints, variants);
    } catch (e) {
      await removeFiles(copied);
      throw e;
    }
    /* A row that already has its own uuid keeps it: a separated row still shares
       `voiceId` with the earlier book, and restamping it would orphan its own
       designed voice. #4062 — `stampedAny` counts a book only once its cast.json
       write has landed (`onWritten`): a write that fails, or a later row of the
       same book that throws, leaves the copies with no book naming them. */
    let stampedAny = false;
    let stampedInBook = false;
    const stamp = (c: CastCharacter): CastCharacter => {
      if (c.voiceUuid) return c;
      refreshVariantCopies(c, legacyKey, `qwen-${uuid}`, prints, copied);
      stampedInBook = true;
      return withRekeyedVariants({ ...c, voiceUuid: uuid }, legacyKey, `qwen-${uuid}`);
    };
    try {
      await forEachMatchingCastCharacter(linkId, seriesFilter, stamp, undefined, () => {
        if (stampedInBook) stampedAny = true;
        stampedInBook = false;
      });
    } catch (e) {
      /* A book stamped before the failure points at the copy, which is its own
         voice's bytes: it keeps them. With nothing stamped the copy is a stray. */
      if (!stampedAny) await removeFiles(copied);
      throw withStampedUuid(e, stampedAny ? uuid : undefined);
    }
    /* The row's uuid as the walk left it, not the one minted here: a row a
       decline stamped meanwhile keeps its own (#4028 (c)). P11-1 — the walk skips
       every book whose cast is not confirmed, the designing book included (a
       design from the Confirm screen), so a row the walk did not stamp is stamped
       here, with its same-book rows on the link; every other book stamped holds the
       copy, so nothing is left without its file even when the row is gone. */
    const stampedFirst = stampedAny;
    try {
      const stamped = await stampOwnRow(bookDir, characterId, uuid, linkId, {
        from: legacyKey,
        to: `qwen-${uuid}`,
        prints,
        copied,
      });
      /* stampOwnRow wrote nothing (the row is gone, or already holds another uuid)
         and the walk stamped no book: no row names the copies. */
      if (!stampedFirst && stamped !== uuid) await removeFiles(copied);
      return stamped;
    } catch (e) {
      if (!stampedFirst) await removeFiles(copied);
      throw withStampedUuid(e, stampedFirst ? uuid : undefined);
    }
  });
}

/* The book-scoped mint: a standalone book, or (F8) a book whose cast is not
   confirmed. `recordSeparated` (the latter, review pass 3): the uuid is recorded as
   separated before a row names it, so a later design of the row is not isolated
   again (mustIsolateUnconfirmed). */
async function mintBookVoiceUuid(bookDir: string, characterId: string, recordSeparated?: boolean): Promise<string | undefined> {
  /* Book-scoped — the caller's design lock serialises only against OTHER
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
    const legacyKey = `qwen-${linkId}`;
    /* Review pass 5 -- read before anything is copied: a throw here leaves no copies.
       PR #4109 review pass 4 (🟠1): a decline-marked row's stamp carries the decline flag. */
    const ownStamp = recordSeparated
      ? declinedIf(hasDeclineMarker(freshChar), (await readBookOwnStamp(bookDir)) ?? UNNAMED_OWN_STAMP)
      : undefined;
    /* #4037 — same as the series mint: the legacy key's base family and emotion
       variants move to `qwen-<uuid>` before any row is stamped, so a stamped row
       always has its files (Design & compare resolves `qwen-<uuid>.pt`; a redesign
       sees the copied base). A failed copy removes its own files and rethrows;
       a failed cast write removes the copies. */
    /* No refresh here (unlike the series mint): the rows are read, the copies made and
       the cast written inside this one cast lock, so only another book sharing the
       bare legacy key could change a variant in between. */
    return whileSaving(`qwen-${uuid}`, async () => {
      const copied = await copyBaseFamily(legacyKey, `qwen-${uuid}`);
      const hasBase = copied.includes(qwenVoicePtPath(`qwen-${uuid}`));
      if (hasBase) {
        try {
          copied.push(...(await copyVariantFamilies(legacyKey, `qwen-${uuid}`)));
        } catch (e) {
          await removeFiles(copied);
          throw e;
        }
      } else {
        await removeFiles(copied);
      }
      let dirty = false;
      for (let i = 0; i < freshCast.characters.length; i++) {
        if ((freshCast.characters[i].voiceId ?? freshCast.characters[i].id) === linkId) {
          const stamped = { ...freshCast.characters[i], voiceUuid: uuid };
          freshCast.characters[i] = hasBase ? withRekeyedVariants(stamped, legacyKey, `qwen-${uuid}`) : stamped;
          dirty = true;
        }
      }
      if (dirty && recordSeparated) await recordSeparatedVoice(uuid, ownStamp);
      try {
        if (dirty) await writeJsonAtomic(castJsonPath(bookDir), freshCast);
      } catch (e) {
        if (dirty && recordSeparated) await forgetSeparatedVoice(uuid);
        await removeFiles(copied);
        throw e;
      }
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
/* #3992 / #4028 — a preview belongs to ONE row: its id ends in a tag of the
   row's (bookId, characterId), so two linked rows on one voice never share a
   preview, a decline can drop exactly the moved rows' previews, and a row can
   discard its own preview after its key moved (the tag, not the key, proves it
   staged it). */
function previewTag(bookId: string, characterId: string): string {
  return createHash('sha1').update(`${bookId}|${characterId}`).digest('hex').slice(0, 10);
}
export function previewVoiceIdFor(realVoiceId: string, bookId: string, characterId: string): string {
  return `${realVoiceId}${PREVIEW_SUFFIX}-${previewTag(bookId, characterId)}`;
}
function isOwnStalePreview(previewVoiceId: string, bookId: string, characterId: string): boolean {
  if (!previewVoiceId.startsWith('qwen-') || !previewVoiceId.endsWith(`${PREVIEW_SUFFIX}-${previewTag(bookId, characterId)}`)) {
    return false;
  }
  try {
    qwenVoicePtPath(previewVoiceId); // throws on a name outside the voices dir
    return true;
  } catch {
    return false;
  }
}
/* #4028 — drop the previews the given rows staged under `oldKey` (base and every
   emotion), after a decline moved them off it. Another row's preview on the same
   key carries another tag and stays. Best-effort. */
async function dropStagedPreviews(
  oldKey: string,
  rows: Array<{ bookId: string; characterId: string }>,
  /** Review pass 2 — a Keep isolating its row carries this preview to the new key. */
  keepPreviewId?: string,
): Promise<void> {
  const files: string[] = [];
  for (const { bookId, characterId } of rows) {
    for (const designed of [oldKey, ...VARIANT_EMOTIONS.map((e) => `${oldKey}__${e}`)]) {
      const id = previewVoiceIdFor(designed, bookId, characterId);
      if (id === keepPreviewId) continue;
      files.push(qwenVoicePtPath(id), qwenVoiceSidecarPath(id), qwenVoiceWavPath(`${id}__master`));
    }
  }
  await removeFiles(files);
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

const BASE_PERSONA_RETRY_DELAYS_MS = [25, 75, 200];

/* The persona a design starts from: the body's, else the row's `voiceStyle`, else
   (an emotion variant only) the `instruct` the base design stored on its voice json.
   Shared by the single route and the bulk job. Only an ABSENT json answers ''; a
   read error is retried, then a RetryableForkError (the persona exists, so "no
   persona" would be a lie). */
export async function resolveVariantPersona(
  character: CastCharacter,
  characterId: string,
  explicit: string,
  emotion?: string,
): Promise<string> {
  const direct = explicit || (character.voiceStyle ?? '').trim();
  if (direct || !emotion) return direct;
  const key = character.overrideTtsVoices?.qwen?.name ?? qwenStorageKey(character, characterId);
  for (let attempt = 0; ; attempt++) {
    try {
      const base = await readJson<{ instruct?: unknown }>(qwenVoiceSidecarPath(key));
      return typeof base?.instruct === 'string' ? base.instruct.trim() : '';
    } catch (err) {
      if (attempt >= BASE_PERSONA_RETRY_DELAYS_MS.length) {
        console.error('[qwen-voice] base json unreadable for a variant persona', err);
        throw new RetryableForkError('The base voice could not be read right now; try again.');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, BASE_PERSONA_RETRY_DELAYS_MS[attempt]));
    }
  }
}

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
   override or the emotion variant — that stays with the callers.

   #4028 (owner decision: stage, then re-check) — ONE design-lock span runs the
   whole design, and no key is decided before the render:
     1. the sidecar renders to a private staging key (`qwen-staging-<nanoid>`);
     2. the uuid step (a base design's first mint, or the one-time separation of
        a row declined before the decline route did that) runs;
     3. under the row's book-op and cast lock, the row's CURRENT key is read and
        the staged files (and the audition) are moved onto it.
   "Don't reuse" takes no design lock; it moves rows under the same book-op and
   cast locks, so a decline that lands mid-render sends the design to the row's
   new voice, never to the voice it left. Any OTHER change of the row's key (a
   link made mid-render) discards the render with DesignVoiceChangedError (pass
   11, P11-5). Every failure removes the staged files; after an abort or a
   timeout they are removed again later, since the sidecar may still write them
   (Y2). A variant anchors on the base the row held when the span started, re-read
   under the cast lock (a separation copies that base, so the anchor is the same
   bytes; a link would change them, and is discarded). */
export interface DesignQwenVoiceParams {
  /** The row's book, for the final step's book-op. */
  bookId: string;
  bookDir: string;
  /** The series a base design's first uuid is minted across (none: this book only). */
  seriesFilter?: { author: string; series: string };
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
  /** A first base design the caller persists (the SSE and bulk jobs): the landing
      also gives the book's rows on the landed key a qwen slot when they have none,
      under its lock, so a decline right after it moves a row that has one (pass 11,
      Y1). The caller's series-wide applyOverrideToCastFiles still follows. */
  persistSlot?: boolean;
  /** The bulk job's freshness rule, re-checked under the lock at the landing: a row
      that already carries a qwen slot then throws DesignSlotTakenError, before
      anything lands (#4031). */
  skipIfSlotted?: boolean;
  /** A base design whose caller skipped the early series clone gate (#4074: a declined
      row, which the design may move onto a new voice uuid): the landing runs the scan
      after the uuid step, under the row's cast lock and before it writes anything,
      and throws SeriesCloneRefusedError on a hit. */
  refuseIfSeriesCloned?: boolean;
  /** External cancel — aborts the in-flight sidecar call (e.g. the bulk job's
      controller on a Cancel) in addition to the internal timeout. */
  signal?: AbortSignal;
  /** When present, forwarded to the sidecar so it can POST phase progress back
      to this server (AR2 design-progress feature). */
  progressToken?: string;
  progressUrl?: string;
}

export interface DesignQwenVoiceResult {
  /** The id the design landed on (the row's current key, or its preview id). */
  voiceId: string;
  url: string;
  /** The row's voiceUuid when the design landed. */
  voiceUuid?: string;
  /** #4067 — this design first separated a declined row onto a voice of its own
      (the uuid step's separation, which also renamed its qwen slot and dropped its
      variants). A client cannot tell that from a first mint by the uuid alone. */
  separated?: boolean;
  /** F8 — the design was shared with the series (its book's cast is confirmed); a
      caller propagating the slot uses the series scope only then. */
  seriesShared?: boolean;
  fellBackToDesignVoice?: boolean;
  fallbackReason?: 'not-installed' | 'corrupt';
}

/* #4028 — the staged artifact family a render writes (the sidecar's design and
   mint write the `.pt`, its `.json` and, for a design, the reference clip). */
const STAGED_FAMILY: Array<['pt' | 'json' | 'wav', string]> = [
  ['pt', ''],
  ['json', ''],
  ['wav', '__master'],
];

const exists = (path: string): Promise<boolean> => stat(path).then(
  () => true,
  () => false,
);

/* #4028 — remove everything a render staged under `staging` (best-effort). */
async function removeStaged(staging: string, auditionFile: string): Promise<void> {
  await removeFiles([
    ...STAGED_FAMILY.map(([kind, suffix]) => familyPath(kind, `${staging}${suffix}`)),
    qwenVoicePtPath(`${staging}__1.7b`),
    voiceSampleFilePath(auditionFile),
  ]);
}

/* PR #4007 pass 11, Y2 — the sidecar's design runs in a worker thread that a
   dropped connection does not stop, so after an abort, a timeout or an
   unreachable sidecar it can still write the staged family once removeStaged has
   run. That family is removed again later (mutable for tests). */
export const LATE_STAGING_SWEEP = { delayMs: 15 * 60_000 };
function scheduleLateStagingSweep(staging: string, auditionFile: string): void {
  const timer = setTimeout(() => void removeStaged(staging, auditionFile), LATE_STAGING_SWEEP.delayMs);
  timer.unref?.();
}

/* Y2 — at startup, before the server listens (no design of this process is in
   flight): remove the staged files a previous run left behind. PR #4007 pass 12,
   Y2 — only a staging key's exact shape (`qwen-staging-<nanoid>` plus the staged
   family's suffixes; a character id starting with `staging-` has its own legacy
   key), and only an entry older than an hour, as sweepStaleStaging: a second
   server on the same workspace may be mid-design. Never throws. */
const STAGED_FILE = /^qwen-staging-[A-Za-z0-9_-]{21}(?:\.pt|\.json|__master\.wav|__1\.7b\.pt)$/;
export async function sweepStaleDesignStaging(
  maxAgeMs: number = STAGING_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(qwenVoicesDir());
  } catch {
    return 0;
  }
  const stale: string[] = [];
  for (const n of names.filter((name) => STAGED_FILE.test(name))) {
    const s = await stat(join(qwenVoicesDir(), n)).catch(() => null);
    if (s && now - s.mtimeMs > maxAgeMs) stale.push(n);
  }
  await removeFiles(stale.map((n) => join(qwenVoicesDir(), n)));
  return stale.length;
}

/* #4026 (owner decision) — at startup, before the server listens: remove the
   emotion-variant files (`qwen-…__<emotion>` plus the family's suffixes) that no
   cast row in the library names (namedQwenVoices: a slot's stored name, or the
   render path's `<qwenStorageKey>__<emotion>`). The variant DELETE and promote
   only drop a row's slot and never delete a file, since a live check cannot see
   every writer adding a holder; this sweep runs while no request is in flight.
   Fails closed: a library folder or cast.json it cannot read deletes nothing this
   round (logged once). A name a row uses as its base is kept, a staging or
   preview file never matches, and an entry younger than an hour is kept (a second
   server on the same workspace may be mid-design, as sweepStaleDesignStaging).
   Returns how many files it removed; never throws. #4037: also removes the stale
   `<member>.mint-<nanoid8>.tmp` files a killed refresh left behind. */
const VARIANT_FILE = new RegExp(
  `^(qwen-.+__(?:${VARIANT_EMOTIONS.join('|')}))(?:${VARIANT_MEMBERS.map((s) => s.replace(/\./g, '\\.')).join('|')})$`,
);
const MINT_TMP_FILE = /^qwen-.+(?:\.pt|\.json|__master\.wav)\.mint-[A-Za-z0-9_-]{8}\.tmp$/;
export async function sweepOrphanVariantFiles(
  maxAgeMs: number = STAGING_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(qwenVoicesDir());
  } catch {
    return 0;
  }
  /* #4037 — the temp copies and backups replaceFamilyMembers stages, left by a process
     that died before its cleanup. Nothing names them, so no cast read is needed; the
     same hour guard covers a second server mid-mint. */
  const stale: string[] = [];
  for (const n of names.filter((name) => MINT_TMP_FILE.test(name))) {
    const s = await stat(join(qwenVoicesDir(), n)).catch(() => null);
    if (s && now - s.mtimeMs > maxAgeMs) {
      stale.push(n);
      /* a backup kept after a failed restore is the only copy of the old member */
      console.warn(`[variant-sweep] removing stale mint temp/backup ${n}.`);
    }
  }
  const candidates = names.filter((n) => VARIANT_FILE.test(n) && !STAGED_FILE.test(n));
  const named = candidates.length === 0 ? null : await namedQwenVoices().catch(() => null);
  if (candidates.length > 0 && !named) {
    console.warn('[variant-sweep] a book could not be read; keeping every variant file this round.');
  }
  for (const n of named ? candidates : []) {
    const stem = VARIANT_FILE.exec(n)?.[1];
    if (!stem || !named || named.has(stem)) continue;
    const s = await stat(join(qwenVoicesDir(), n)).catch(() => null);
    if (s && now - s.mtimeMs > maxAgeMs) stale.push(n);
  }
  await removeFiles(stale.map((n) => join(qwenVoicesDir(), n)));
  return stale.length;
}

/* #4028 — move a staged family onto `target`, each file renamed over the old one
   like promote (#4040: never rm-then-rename — the sidecar re-validates its cached
   prompt against the .pt on disk, so a synth landing while the base is absent
   would fail as undesigned; `renameWithRetry` rides out a transient Windows
   EPERM/EBUSY on the replace). Only what was staged replaces
   anything; with a `.pt` staged, the target's derived `__1.7b` prompt (built from
   the embedding being replaced) goes too, as the sidecar's own design does.
   PR #4007 pass 12, Y2 — a missing staged `.pt` (the sidecar answered but its file
   is gone, e.g. another server's sweep) fails the landing: it never answers 200
   having moved nothing. */
async function moveStaged(staging: string, target: string): Promise<void> {
  if (!(await exists(qwenVoicePtPath(staging)))) {
    throw new RetryableForkError('The designed voice was not saved; design it again.');
  }
  await rm(qwenVoicePtPath(`${target}__1.7b`), { force: true });
  for (const [kind, suffix] of STAGED_FAMILY) {
    const from = familyPath(kind, `${staging}${suffix}`);
    if (!(await exists(from))) continue;
    await renameWithRetry(from, familyPath(kind, `${target}${suffix}`));
  }
}

async function stampLandedVoiceId(staging: string, voiceId: string, voiceUuid: string | undefined): Promise<void> {
  const path = qwenVoiceSidecarPath(staging);
  const json = await readJson<Record<string, unknown>>(path);
  if (!json || typeof json.voiceId !== 'string') return;
  const uuid = voiceUuid ?? null;
  if (json.voiceId === voiceId && (!('voiceUuid' in json) || json.voiceUuid === uuid)) return;
  await writeJsonAtomic(path, { ...json, voiceId, ...('voiceUuid' in json ? { voiceUuid: uuid } : {}) });
}

/* #4040 — the base at `baseKey` was redesigned: give it a fresh `rev`, which makes
   every emotion variant designed against the old base stale in every book on the
   key (variant-base-rev.ts). Best-effort after the move: the redesign has landed,
   so a failed write is logged (those variants then stay in use until the next
   redesign) and never fails the request. */
export async function markBaseRedesigned(baseKey: string): Promise<void> {
  try {
    await stampBaseRedesign(baseKey);
  } catch (e) {
    console.error('[qwen-voice] could not mark a redesigned base voice; its old emotion variants stay in use', e);
  }
}

/* #4028 — evict ids from the sidecar's in-memory prompt cache (bounded,
   best-effort, like promote's evict): the landed key may still hold the embedding
   it replaced. */
async function evictSidecarVoices(voiceIds: string[]): Promise<void> {
  for (const voiceId of voiceIds) {
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId }),
        signal: AbortSignal.timeout(EVICT_FETCH_TIMEOUT_MS),
      });
    } catch {
      /* sidecar unreachable, or the evict timed out (AbortError) — non-fatal */
    }
  }
}

/* PR #4007 pass 11 (owner decision: share a first design) — a first design of a
   never-designed legacy key (`qwen-<linkId>` has no `.pt`) by a row on its own
   uuid (`uuid`), whose key gets its first file from this write (a landing or a
   promote); the write shares the design. */
interface FirstDesignShare {
  linkId: string;
  uuid: string;
}

/* P12-1 — the row declined some book ("Don't reuse"): its voice is its own. */
export const hasDeclineMarker = (c: CastCharacter): boolean => ((c as MarkedCharacter).declinedVoiceFrom ?? []).length > 0;

/* PR #4109 review pass 4 (🟠1) -- an unconfirmed mint's or isolation's stamp, with the decline
   flag when the row it moves carries the marker (separated-voices.ts). */
const declinedIf = <S extends object>(declined: boolean, stamp: S): S & { declined?: true } =>
  declined ? { ...stamp, declined: true } : stamp;

/* #4074 — does a consented clone sit on the row's own voice anywhere in the series? A
   row on a "Don't reuse"-separated uuid (separated-voices.ts) shares that voice with only
   the rows that hold the same uuid, so only those count: a clone on the declined book's
   row is on the voice this row left. Any other row (no uuid, an ordinary shared one, a
   stale marker) keeps the full `voiceId` scan -- what applyOverrideToCastFiles decides. */
export async function seriesClonedOnRowsVoice(
  character: CastCharacter,
  seriesFilter: { author: string; series: string } | undefined,
  bookDir?: string,
): Promise<boolean> {
  return hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter, undefined, bookDir, await separatedUuidOf(character));
}

/* The row's uuid when it is a "Don't reuse"-separated voice, else undefined. */
async function separatedUuidOf(character: CastCharacter): Promise<string | undefined> {
  const uuid = character.voiceUuid;
  return uuid && (await isSeparatedVoice(uuid)) ? uuid : undefined;
}

/* #4074 — a base design the series clone scan refused after the uuid step and before the
   landing: nothing was written for the design (the staged files are removed). The two
   base callers map it to `clone_protected` / `already_cloned`. The core stamps the uuid
   step's answer on it: a step that separated the row persists even though the landing
   refused, and the single route tells the open tab. */
export class SeriesCloneRefusedError extends Error {
  voiceUuid?: string;
  separated = false;
  constructor() {
    super('A consented clone sits on this voice elsewhere in the series.');
    this.name = 'SeriesCloneRefusedError';
  }
}

/* PR #4007 pass 13 (owner decision: a voice "Don't reuse" created is never shared
   with anyone outside the chain that moved with it) — may a first design of this
   row's voice be shared at all? Only an ordinary series voice: the row is on a
   uuid that no separation recorded (separated-voices.ts), whichever row on it
   designs, and the row itself declined nothing (a row marked before decline
   recorded its uuid is on a voice of its own too). */
async function isOrdinarySeriesVoice(c: CastCharacter | undefined): Promise<boolean> {
  return !!c?.voiceUuid && !hasDeclineMarker(c) && !(await isSeparatedVoice(c.voiceUuid));
}

/* Under the landing's locks, after its file landed: stamp `share.uuid` (and, for a
   design the caller persists, the slot) onto the rows still on the never-designed
   key in the row's own book and in `others` (each locked, in the series, its cast
   confirmed), so the series keeps one shared voice. Nothing at all unless the
   voice is an ordinary series voice (isOrdinarySeriesVoice: P12-1, pass 13); never a row that declined the
   designing book; never a row on another voice (a uuid, a cloned or library slot,
   a slot naming another key); nothing when the row has left the uuid or the
   legacy key gained a file. A write
   that fails is logged: the design has landed, and a row it missed keeps its own
   (empty) legacy key. */
async function shareFirstDesign(
  p: Pick<DesignQwenVoiceParams, 'bookDir' | 'bookId' | 'seriesFilter' | 'persistSlot'>,
  share: FirstDesignShare,
  landed: MarkedCharacter,
  voiceId: string,
  others: BookHandle[],
  writeCast: CastWriter,
): Promise<void> {
  const series = p.seriesFilter;
  if (landed.voiceUuid !== share.uuid || !series) return;
  /* P12-1, pass 13 — a voice "Don't reuse" created is shared with no other row, in
     any book (the declined book's rows and the rows still on the voice it left are
     the same voice), whichever row on it designs. Re-checked under the locks. */
  if (!(await isOrdinarySeriesVoice(landed))) return;
  if (!(await exists(qwenVoicePtPath(`qwen-${share.uuid}`)))) return;
  const legacyKey = `qwen-${share.linkId}`;
  if (await exists(qwenVoicePtPath(legacyKey))) return;
  const takes = (c: MarkedCharacter, otherBook: boolean): boolean => {
    const slot = c.overrideTtsVoices?.qwen as { name?: string; libraryUuid?: string } | undefined;
    if (c.voiceUuid || (c.voiceId ?? c.id) !== share.linkId || characterHasClonedSlot(c)) return false;
    if (slot?.libraryUuid || (slot?.name && slot.name !== legacyKey)) return false;
    return !otherBook || !(c.declinedVoiceFrom ?? []).includes(p.bookId);
  };
  const stamp = (c: MarkedCharacter): MarkedCharacter => ({
    ...c,
    voiceUuid: share.uuid,
    ...(p.persistSlot
      ? { overrideTtsVoices: { ...c.overrideTtsVoices, qwen: { ...c.overrideTtsVoices?.qwen, name: voiceId } } }
      : {}),
  });
  const books = [
    { dir: p.bookDir, otherBook: false },
    ...others
      .filter(
        (b) =>
          b.state.castConfirmed &&
          b.state.isStandalone !== true &&
          b.state.author === series.author &&
          b.state.series === series.series,
      )
      .map((b) => ({ dir: b.bookDir, otherBook: true })),
  ];
  for (const { dir, otherBook } of books) {
    try {
      const cast = await readJson<CastFile>(castJsonPath(dir));
      if (!cast?.characters) continue;
      let changed = false;
      const characters = cast.characters.map((c) => {
        if (!takes(c as MarkedCharacter, otherBook)) return c;
        changed = true;
        return stamp(c as MarkedCharacter);
      });
      if (changed) await writeCast(dir, { ...cast, characters });
    } catch (e) {
      console.error('[qwen-voice] could not share a first design with a linked book', e);
    }
  }
}

/* PR #4007 pass 12 — a promote that wrote the first real file for a never-designed
   key (`first`): the caller holds the book-ops and the cast locks of `own` and
   `others`. The row is re-read (a decline between the promote's own write and
   here may have moved it, which shareFirstDesign's uuid check then refuses). No
   slot is written (no persistSlot): the drawer's Save does, as on the design route. */
interface FirstKeptDesign extends FirstDesignShare {
  voiceId: string;
}
async function shareKeptDesign(
  own: BookHandle,
  others: BookHandle[],
  seriesFilter: { author: string; series: string } | null,
  first: FirstKeptDesign,
  characterId: string,
  writeCast: CastWriter,
): Promise<void> {
  /* F8 — a Keep in a book whose cast is not confirmed shares nothing. */
  if (!seriesFilter || !own.state.castConfirmed) return;
  const row = (await readJson<CastFile>(castJsonPath(own.bookDir)))?.characters?.find((c) => c.id === characterId);
  if (!row) return;
  await shareFirstDesign({ bookDir: own.bookDir, bookId: own.bookId, seriesFilter }, first, row as MarkedCharacter, first.voiceId, others, writeCast);
}

/* #4028 — the final step: under the row's book-op and cast lock (the locks a
   decline holds while it moves rows), read the row's CURRENT key and move the
   staged render and its audition onto it. The caller holds the design lock.
   P11-5 — the current key must be the one the design may land on (`watcher`: the
   start key, moved only by the design's own uuid step and by a separation that
   moved the row); any other change throws DesignVoiceChangedError and the caller
   discards the render.
   A base design that writes the first file of the row's uuid key (P12-4: however
   the uuid was minted, a Cancel or a discarded landing included) also takes the
   book-ops and cast locks of the other books with a row on the never-designed
   legacy key, and shares the design with them (shareFirstDesign), unless the
   voice is not an ordinary series voice (isOrdinarySeriesVoice: P12-1, pass 13). The holders are planned lock-free and the
   rule is re-decided under the locks. When one of those books is gone by then,
   it lands on the row's own book alone. */
async function landStagedDesign(
  p: DesignQwenVoiceParams,
  staging: string,
  calibrationText: string,
  watcher: { key: string },
  /** #4040 — a variant design: the base `rev` read when its render began. */
  variantBaseRev?: string,
  /** F8 — the series a first design is shared with: none in an unconfirmed book. */
  shareSeries?: { author: string; series: string },
): Promise<{ voiceId: string; url: string; voiceUuid?: string }> {
  const audition = (voiceName: string) =>
    voiceSampleFileName({ cacheScope: p.sampleVoiceId, modelKey: p.modelKey, text: calibrationText, voiceName });
  const moved = () => new RetryableForkError('This book moved while the voice was being designed; try again.');
  const mayShare = !p.emotion && !p.preview && !!shareSeries;
  /* The first-design rule for a row: on an ordinary series voice (its own uuid,
     not one "Don't reuse" created), and no file at its key yet (this write creates
     it). */
  const firstDesignOf = async (c: CastCharacter | undefined): Promise<FirstDesignShare | undefined> =>
    mayShare && c?.voiceUuid && (await isOrdinarySeriesVoice(c)) && !(await exists(qwenVoicePtPath(`qwen-${c.voiceUuid}`)))
      ? { linkId: c.voiceId ?? c.id, uuid: c.voiceUuid }
      : undefined;
  /* The landing proper; the caller holds the row's book's cast lock (and those of
     `others`) and passes `writeCast` built inside it. */
  const land = async (others: BookHandle[], writeCast: CastWriter) => {
    const cast = await readJson<CastFile>(castJsonPath(p.bookDir));
    const row = cast?.characters?.find((c) => c.id === p.characterId);
    if (!row) throw new CharacterGoneError();
    const base = qwenStorageKey(row, p.characterId);
    if (base !== watcher.key) throw new DesignVoiceChangedError();
    if (p.skipIfSlotted && row.overrideTtsVoices?.qwen?.name) throw new DesignSlotTakenError();
    const designed = p.emotion ? `${base}__${p.emotion}` : base;
    const voiceId = p.preview ? previewVoiceIdFor(designed, p.bookId, p.characterId) : designed;
    /* #4074 -- before anything is written: a refusal here leaves the key, its rev and
       every row's slots as they were. */
    if (p.refuseIfSeriesCloned && !p.emotion && !p.preview && (await seriesClonedOnRowsVoice(row, shareSeries, p.bookDir))) {
      throw new SeriesCloneRefusedError();
    }
    const sharing = await firstDesignOf(row); // decided before the move creates the file
    /* #4040 — a base design over an existing base is a redesign (decided before the
       move, like `sharing`); a first design, a preview and a variant are not. */
    const redesign = !p.emotion && !p.preview && (await exists(qwenVoicePtPath(base)));
    await whileSaving(voiceId, async () => {
      /* A variant (or its preview) records the base it was rendered against in its
         STAGED json, so the json is complete the moment the move lands it: a copy
         of the key at any point after (the #4037 mint's refresh) carries it. */
      if (p.emotion) {
        await stampVariantBaseRev(staging, variantBaseRev).catch((e) =>
          console.error('[qwen-voice] could not record the base an emotion variant was designed against', e),
        );
      }
      /* The sidecar wrote its own `voiceId` (the staging key) into the json; point
         it at the key it lands on, before the move so the landed json is complete.
         Best-effort: nothing reads the field. */
      await stampLandedVoiceId(staging, voiceId, row.voiceUuid ?? undefined).catch((e) =>
        console.error('[qwen-voice] could not record the landed key in the voice json', e),
      );
      await moveStaged(staging, voiceId); // P11-2
      if (redesign) await markBaseRedesigned(voiceId);
    });
    if (p.persistSlot && !p.emotion && !p.preview && cast) {
      let slotted = false;
      const characters = cast.characters.map((c) => {
        if (c.overrideTtsVoices?.qwen || characterHasClonedSlot(c) || qwenStorageKey(c, c.id) !== base) return c;
        slotted = true;
        return { ...c, overrideTtsVoices: { ...c.overrideTtsVoices, qwen: { name: voiceId } } };
      });
      if (slotted) await writeCast(p.bookDir, { ...cast, characters });
    }
    if (sharing) await shareFirstDesign({ ...p, seriesFilter: shareSeries }, sharing, row as MarkedCharacter, voiceId, others, writeCast);
    const landedAudition = audition(voiceId);
    await rm(voiceSampleFilePath(landedAudition), { force: true });
    await rename(voiceSampleFilePath(audition(staging)), voiceSampleFilePath(landedAudition)).catch(() => {});
    return { voiceId, url: voiceSamplePublicUrl(landedAudition), voiceUuid: row.voiceUuid ?? undefined };
  };
  const planned = await firstDesignOf(
    (await readJson<CastFile>(castJsonPath(p.bookDir)))?.characters?.find((c) => c.id === p.characterId),
  );
  const shareIds = planned ? await legacyKeyHolderBookIds(p.bookDir, planned.linkId, shareSeries) : [];
  let out: Awaited<ReturnType<typeof land>> | typeof BOOK_GONE = BOOK_GONE;
  if (shareIds.length) {
    out = await withBookOps([p.bookId, ...shareIds], async (books) => {
      const own = books.find((b) => b.bookId === p.bookId);
      if (!own || resolve(own.bookDir) !== resolve(p.bookDir)) throw moved();
      const others = books.filter((b) => b !== own);
      return withCastLocks([own.bookDir, ...others.map((b) => b.bookDir)], () =>
        land(others, (dir, cast) => writeJsonAtomic(castJsonPath(dir), cast)),
      );
    });
  }
  if (out === BOOK_GONE) {
    out = await withBookOp(p.bookId, async (located) => {
      if (resolve(located.bookDir) !== resolve(p.bookDir)) throw moved();
      return withCastLock(p.bookDir, () => land([], (dir, cast) => writeJsonAtomic(castJsonPath(dir), cast)));
    });
  }
  if (out === BOOK_GONE) throw new CharacterGoneError('Book no longer exists.');
  await evictSidecarVoices([staging, out.voiceId]);
  return out;
}

export async function designQwenVoiceForCharacter(p: DesignQwenVoiceParams): Promise<DesignQwenVoiceResult> {
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
  /* The base a variant anchors on (read, never written; re-read when the span
     starts) and the private key the render writes; the key the design lands on
     is read only in landStagedDesign. */
  let baseVoiceId = qwenStorageKey(p.character, p.characterId);
  const voiceId = `qwen-staging-${nanoid()}`;
  const calibrationText = buildSampleText(toVoiceLike(p.character), buildHintFromCast(p.character));
  const stagedAudition = voiceSampleFileName({
    cacheScope: p.sampleVoiceId,
    modelKey: p.modelKey,
    text: calibrationText,
    voiceName: voiceId,
  });

  const tag = watchTag(p.bookId, p.characterId);
  /* F8 — the series this design shares with (none in an unconfirmed book). */
  let shareSeries: { author: string; series: string } | undefined;
  return withDesignLock(p.bookDir, async () => {
    try {
      /* P11-5 — the key this design may land on, read with the anchor under the
         book's cast lock as the span starts (a separation writes under it). */
      const watcher = await withCastLock(p.bookDir, async () => {
        const start = (await readJson<CastFile>(castJsonPath(p.bookDir)))?.characters?.find((c) => c.id === p.characterId);
        if (!start) throw new CharacterGoneError();
        baseVoiceId = qwenStorageKey(start, p.characterId);
        const w: DesignWatcher = { key: baseVoiceId, linkId: start.voiceId ?? start.id };
        designWatchers.set(tag, w);
        return w;
      });
      /* #4040 — the base `rev` this variant is recorded against, read before the
         render: a base redesign that lands DURING the render leaves the variant
         stale (recorded against the old rev), the safe direction. A redesign
         stamps its new rev only after its `.pt` is in place, and the sidecar's
         mint reads the base `.pt` on disk (its cached copy is checked against
         the file), so a variant that records the new rev was made from the new
         base, even before the redesign's evictSidecarVoices runs or if it fails. */
      let variantBaseRev: string | undefined;
      if (p.emotion) {
        try {
          variantBaseRev = await readBaseRev(baseVoiceId);
        } catch (err) {
          /* A node fs error (EBUSY) is curated by the route's own fs branch; a
             torn / unparseable json is not one, and its V8 parse message must not
             reach the body (nor be mapped as a sidecar failure): a fixed sentence. */
          if (isFsError(err)) throw err;
          console.error('[qwen-voice] base json unreadable for a variant design', err);
          throw new RetryableForkError('The base voice could not be read right now; try again.');
        }
      }
      const rendered = await renderStaged();
      /* Before the uuid step: a key some other writer changed during the render
         (a link) would send the mint across the wrong link. */
      const now = (await readJson<CastFile>(castJsonPath(p.bookDir)))?.characters?.find((c) => c.id === p.characterId);
      if (!now) throw new CharacterGoneError();
      if (qwenStorageKey(now, p.characterId) !== watcher.key) throw new DesignVoiceChangedError();
      /* F8 (owner decision: "not until confirmed") — in a book whose cast is not
         confirmed, a link may be a wrong auto-proposed match: a design there (base
         or emotion) first moves a row whose key another book holds onto a uuid of
         its own (isolateUnconfirmedRow), a base design mints the row's own uuid
         (book-scoped), and nothing is shared with the series, neither the mint's
         walk nor a first design. A state.json that cannot be read is not
         "unconfirmed" (review pass 1): the design refuses and writes nothing. */
      const confirmed = await bookCastConfirmedOrRetry(p.bookDir);
      shareSeries = confirmed ? p.seriesFilter : undefined;
      /* Review pass 2 — a preview moves nothing (it lands on a `-preview` sibling), so
         it isolates nothing: Cancel must leave the row as it was. Keep isolates. */
      if (!confirmed && !p.preview) await isolateUnconfirmedRow(p.bookDir, p.characterId);
      /* Review pass 3 (D) -- a preview in an unconfirmed book mints and separates
         nothing either: it stages under the row's current key, and Keep
         (isolateForKeep) separates or mints and carries it. */
      const stagedOnly = !confirmed && !!p.preview;
      const step: UuidStep = stagedOnly
        ? { uuid: now.voiceUuid ?? undefined, separated: false }
        : p.emotion
          ? await forkDeclinedVoiceUuidIfShared(p.bookDir, p.characterId)
          : await ensureCharacterVoiceUuidStep(p.bookDir, p.characterId, shareSeries, !confirmed);
      const uuid = stagedOnly ? step.uuid : requireDesignVoiceUuid(p.character, !!p.emotion, step.uuid);
      /* The uuid step's own move: a separation already moved the watcher, and a
         first mint gives a row that had no uuid its new key. A row that had one and
         now answers another, unannounced, was changed by some other writer; a link
         that landed during the step changed the row's link id. Both are discarded. */
      if (uuid && `qwen-${uuid}` !== watcher.key) {
        if (now.voiceUuid) throw new DesignVoiceChangedError();
        watcher.key = `qwen-${uuid}`;
      }
      const after = (await readJson<CastFile>(castJsonPath(p.bookDir)))?.characters?.find((c) => c.id === p.characterId);
      if (after && (after.voiceId ?? after.id) !== watcher.linkId) throw new DesignVoiceChangedError();
      let landed: Awaited<ReturnType<typeof landStagedDesign>>;
      try {
        landed = await landStagedDesign(p, voiceId, calibrationText, watcher, variantBaseRev, shareSeries);
      } catch (err) {
        if (err instanceof SeriesCloneRefusedError) {
          err.voiceUuid = uuid;
          err.separated = step.separated || !!watcher.separated;
        }
        throw err;
      }
      return { ...rendered, ...landed, separated: step.separated || !!watcher.separated, seriesShared: !!shareSeries };
    } catch (e) {
      await removeStaged(voiceId, stagedAudition);
      /* The sidecar cached the staged render's prompt under this one-off id; a failed
         design never lands it, so drop it too (bounded, best-effort, like the landing's
         evict) or every failed design grows the cache (#4031 final review). */
      await evictSidecarVoices([voiceId]);
      if (e instanceof SidecarDesignError && e.status === 0) scheduleLateStagingSweep(voiceId, stagedAudition);
      throw e;
    } finally {
      designWatchers.delete(tag);
    }
  });

  async function renderStaged(): Promise<Omit<DesignQwenVoiceResult, 'voiceUuid'>> {
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
  }
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

    /* #3711 — the design is a registered `design` job (a sidecar design call with no
       few-second bound): a folder move/delete is refused (409 book_busy) while it
       runs; it holds no book-op. Request-scoped: `fn` is everything from the resolve
       to the last write, and the route awaits `done`. The book is resolved by the
       registration (under book-op), so `located` is its CURRENT folder. */
    let registered;
    try {
      registered = await runBookJob(bookId, 'design', async (located) => {
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
       See tts/sidecar.ts `resolveWireLanguage`.

       Task 6 (#2246) — an unset book language must not silently design in
       English. `requireBookStateLanguage` throws for it; this route's own
       (JSON) shape surfaces it as a 409 `language_unset`. */
    let designLanguage: string;
    try {
      designLanguage = sidecarLanguageName(requireBookStateLanguage(located.state));
    } catch (e) {
      if (e instanceof BookLanguageUnsetError) {
        return res.status(409).json({ error: (e as Error).message, code: 'language_unset' });
      }
      throw e;
    }

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
    let persona: string;
    try {
      persona = await resolveVariantPersona(character, characterId, personaFromBody, emotion);
    } catch (e) {
      if (e instanceof RetryableForkError) return res.status(500).json({ error: e.message });
      throw e;
    }
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
    /* #3713 -- refused before any GPU work when the series fan-out would write a repaired mate and the
       request lacks the current repair epoch. */
    if (seriesInfo && (await refuseGatedSeriesFanOut(seriesInfo, req, res))) return;
    /* #1954 — refuse an emotion variant for a cloned character, series-wide
       (Task 7, #2006 v5). The design core holds the same invariant (see its
       comment for WHY refusal is the chosen resolution); this is the
       user-facing half, refused before any persona resolution or GPU work so
       the answer is an honest 409 rather than a 502 from the core's throw.
       Mirrors single-design.ts's `clone_protected` 409 — same code, so the
       drawer's existing handling reads it identically. Only the VARIANT path
       is gated: a base design on this route writes `qwen-<voiceUuid>.pt` and
       persists no override, so it never touches the clone.

       #4104 -- WHY a declined row's base design is not scanned here (the stream
       route passes `refuseIfSeriesCloned` on a non-preview design only; a preview
       skips the scan on both routes, so they differ only on a non-preview base
       design, the rebaseline modal's). The design itself persists no override and
       retargets no cloned slot. A preview of a marker-only decline does write
       cast.json: its uuid step separates the row and moves the same-uuid rows with
       it, never touching a library or cloned slot or `ttsEngine`. promote-voice
       writes cast.json only to isolate a decline in an unconfirmed book or to share
       a design with other books, again leaving clones alone. The clone gates sit at
       the writes: the drawer's Save is a scoped `PUT /api/voices/:voiceId/override`
       (#4069) plus its book-local cast PUT, and the rebaseline's is
       `voice-override-linked`, which refuses a cloned target per book. Pinned by
       qwen-voice.design-compare-clone-gate.test.ts.

       Sits here (not immediately after the emotion-shape 400 above) so it
       runs AFTER the persona/sampleVoiceId/modelKey 400 validators below and
       reuses `isStandalone`/`seriesInfo`, computed once for this purpose
       already — moving THIS check down was correct; moving that computation
       UP instead would have made every malformed request pay a full
       workspace-directory scan (`findAuthorSeriesForBookId`) before its 400.

       `characterHasClonedSlot(character) || hasClonedSlotAmongMatches(...)`
       — a deliberate backstop, not redundant: `hasClonedSlotAmongMatches`
       ignores books whose cast isn't confirmed yet, so a clone recorded on
       THIS book while its own cast is still unconfirmed would otherwise slip
       through a purely series-wide check. */
    if (
      emotion &&
      (characterHasClonedSlot(character) ||
        /* Review pass 4 (🟡4) -- an unconfirmed book shares nothing with the series (F8),
           and its take is recorded in this book alone, so a clone on another book is not
           one this write could touch: scan this book only (a torn confirmed mate would
           otherwise refuse the take with a 500). */
        (await seriesClonedOnRowsVoice(character, located.state?.castConfirmed === true ? (seriesInfo ?? undefined) : undefined, bookDir)))
    ) {
      return res.status(409).json({
        error: clonedVariantRefusal(character.name ?? characterId),
        code: 'clone_protected',
      });
    }
    /* srv-43 — the core mints/persists a voiceUuid for a BASE design (which
       writes the `.pt` at the resulting `qwen-<uuid>` key). A VARIANT never mints:
       it doesn't write the base `.pt`, so a fresh uuid would flip the base's
       storage key while its embedding stays at the old key — orphaning it
       (#1057). #4028: the design lands on the row's key as it stands when the
       render finishes (designQwenVoiceForCharacter). */
    try {
      const { voiceId, url, voiceUuid, seriesShared } = await designQwenVoiceForCharacter({
        bookId,
        bookDir,
        seriesFilter: seriesInfo ?? undefined,
        character,
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
           only for a standalone, or (F8) a book whose cast is not confirmed.
           Mirrors the base-voice series scope. */
        const outcome = await persistEmotionVariant(
          bookDir,
          characterId,
          emotion,
          voiceId,
          seriesShared ? (seriesInfo ?? undefined) : undefined,
        );
        if (outcome === 'skippedClone') {
          return res.status(409).json({
            error: clonedVariantRefusal(character.name ?? characterId),
            code: 'clone_protected',
          });
        }
        /* 'notFound' (no confirmed-cast book in scope matched this
           character at write time — a genuinely empty write, not a
           refusal) falls through to the same 200 as 'applied' below.
           This is NOT a new gap this task introduces: before this task,
           persistEmotionVariant returned void unconditionally and the
           route always answered 200 regardless of whether anything was
           actually written for this exact case — this branch makes that
           pre-existing disposition explicit rather than changing it. Only
           'skippedClone' is new, deliberate refusal-reporting behaviour;
           'notFound' intentionally keeps today's behaviour, named rather
           than left as a silent fallthrough. */
      }
      /* srv-43 — return voiceUuid so the drawer can stamp it locally without
         a refetch; the /sample player needs it to hit the uuid-keyed cache. */
      return res.status(200).json({ voiceId, url, voiceUuid });
    } catch (e) {
      if (e instanceof CharacterGoneError) return res.status(404).json({ error: e.message });
      /* A fixed, path-free sentence that says a retry can work (a book that was
         unreadable or changed during a separation): the user is told so instead of
         the generic message. */
      if (e instanceof RetryableForkError) return res.status(500).json({ error: e.message });
      /* The core throws a user-facing message for sidecar/encode/timeout
         failures. Map the sidecar's OWN status through (#1801) — a 503 is the
         retryable "no GPU capacity, free VRAM and retry" signal, and flattening
         it to 502 left the caller unable to tell it apart from a broken
         gateway. Unreachable/cancelled (status 0) still lands on 502. */
      const { GpuBusyError } = await import('../gpu/gpu-load.js');
      if (e instanceof GpuBusyError) {
        return res.status(409).json({ error: e.message, code: 'gpu_busy' });
      }
      /* #2260 FINAL ROUND (B2) — `ensureCharacterVoiceUuid` and
         `persistEmotionVariant` both take cast locks on this path (the design
         lock itself is a different, un-timed mutex and cannot produce the
         class). Same curation as every other whole-request site.

         Status, not just body: `LockAcquisitionTimeoutError` carries no
         `.status`, so routing it through `httpStatusForSidecarError` folded it
         into that function's generic 502 default — "Bad Gateway" paired with a
         body about book-level contention, which is not a sidecar/gateway
         failure at all. Every other curated whole-request site in this file
         answers 500 for its own failures; matching that here instead of
         inheriting the sidecar-error mapping's default. */
      /* #4028 — a node fs error (a separation's copy, a staged move) is this
         server's own failure, not the sidecar's: 500, like the curated sites. */
      const status = isLockAcquisitionTimeout(e) || isFsError(e) ? 500 : httpStatusForSidecarError(e);
      return res.status(status).json({
        error: requestFailureMessageFs(e, (e as Error).message || 'Voice design failed.'),
      });
    }
      });
    } catch (e) {
      console.error('[qwen-voice] design-voice registration failed', e);
      return res.status(500).json({ error: requestFailureMessage(e, 'Voice design failed.') });
    }
    if (registered === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    try {
      await registered.done;
    } catch (e) {
      console.error('[qwen-voice] design-voice failed', e);
      if (!res.headersSent) {
        res.status(500).json({ error: requestFailureMessageFs(e, 'Voice design failed.') });
      }
    }
  },
);

/* #2127 — bound for the sidecar cache-evict fetches (evictSidecarVoices). Node's undici
   defaults to a 300s fetch timeout; a sidecar that accepts the TCP connection
   but is blocked (mid model load or recycle — routine on this box) would
   otherwise hang the caller for up to five minutes even though eviction is
   purely best-effort (a cheap in-memory dict pop on the sidecar side — see
   `evictSidecarVoice` in workspace/purge-clone-artifacts.ts for the same
   endpoint's cost analysis). Single-digit seconds is generous for that. */
export const EVICT_FETCH_TIMEOUT_MS = 3_000;

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

    /* #3711 — QUICK (every sidecar call here is bounded by EVICT_FETCH_TIMEOUT_MS),
       so book-op is held for the whole span: the cast.json write below hits the
       folder resolved here, even with a rename queued behind.
       #4028 — promote is the last step of a staged design, so it moves the preview
       the way a design lands: under the book's design lock, then the book-op, then
       the cast lock, against the row's CURRENT key (a decline moves rows under the
       same book-op and cast lock). The book is peeked lock-free only to key the
       design lock; the locked handle must resolve to the same folder. */
    const peeked = await peekBook(bookId);
    if (!peeked) return res.status(404).json({ error: 'Book not found.' });
    /* PR #4007 pass 12 (owner decision: share a first design) — a promote that writes
       the first real file for a never-designed shared key shares it like a landing
       (shareFirstDesign), so it also takes the book-ops and cast locks of the other
       books with a row on that key. The holders are found lock-free here and
       re-decided inside the locks; a gone book falls back to this book alone. */
    const moved500 = () => res.status(500).json({ error: 'This book moved while the voice was being promoted; try again.' });
    const promoteIn = async (
      located: BookHandle,
      seriesInfo: { author: string; series: string } | null,
      afterMove: (first: FirstKeptDesign) => Promise<void>,
    ) => {
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    const modelKey = body.modelKey;

    /* A redesign replaces the base embedding in place, so every emotion variant
       minted from the OLD embedding is now stale (each was anchored to a PT that
       no longer exists). #4040 — the promote gives the base a fresh `rev`
       (variant-base-rev.ts), which makes those variants stale in every book on
       the key at once, this row included; no cast.json is written. The
       character's tagged emotions then re-register as missing demand, so the
       cast's "Design full cast → Emotion variants" scope re-mints the ones the
       user still wants from the new base. #4026 — the variant FILES stay: the
       startup sweep (sweepOrphanVariantFiles) removes the ones nothing names. */
    /* The read, the preview-id check and the artifact moves all
       sit inside the cast lock (rule 2: every decision derived from the read goes
       inside it). The sidecar evict stays OUTSIDE: it is a best-effort network call (#2127 — bounded by EVICT_FETCH_TIMEOUT_MS,
       but still no reason to pin the lock for even that bounded worst case).
       Global order: design -> book-op -> cast (cast-lock.ts rule 4). */
    const moved = await withCastLock(located.bookDir, async (): Promise<
      { status: number; body: Record<string, unknown> } | { realVoiceId: string; realFileName: string; voiceUuid?: string; first?: FirstKeptDesign }
    > => {
      const fresh = await readJson<CastFile>(castJsonPath(located.bookDir));
      const character = fresh?.characters?.find((c) => c.id === characterId);
      if (!fresh || !character) {
        return { status: 404, body: { error: `Character "${characterId}" not found.` } };
      }

      const realVoiceId = qwenStorageKey(character, characterId);
      const expectedPreview = previewVoiceIdFor(realVoiceId, bookId, characterId);
      if (previewVoiceId !== expectedPreview) {
        return { status: 400, body: { error: `previewVoiceId must be "${expectedPreview}".` } };
      }
      if (!sampleVoiceId) return { status: 400, body: { error: '`sampleVoiceId` is required.' } };
      if (!isTtsModelKey(modelKey)) {
        return { status: 400, body: { error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` } };
      }

      /* Move the staged embedding onto the stable id, renamed over the old file so
         the real `.pt` (and `.json`) is never absent mid-swap (#4040, see
         moveStaged). A missing preview `.pt` means
         nothing was staged (e.g. a double-promote) → 409 — checked via `stat`
         BEFORE the live `.pt` is removed (#1804), so a double-promote can't
         delete a live artifact when the replacement was never staged. */
      try {
        await stat(qwenVoicePtPath(previewVoiceId));
      } catch (e) {
        /* PR #3714 review -- the stat error names the absolute preview path; it
           goes to the log, never the body. */
        console.warn('[qwen-voice] promote: no staged preview', e);
        return { status: 409, body: { error: 'No staged preview voice to promote.' } };
      }
      /* Nothing at the real key yet: this promote writes its first real file. */
      const firstFile = !(await exists(qwenVoicePtPath(realVoiceId)));
      /* P11-2 — the real key is saving during its rename. */
      await whileSaving(realVoiceId, () =>
        renameWithRetry(qwenVoicePtPath(previewVoiceId), qwenVoicePtPath(realVoiceId)),
      );
      /* Best-effort: a preview with no `.json` drops the old one rather than
         pairing the new embedding with the old voice's manifest. */
      if (await exists(qwenVoiceSidecarPath(previewVoiceId))) {
        await renameWithRetry(qwenVoiceSidecarPath(previewVoiceId), qwenVoiceSidecarPath(realVoiceId)).catch(
          () => {},
        );
      } else {
        await rm(qwenVoiceSidecarPath(realVoiceId), { force: true }).catch(() => {});
      }
      await stampKeyVoiceId(realVoiceId).catch((e) =>
        console.error('[qwen-voice] could not record the promoted key in the voice json', e),
      );
      /* #4040 — a promote over an existing base is a redesign: a fresh `rev` makes
         every variant designed against the old base stale. A first file has no
         variants of its own to invalidate. */
      if (!firstFile) await markBaseRedesigned(realVoiceId);
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

      const first =
        firstFile && seriesInfo && character.voiceUuid && (await isOrdinarySeriesVoice(character))
          ? { linkId: character.voiceId ?? character.id, uuid: character.voiceUuid, voiceId: realVoiceId }
          : undefined;
      return { realVoiceId, realFileName, voiceUuid: character.voiceUuid ?? undefined, first };
    });
    if ('status' in moved) return res.status(moved.status).json(moved.body);
    /* Still under the book-ops (and this book's design lock): the first real file of
       a never-designed key is shared with the linked rows, under every involved
       book's cast lock (the caller's afterMove), re-reading the row. */
    if (moved.first) await afterMove(moved.first);

    /* Evict the real id from the sidecar's in-memory prompt cache. Best-effort:
       a down/empty sidecar has nothing cached, and generation reads the fresh
       `.pt` from disk regardless. #2127 — bounded by EVICT_FETCH_TIMEOUT_MS
       (evictSidecarVoices), so a blocked-but-listening sidecar
       can't hold this open for undici's 300s default. */
    await evictSidecarVoices([moved.realVoiceId]);

    /* srv-43 — return voiceUuid so the drawer can stamp it locally; the
       /sample player needs it to hit the uuid-keyed cache on the next play. */
    return res
      .status(200)
      .json({ voiceId: moved.realVoiceId, url: voiceSamplePublicUrl(moved.realFileName), voiceUuid: moved.voiceUuid });
    };
    const outcome = await withDesignLock(peeked.bookDir, async () => {
      try {
        const carried = await isolateForKeep(peeked.bookDir, bookId, characterId, {
          previewVoiceId: typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '',
          sampleVoiceId: typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '',
          modelKey: body.modelKey,
        });
        if (carried) body.previewVoiceId = carried;
      } catch (e) {
        if (e instanceof RetryableForkError) return res.status(500).json({ error: e.message });
        if (e instanceof CharacterGoneError) return res.status(404).json({ error: e.message });
        throw e;
      }
      const seriesInfo = peeked.state?.isStandalone === true ? null : await findAuthorSeriesForBookId(bookId);
      const row = seriesInfo
        ? (await readJson<CastFile>(castJsonPath(peeked.bookDir)).catch(() => undefined))?.characters?.find((c) => c.id === characterId)
        : undefined;
      const shareIds = row?.voiceUuid && (await isOrdinarySeriesVoice(row)) ? await legacyKeyHolderBookIds(peeked.bookDir, row.voiceId ?? row.id, seriesInfo ?? undefined) : [];
      let out: Awaited<ReturnType<typeof promoteIn>> | typeof BOOK_GONE = BOOK_GONE;
      if (shareIds.length) {
        out = await withBookOps([bookId, ...shareIds], async (books) => {
          const own = books.find((b) => b.bookId === bookId);
          if (!own || resolve(own.bookDir) !== resolve(peeked.bookDir)) return moved500();
          const rest = books.filter((b) => b !== own);
          return promoteIn(own, seriesInfo, (first) =>
            withCastLocks([own.bookDir, ...rest.map((b) => b.bookDir)], () =>
              shareKeptDesign(own, rest, seriesInfo, first, characterId, (dir, cast) => writeJsonAtomic(castJsonPath(dir), cast)),
            ),
          );
        });
      }
      if (out === BOOK_GONE) {
        out = await withBookOp(bookId, async (located) =>
          resolve(located.bookDir) !== resolve(peeked.bookDir)
            ? moved500()
            : promoteIn(located, seriesInfo, (first) =>
                withCastLock(located.bookDir, () =>
                  shareKeptDesign(located, [], seriesInfo, first, characterId, (dir, cast) => writeJsonAtomic(castJsonPath(dir), cast)),
                ),
              ),
        );
      }
      return out;
    });
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    return outcome;
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

    /* #3711 — quick (local rm only); book-op held for the whole span. */
    const outcome = await withBookOp(bookId, async (located) => {
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    const expectedPreview = previewVoiceIdFor(qwenStorageKey(character, characterId), bookId, characterId);
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    /* #4028 — a row may also drop a preview it staged under a key it has since
       left (a decline moved it): the id's tag, not its key, proves this row staged
       it. Anything else, or a name the voices dir refuses, is not this row's. */
    if (previewVoiceId !== expectedPreview && !isOwnStalePreview(previewVoiceId, bookId, characterId)) {
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
    });
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    return outcome;
  },
);

/* DELETE /api/books/:bookId/cast/:characterId/emotion-variant/:emotion

   fs-34 (fs-25 Wave 5e) — drop a designed emotion variant. Removes the
   `overrideTtsVoices.qwen.variants[emotion]` slot from cast.json, so a bad
   design is discardable without touching the base voice. The base `qwen.name`
   and every other variant are preserved; an empty `variants` map is cleaned up
   so the Variants badge clears. Idempotent: removing an absent variant still
   returns 200. #4026 — the variant's `.pt`/`.json` stay on disk: another row (a
   linked book, a declined one, a same-book sibling) may still name them, and a
   lock-free "does anyone else name it" check here kept racing writers that add a
   holder. The startup sweep (sweepOrphanVariantFiles) removes the files no cast
   row names. */
qwenVoiceRouter.delete(
  '/:bookId/cast/:characterId/emotion-variant/:emotion',
  async (req: Request, res: Response) => {
    const { bookId, characterId, emotion } = req.params;

    if (!(VARIANT_EMOTIONS as readonly string[]).includes(emotion)) {
      return res.status(400).json({
        error: `emotion must be one of: ${VARIANT_EMOTIONS.join(', ')}`,
      });
    }

    /* #3711 — quick (one cast.json write); book-op is held for the whole span,
       outside the cast lock below. */
    const outcome = await withBookOp(bookId, async (located) => {
    const found = await withCastLock(located.bookDir, async (): Promise<boolean> => {
      const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
      const character = cast?.characters?.find((c) => c.id === characterId);
      if (!character || !cast) return false;

      /* Drop the slot from cast.json (preserving base + sibling variants). */
      const qwenSlot = character.overrideTtsVoices?.qwen;
      if (qwenSlot?.variants && emotion in qwenSlot.variants) {
        delete qwenSlot.variants[emotion as Exclude<Emotion, 'neutral'>];
        if (Object.keys(qwenSlot.variants).length === 0) delete qwenSlot.variants;
        await writeJsonAtomic(castJsonPath(located.bookDir), cast);
      }
      return true;
    });

    if (!found) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    return res.status(200).json({ ok: true, removed: emotion });
    });
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    return outcome;
  },
);
