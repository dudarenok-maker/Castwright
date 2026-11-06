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
import { rename, rm, copyFile, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';
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
import { withCastLock, withCastLocks } from '../workspace/cast-lock.js';
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
  isVariantUsedByOtherVoiceUuid,
  legacyKeyHolderBookIds,
  scanVoiceHolders,
  voiceHeldBy,
  mustSeparateOnDecline,
  mustSeparateOnDesign,
  type LinkFollower,
  readBookId,
  RetryableForkError,
} from '../workspace/voice-uuid-fork.js';
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
    const stillCloned = await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter);
    if (stillCloned) return 'skippedClone';

    /* Residual-window backstop: the walk still takes nonzero time after the
       scan above passed. Threading the walk's own returned count through
       (rather than discarding it, as an earlier revision did) is what lets
       'applied' and 'notFound' be told apart below. */
    let residualSkip = false;
    const updated = await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) => {
      if (characterHasClonedSlot(c)) {
        residualSkip = true;
        return c; // unchanged — this book's own write correctly declined
      }
      /* #3992 — a variant anchored on one base cannot belong to a row with a
         different base (a declined, forked row still shares the voiceId). Compared
         by storage key, so a legacy row (no uuid) and a separated one never trade
         slots either (P10-2): render re-derives `<row's key>__<emotion>`. */
      if (qwenStorageKey(c, c.id) !== baseVoiceId) return c;
      return addVariant(c, baseVoiceId);
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
    if (baseVoiceId !== landedBase) return 'notFound'; // moved since the variant landed
    fresh.characters[idx] = addVariant(freshCharacter, baseVoiceId);
    await writeJsonAtomic(castJsonPath(bookDir), fresh);
    return 'applied';
  });
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
   another book's voice. */
const designWatchers = new Map<string, { key: string; linkId: string }>();
const watchTag = (bookId: string, characterId: string): string => `${bookId}|${characterId}`;

/* PR #4007 pass 11, P11-2 (owner decision: refuse only mid-save) — the voice keys
   whose base family a landing, a promote or a series mint is writing right now
   (`active` writers), and how many writes have ever begun on each, so a
   separation can tell a `.pt` missing mid-save from one nobody designed. One
   small entry per key saved by this process; never pruned, so `begun` is never
   reset under a reader. */
const savingKeys = new Map<string, { active: number; begun: number }>();
async function whileSaving<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
  return copied;
}

const removeFiles = async (files: string[]): Promise<void> => {
  await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => {})));
};

/* #3992 — stamp a new uuid onto one row and drop its qwen `variants` map in the
   same write. Render never reads a stored variant name: `pickEmotionVariantVoice`
   re-derives `qwen-<uuid>__<emotion>` from the row's uuid, and the copies are the
   base family only, so a surviving slot would ask for a `.pt` that does not exist
   (`voice_not_designed` at synth). Same reason and shape as voice-library.ts's
   assign route. The earlier book's variant files and its own slots are
   untouched. */
function withForkedUuid(c: CastCharacter, newUuid: string): CastCharacter {
  const qwen = c.overrideTtsVoices?.qwen;
  return {
    ...c,
    voiceUuid: newUuid,
    ...(qwen?.variants
      ? { overrideTtsVoices: { ...c.overrideTtsVoices, qwen: { ...qwen, variants: undefined } } }
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
   follower's book). */
export async function separationPlan(
  bookDir: string,
  characterId: string,
  fromBookId?: string,
): Promise<{ bookIds: string[]; followers: LinkFollower[] }> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const x = cast?.characters?.find((c) => c.id === characterId) as MarkedCharacter | undefined;
  if (!x) throw new CharacterGoneError();
  const xBookId = await readBookId(bookDir);
  if (!xBookId) throw new Error('Cannot separate a voice in a book that has no bookId.');
  const { followers } = await scanVoiceHolders(bookDir, x, voiceHeldBy(x), fromBookId);
  return { bookIds: [xBookId, ...followers.map((f) => f.bookId)], followers };
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
   rollback also failed keeps the copies it now points at. */
export async function separateVoiceLocked(
  bookDir: string,
  characterId: string,
  lockedDirs: string[],
  planned: LinkFollower[],
  writeCast: CastWriter,
  decline?: { fromBookId: string },
): Promise<SeparationResult> {
  const fresh = await readJson<CastFile>(castJsonPath(bookDir));
  const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
  if (!fresh || idx === -1) throw new CharacterGoneError();
  const x = fresh.characters[idx] as MarkedCharacter;
  const holds = voiceHeldBy(x);
  const scan = await scanVoiceHolders(bookDir, x, holds, decline?.fromBookId);
  const separate = decline ? mustSeparateOnDecline(x, scan, decline.fromBookId) : mustSeparateOnDesign(x, scan);

  if (!separate) {
    const marked = withDeclineMark(x, decline?.fromBookId, undefined);
    if (JSON.stringify(marked) !== JSON.stringify(x)) {
      fresh.characters[idx] = marked;
      await writeCast(bookDir, fresh);
    }
    return { voiceUuid: x.voiceUuid ?? undefined, separated: false, row: marked, movedSameBook: [] };
  }

  /* A book the plan found in the chain, locked on that basis, that cannot be read
     now is NOT skipped: skipping it would leave a row linked into the chain on the
     old voice while X moves. A chain that differs in any way from the plan's (a
     link that landed or left after the plan, a row that joined or left the voice)
     is not the set the locks were taken for. Fail; nothing has been written. */
  const locked = new Set(lockedDirs.map((d) => resolve(d)));
  const unreadable = new Set(scan.unreadableDirs);
  if (planned.some((f) => unreadable.has(resolve(f.dir)))) {
    throw new RetryableForkError('A book in this series could not be read while the voice was being separated; try again.');
  }
  const chainKey = (fs: LinkFollower[]) => fs.map((f) => `${resolve(f.dir)}|${f.characterId}`).sort().join('\n');
  if (chainKey(scan.followers) !== chainKey(planned) || scan.followers.some((f) => !locked.has(resolve(f.dir)))) {
    throw new RetryableForkError('A book in this series changed while the voice was being separated; try again.');
  }

  const linkId = x.voiceId ?? x.id;
  const oldUuid = x.voiceUuid ?? undefined;
  const newUuid = nanoid();
  const oldKey = oldUuid ? `qwen-${oldUuid}` : `qwen-${linkId}`;
  const savesBefore = savesOf(oldKey);
  const copied = await copyBaseFamily(oldKey, `qwen-${newUuid}`);
  /* PR #4007 pass 11, P11-2 (owner decision: refuse only mid-save) — a missing
     source `.pt` is a voice nobody designed (or one deleted by hand), and the row
     moves onto the empty key like any other, UNLESS a landing, promote or mint of
     that key was saving it across the copy (between its rm and its rename): then
     the step fails, retryably, before anything is written. */
  if (!copied.includes(qwenVoicePtPath(`qwen-${newUuid}`))) {
    const savesAfter = savesOf(oldKey);
    if (savesBefore.active > 0 || savesAfter.active > 0 || savesAfter.begun !== savesBefore.begun) {
      await removeFiles(copied);
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
    for (const dir of new Set(scan.followers.map((f) => resolve(f.dir)))) {
      const cast = await readJson<CastFile>(castJsonPath(dir));
      if (!cast?.characters) continue;
      const followerIds = new Set(scan.followers.filter((f) => resolve(f.dir) === dir).map((f) => f.characterId));
      const linkIds = new Set(cast.characters.filter((c) => followerIds.has(c.id)).map((c) => c.voiceId ?? c.id));
      let changed = false;
      const followerBookId = scan.followers.find((f) => resolve(f.dir) === dir)!.bookId;
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
    fresh.characters[idx] = withDeclineMark(fresh.characters[idx] as MarkedCharacter, decline?.fromBookId, oldUuid);
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
    if (restored) await removeFiles(copied);
    throw e;
  }
  /* P11-5 — a design in flight on a moved row follows it to the new voice. */
  for (const m of moved) {
    const w = designWatchers.get(watchTag(m.bookId, m.characterId));
    if (w?.key === oldKey) w.key = `qwen-${newUuid}`;
  }
  await dropStagedPreviews(oldKey, moved);
  console.log(
    `[qwen-voice] ${characterId}: separated from ${oldKey} onto qwen-${newUuid}` +
      ` (${scan.followers.length} follower(s) moved)`,
  );
  return { voiceUuid: newUuid, separated: true, row: fresh.characters[idx] as MarkedCharacter, movedSameBook };
}

/* #3992 — a design of a row declined before the decline route separated it (see
   mustSeparateOnDesign): run the route's separation once, under the same locks,
   then design the row's own key. Caller holds the design lock. Returns the row's
   uuid after the step. */
async function separateDeclinedVoiceForDesign(bookDir: string, characterId: string): Promise<string | undefined> {
  const plan = await separationPlan(bookDir, characterId);
  const out = await withBookOps(plan.bookIds, (books) => {
    const own = books.find((b) => b.bookId === plan.bookIds[0]);
    if (!own || resolve(own.bookDir) !== resolve(bookDir)) {
      throw new RetryableForkError('A book in this series changed while the voice was being separated; try again.');
    }
    return withCastLocks(
      books.map((b) => b.bookDir),
      () =>
        separateVoiceLocked(bookDir, characterId, books.map((b) => b.bookDir), plan.followers, (dir, cast) =>
          writeJsonAtomic(castJsonPath(dir), cast),
        ),
    );
  });
  if (out === BOOK_GONE) {
    throw new RetryableForkError('A book in this series was removed while the voice was being separated; try again.');
  }
  return out.voiceUuid;
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
async function forkDeclinedVoiceUuidIfShared(bookDir: string, characterId: string): Promise<string | undefined> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!character) return undefined;
  if (await needsDesignSeparation(bookDir, character)) return separateDeclinedVoiceForDesign(bookDir, characterId);
  return character.voiceUuid ?? undefined;
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
        fresh.characters[i] = { ...c, voiceUuid: uuid };
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
   new key, and only the designing row when there is nothing to copy: then
   `onFirstDesign` hears the link id and uuid, and the landing shares the design
   with the linked rows once its file exists), else book-scoped. Returns
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
  onFirstDesign?: (share: FirstDesignShare) => void,
): Promise<string | undefined> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!cast || !character) return undefined;
  if (await needsDesignSeparation(bookDir, character)) return separateDeclinedVoiceForDesign(bookDir, characterId);
  if (character.voiceUuid) return character.voiceUuid;

  if (seriesFilter) {
    /* forEachMatchingCastCharacter takes its own per-book cast lock as it
       walks — a locked leaf (cast-lock.ts rule 1) — so this branch stays
       unlocked and delegating; it must not gain a lock of its own. */
    const linkId = character.voiceId ?? character.id;
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
      const copied = await copyBaseFamily(`qwen-${linkId}`, `qwen-${uuid}`);
      if (!copied.includes(qwenVoicePtPath(`qwen-${uuid}`))) {
        await removeFiles(copied);
        /* Owner decision (share a first design): the landing shares it once the file
           exists, under its locks (shareFirstDesign). */
        const own = await stampOwnRow(bookDir, characterId, uuid);
        if (own === uuid) onFirstDesign?.({ linkId, uuid });
        return own;
      }
      /* A row that already has its own uuid keeps it: a separated row still shares
         `voiceId` with the earlier book, and restamping it would orphan its own
         designed voice. */
      let stampedAny = false;
      const stamp = (c: CastCharacter): CastCharacter => {
        if (c.voiceUuid) return c;
        stampedAny = true;
        return { ...c, voiceUuid: uuid };
      };
      try {
        await forEachMatchingCastCharacter(linkId, seriesFilter, stamp);
      } catch (e) {
        /* A book stamped before the failure points at the copy, which is its own
           voice's bytes: it keeps them. With nothing stamped the copy is a stray. */
        if (!stampedAny) await removeFiles(copied);
        throw e;
      }
      /* The row's uuid as the walk left it, not the one minted here: a row a
         decline stamped meanwhile keeps its own (#4028 (c)). P11-1 — the walk skips
         every book whose cast is not confirmed, the designing book included (a
         design from the Confirm screen), so a row the walk did not stamp is stamped
         here, with its same-book rows on the link; every other book stamped holds the
         copy, so nothing is left without its file even when the row is gone. */
      const stampedFirst = stampedAny;
      try {
        return await stampOwnRow(bookDir, characterId, uuid, linkId);
      } catch (e) {
        if (!stampedFirst) await removeFiles(copied);
        throw e;
      }
    });
  }

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
async function dropStagedPreviews(oldKey: string, rows: Array<{ bookId: string; characterId: string }>): Promise<void> {
  const files: string[] = [];
  for (const { bookId, characterId } of rows) {
    for (const designed of [oldKey, ...VARIANT_EMOTIONS.map((e) => `${oldKey}__${e}`)]) {
      const id = previewVoiceIdFor(designed, bookId, characterId);
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

/* Y2 — at startup, before the server listens (no design is in flight): remove
   every `qwen-staging-*` file a previous run left behind. Never throws. */
export async function sweepStaleDesignStaging(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(qwenVoicesDir());
  } catch {
    return 0;
  }
  const stale = names.filter((n) => n.startsWith('qwen-staging-'));
  await removeFiles(stale.map((n) => join(qwenVoicesDir(), n)));
  return stale.length;
}

/* #4028 — move a staged family onto `target`, rm-then-rename like promote (a
   Windows rename over an existing file can EPERM). Only what was staged replaces
   anything; with a `.pt` staged, the target's derived `__1.7b` prompt (built from
   the embedding being replaced) goes too, as the sidecar's own design does. */
async function moveStaged(staging: string, target: string): Promise<void> {
  if (!(await exists(qwenVoicePtPath(staging)))) return; // nothing rendered to disk
  await rm(qwenVoicePtPath(`${target}__1.7b`), { force: true });
  for (const [kind, suffix] of STAGED_FAMILY) {
    const from = familyPath(kind, `${staging}${suffix}`);
    if (!(await exists(from))) continue;
    const to = familyPath(kind, `${target}${suffix}`);
    await rm(to, { force: true });
    await rename(from, to);
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
   never-designed legacy key (`qwen-<linkId>` has no `.pt`): the mint stamped only
   the designing row (`uuid`), and the landing shares the design. */
interface FirstDesignShare {
  linkId: string;
  uuid: string;
}

/* Under the landing's locks, after its file landed: stamp `share.uuid` (and, for a
   design the caller persists, the slot) onto the rows still on the never-designed
   key in the row's own book and in `others` (each locked, in the series, its cast
   confirmed), so the series keeps one shared voice. Never a row whose book the
   designing row declined, or that declined the designing book; never a row on
   another voice (a uuid, a cloned or library slot, a slot naming another key);
   nothing when the row has left the uuid or the legacy key gained a file. A write
   that fails is logged: the design has landed, and a row it missed keeps its own
   (empty) legacy key. */
async function shareFirstDesign(
  p: DesignQwenVoiceParams,
  share: FirstDesignShare,
  landed: MarkedCharacter,
  voiceId: string,
  others: BookHandle[],
  writeCast: CastWriter,
): Promise<void> {
  const series = p.seriesFilter;
  if (landed.voiceUuid !== share.uuid || !series) return;
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
  const declinedByRow = new Set(landed.declinedVoiceFrom ?? []);
  const books = [
    { dir: p.bookDir, otherBook: false },
    ...others
      .filter(
        (b) =>
          b.state.castConfirmed &&
          b.state.isStandalone !== true &&
          b.state.author === series.author &&
          b.state.series === series.series &&
          !declinedByRow.has(b.bookId),
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

/* #4028 — the final step: under the row's book-op and cast lock (the locks a
   decline holds while it moves rows), read the row's CURRENT key and move the
   staged render and its audition onto it. The caller holds the design lock.
   P11-5 — the current key must be the one the design may land on (`watcher`: the
   start key, moved only by the design's own uuid step and by a separation that
   moved the row); any other change throws DesignVoiceChangedError and the caller
   discards the render.
   A first design (`share`) also takes the book-ops and cast locks of the other
   books with a row on the never-designed key, and shares the design with them
   (shareFirstDesign). When one of those books is gone by then, it lands on the
   row's own book alone. */
async function landStagedDesign(
  p: DesignQwenVoiceParams,
  staging: string,
  calibrationText: string,
  watcher: { key: string },
  share?: FirstDesignShare,
): Promise<{ voiceId: string; url: string; voiceUuid?: string }> {
  const audition = (voiceName: string) =>
    voiceSampleFileName({ cacheScope: p.sampleVoiceId, modelKey: p.modelKey, text: calibrationText, voiceName });
  const moved = () => new RetryableForkError('This book moved while the voice was being designed; try again.');
  const sharing = share && !p.emotion && !p.preview ? share : undefined;
  /* The landing proper; the caller holds the row's book's cast lock (and those of
     `others`) and passes `writeCast` built inside it. */
  const land = async (others: BookHandle[], writeCast: CastWriter) => {
    const cast = await readJson<CastFile>(castJsonPath(p.bookDir));
    const row = cast?.characters?.find((c) => c.id === p.characterId);
    if (!row) throw new CharacterGoneError();
    const base = qwenStorageKey(row, p.characterId);
    if (base !== watcher.key) throw new DesignVoiceChangedError();
    const designed = p.emotion ? `${base}__${p.emotion}` : base;
    const voiceId = p.preview ? previewVoiceIdFor(designed, p.bookId, p.characterId) : designed;
    await whileSaving(voiceId, () => moveStaged(staging, voiceId)); // P11-2
    if (p.persistSlot && !p.emotion && !p.preview && cast) {
      let slotted = false;
      const characters = cast.characters.map((c) => {
        if (c.overrideTtsVoices?.qwen || characterHasClonedSlot(c) || qwenStorageKey(c, c.id) !== base) return c;
        slotted = true;
        return { ...c, overrideTtsVoices: { ...c.overrideTtsVoices, qwen: { name: voiceId } } };
      });
      if (slotted) await writeCast(p.bookDir, { ...cast, characters });
    }
    if (sharing) await shareFirstDesign(p, sharing, row as MarkedCharacter, voiceId, others, writeCast);
    const landedAudition = audition(voiceId);
    await rm(voiceSampleFilePath(landedAudition), { force: true });
    await rename(voiceSampleFilePath(audition(staging)), voiceSampleFilePath(landedAudition)).catch(() => {});
    return { voiceId, url: voiceSamplePublicUrl(landedAudition), voiceUuid: row.voiceUuid ?? undefined };
  };
  const shareIds = sharing ? await legacyKeyHolderBookIds(p.bookDir, sharing.linkId) : [];
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
  return withDesignLock(p.bookDir, async () => {
    try {
      /* P11-5 — the key this design may land on, read with the anchor under the
         book's cast lock as the span starts (a separation writes under it). */
      const watcher = await withCastLock(p.bookDir, async () => {
        const start = (await readJson<CastFile>(castJsonPath(p.bookDir)))?.characters?.find((c) => c.id === p.characterId);
        if (!start) throw new CharacterGoneError();
        baseVoiceId = qwenStorageKey(start, p.characterId);
        const w = { key: baseVoiceId, linkId: start.voiceId ?? start.id };
        designWatchers.set(tag, w);
        return w;
      });
      const rendered = await renderStaged();
      /* Before the uuid step: a key some other writer changed during the render
         (a link) would send the mint across the wrong link. */
      const now = (await readJson<CastFile>(castJsonPath(p.bookDir)))?.characters?.find((c) => c.id === p.characterId);
      if (!now) throw new CharacterGoneError();
      if (qwenStorageKey(now, p.characterId) !== watcher.key) throw new DesignVoiceChangedError();
      let share: FirstDesignShare | undefined;
      const uuid = requireDesignVoiceUuid(
        p.character,
        !!p.emotion,
        p.emotion
          ? await forkDeclinedVoiceUuidIfShared(p.bookDir, p.characterId)
          : await ensureCharacterVoiceUuid(p.bookDir, p.characterId, p.seriesFilter, (s) => (share = s)),
      );
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
      return { ...rendered, ...(await landStagedDesign(p, voiceId, calibrationText, watcher, share)) };
    } catch (e) {
      await removeStaged(voiceId, stagedAudition);
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
        (await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesInfo ?? undefined, undefined, bookDir)))
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
      const { voiceId, url, voiceUuid } = await designQwenVoiceForCharacter({
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
           only for a standalone. Mirrors the base-voice series scope. */
        const outcome = await persistEmotionVariant(
          bookDir,
          characterId,
          emotion,
          voiceId,
          seriesInfo ?? undefined,
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

/* #2127 — bound for the sidecar cache-evict fetches below. Node's undici
   defaults to a 300s fetch timeout; a sidecar that accepts the TCP connection
   but is blocked (mid model load or recycle — routine on this box) would
   otherwise hang the caller for up to five minutes even though eviction is
   purely best-effort (a cheap in-memory dict pop on the sidecar side — see
   `evictSidecarVoice` in workspace/purge-clone-artifacts.ts for the same
   endpoint's cost analysis). Single-digit seconds is generous for that. */
export const EVICT_FETCH_TIMEOUT_MS = 3_000;

/* Tear down a designed emotion variant: delete its `.pt`/`.json` embedding +
   persona sidecar and evict it from the sidecar's in-memory prompt cache.
   Best-effort throughout — a missing file, unreachable sidecar, or timed-out
   evict (see EVICT_FETCH_TIMEOUT_MS) is non-fatal: `fetch` rejecting with an
   AbortError lands in the same bare `catch` as a network failure. Does NOT
   touch cast.json; the caller owns the slot mutation + atomic write so it can
   batch multiple removals into a single write. Shared by the per-emotion
   DELETE route and the redesign-invalidation in promote-voice. */
async function tearDownEmotionVariant(designedId: string): Promise<void> {
  await rm(qwenVoicePtPath(designedId), { force: true }).catch(() => {});
  await rm(qwenVoiceSidecarPath(designedId), { force: true }).catch(() => {});
  try {
    await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: designedId }),
      signal: AbortSignal.timeout(EVICT_FETCH_TIMEOUT_MS),
    });
  } catch {
    /* sidecar unreachable, or the evict timed out (AbortError) — non-fatal */
  }
}

/* #3992 — tear a variant down unless a character under a DIFFERENT base voice
   (storage key) still names it (a declined row that forked keeps the earlier
   book's variant names; a legacy earlier book is counted by its legacy key). The
   slot is already dropped from this row's cast by the caller; only the file
   deletion is skipped. The scan is read-only and runs outside any cast lock. */
async function tearDownVariantUnlessShared(variantId: string, ownKey: string): Promise<void> {
  if (await isVariantUsedByOtherVoiceUuid(variantId, ownKey)) {
    console.warn(`[qwen-voice] keeping variant "${variantId}": another voice still uses it`);
    return;
  }
  await tearDownEmotionVariant(variantId);
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
    const outcome = await withDesignLock(peeked.bookDir, () => withBookOp(bookId, async (located) => {
    if (resolve(located.bookDir) !== resolve(peeked.bookDir)) {
      return res.status(500).json({ error: 'This book moved while the voice was being promoted; try again.' });
    }
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    const previewVoiceId =
      typeof body.previewVoiceId === 'string' ? body.previewVoiceId.trim() : '';
    const modelKey = body.modelKey;

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
    /* The read, the preview-id check, the artifact moves and the variant drop all
       sit inside the cast lock (rule 2: every decision derived from the read goes
       inside it). The sidecar evict and the variant teardown stay OUTSIDE: those
       are best-effort network calls (#2127 — bounded by EVICT_FETCH_TIMEOUT_MS,
       but still no reason to pin the lock for even that bounded worst case).
       Global order: design -> book-op -> cast (cast-lock.ts rule 4). */
    const moved = await withCastLock(located.bookDir, async (): Promise<
      { status: number; body: Record<string, unknown> } | { realVoiceId: string; realFileName: string; ownKey: string; voiceUuid?: string }
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

      /* Move the staged embedding onto the stable id. rm-then-rename so a Windows
         rename over an existing file can't EPERM. A missing preview `.pt` means
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
      /* P11-2 — the real key is saving between this rm and its rename. */
      await whileSaving(realVoiceId, async () => {
        await rm(qwenVoicePtPath(realVoiceId), { force: true });
        await rename(qwenVoicePtPath(previewVoiceId), qwenVoicePtPath(realVoiceId));
      });
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

      const freshSlot = character.overrideTtsVoices?.qwen;
      /* KEEP this guard — it is the current behaviour (qwen-voice.ts:788) and it
         encloses the write. Without it every promote-voice writes cast.json even
         when the character has no emotion variants, which is the common path.
         Evaluated against the FRESH slot, per rule 2. */
      if (freshSlot?.variants && Object.keys(freshSlot.variants).length > 0) {
        staleVariantIds = Object.values(freshSlot.variants)
          .map((v) => v?.name)
          .filter((n): n is string => !!n);
        delete freshSlot.variants;
        await writeJsonAtomic(castJsonPath(located.bookDir), fresh);
      }
      return { realVoiceId, realFileName, ownKey: realVoiceId, voiceUuid: character.voiceUuid ?? undefined };
    });
    if ('status' in moved) return res.status(moved.status).json(moved.body);

    /* Evict the real id from the sidecar's in-memory prompt cache. Best-effort:
       a down/empty sidecar has nothing cached, and generation reads the fresh
       `.pt` from disk regardless. #2127 — bounded by EVICT_FETCH_TIMEOUT_MS
       (see tearDownEmotionVariant above), so a blocked-but-listening sidecar
       can't hold this open for undici's 300s default. */
    await evictSidecarVoices([moved.realVoiceId]);
    /* Teardown stays outside the cast lock: filesystem work, and holding the lock
       across it reintroduces exactly the stall the narrowing above avoids. */
    for (const variantId of staleVariantIds) {
      await tearDownVariantUnlessShared(variantId, moved.ownKey);
    }

    /* srv-43 — return voiceUuid so the drawer can stamp it locally; the
       /sample player needs it to hit the uuid-keyed cache on the next play. */
    return res
      .status(200)
      .json({ voiceId: moved.realVoiceId, url: voiceSamplePublicUrl(moved.realFileName), voiceUuid: moved.voiceUuid });
    }));
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

    /* #3711 — quick (the teardown's evict is bounded by EVICT_FETCH_TIMEOUT_MS);
       book-op is held for the whole span, outside the cast lock below. */
    const outcome = await withBookOp(bookId, async (located) => {
    /* C1 fix — mirrors promote-voice above (qwen-voice.ts, the
       "Narrow by design" comment on its own withCastLock call): the read is
       inside the lock, and the 404 + the variant-map mutation are both
       decisions derived from it (rule 2), but `tearDownEmotionVariant`'s
       sidecar `fetch` is a best-effort network call (#2127 — now bounded by
       EVICT_FETCH_TIMEOUT_MS rather than Node's undici ~300s default), so
       holding the lock across it would still needlessly pin this book's cast
       lock for that bounded worst case — and, per cast-lock.ts rule 4, stall
       a request queued behind it for `library-voice:<uuid>` too. Compute the
       designed id from the locked read, close the lock, then run the
       teardown after — filesystem work + a best-effort network call, nothing
       that needs the lock. */
    let ownKey = '';
    const designedId = await withCastLock(located.bookDir, async (): Promise<string | undefined> => {
      const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
      const character = cast?.characters?.find((c) => c.id === characterId);
      if (!character || !cast) return undefined;
      ownKey = qwenStorageKey(character, characterId);

      /* Drop the slot from cast.json (preserving base + sibling variants). */
      const qwenSlot = character.overrideTtsVoices?.qwen;
      /* #3992 — the stored `name` is the authoritative on-disk id (a forked row
         still names the earlier book's file); reconstruct only as a fallback. */
      const storedName = qwenSlot?.variants?.[emotion as Exclude<Emotion, 'neutral'>]?.name;
      if (qwenSlot?.variants && emotion in qwenSlot.variants) {
        delete qwenSlot.variants[emotion as Exclude<Emotion, 'neutral'>];
        if (Object.keys(qwenSlot.variants).length === 0) delete qwenSlot.variants;
        await writeJsonAtomic(castJsonPath(located.bookDir), cast);
      }

      return storedName || `${qwenStorageKey(character, characterId)}__${emotion}`;
    });

    if (designedId === undefined) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* Delete the designed embedding + persona sidecar and evict it (best-effort),
       outside the lock — see the comment above. */
    await tearDownVariantUnlessShared(designedId, ownKey);

    return res.status(200).json({ ok: true, removed: emotion });
    });
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    return outcome;
  },
);
