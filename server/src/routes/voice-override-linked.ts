/* POST /api/books/:bookId/cast/:characterId/voice-override-linked

   The keystone of the plan-122 durable rebaseline fix. The "Rebaseline the
   series" modal collapses recurring characters by name/alias even when the
   books never shared a `voiceId` (see `src/lib/merge-series-cast.ts`). A plain
   series-scoped override (`PUT /api/voices/:voiceId/override`) propagates only
   to books whose `voiceId ?? id` already matches — so approving such a
   collapsed row would silently skip the books on a divergent key.

   This route closes that gap: given a source (book, character), it rediscovers
   the SAME name/alias group the modal collapsed (mirroring
   `cast-series-patch.ts`'s `tokensFor`/`intersects` rule, which itself mirrors
   `series-prior-dedup.ts`), then for every member across the series it (a)
   unifies `voiceId` to one canonical key and (b) writes the voice override
   (`overrideTtsVoices[engine] = { name }`, `ttsEngine = engine`) — identical
   field writes to `applyOverrideToCastFiles`. After this, the group shares a
   key, so future plain series writes reach all of them too.

   Targets = the union of, across the source book + every confirmed series-mate:
     - the source character itself,
     - every character whose `voiceId ?? id` already equals the canonical key
       (preserves the old voiceId-keyed propagation), and
     - every character that name/alias-matches the source — UNLESS the pair is
       marked `notLinkedTo` (the user's "intentionally different" escape hatch).
   Fold buckets (`unknown-male`/`unknown-female`/`narrator`) never match by name.

   Body: { override: { engine, name } | null }  (null clears the engine map).
   Response: { canonicalVoiceId, updated: [{bookId,bookTitle,characterId}],
   failed: [{bookId,bookTitle,error}] }. 207 when failed.length>0, else 200. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { normaliseNameKey } from '../util/safe-id.js';
import { scanSeriesFullCharactersForBookId } from '../workspace/series-full-cast-scan.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import {
  characterHasClonedSlot,
  isCloneEngine,
  manifestSlotFor,
  cloneStorageKey,
  libraryVoiceForEngine,
} from '../tts/clone-engines.js';

export const voiceOverrideLinkedRouter = Router();

type Engine = 'coqui' | 'gemini' | 'piper' | 'kokoro' | 'qwen';

/* cast.json carries fields the analyzer schema doesn't declare — widen here so
   the round-trip read/write preserves them. libraryUuid/provenance are the
   fields fs-38 Wave 3c Task 4 fixes this route to stop dropping — a slot
   carrying `provenance: 'cloned'` identifies a consented clone, never a
   catalog/designed voice safe to silently replace. */
type PersistedCharacter = CharacterOutput & {
  voiceId?: string;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time. */
  voiceUuid?: string;
  overrideTtsVoices?: Partial<
    Record<Engine, { name: string; libraryUuid?: string; provenance?: 'designed' | 'cloned' | 'imported' }>
  >;
  overrideTtsVoice?: unknown; // legacy singular field — dropped on write
  ttsEngine?: Engine | null;
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
};
interface CastFile {
  characters: PersistedCharacter[];
}

const BUCKET_IDS = new Set(['unknown-male', 'unknown-female', 'narrator']);

function parseOverride(value: unknown): { engine: Engine; name: string } | null | 'invalid' {
  if (value === null) return null;
  if (typeof value !== 'object') return 'invalid';
  const v = value as { engine?: unknown; name?: unknown };
  if (typeof v.engine !== 'string' || typeof v.name !== 'string') return 'invalid';
  if (!['coqui', 'gemini', 'piper', 'kokoro', 'qwen'].includes(v.engine)) return 'invalid';
  if (v.name.trim().length === 0) return 'invalid';
  return { engine: v.engine as Engine, name: v.name.trim() };
}

voiceOverrideLinkedRouter.post(
  '/:bookId/cast/:characterId/voice-override-linked',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    if (!bookId || !characterId) {
      return res.status(400).json({ error: 'bookId and characterId are required.' });
    }
    const override = parseOverride((req.body ?? {}).override);
    if (override === 'invalid') {
      return res
        .status(400)
        .json({ error: 'Body must include `override: { engine, name }` or `override: null`.' });
    }

    const sourceLocated = await findBookByBookId(bookId);
    if (!sourceLocated) return res.status(404).json({ error: `Book "${bookId}" not found.` });

    const sourceCast = await readJson<CastFile>(castJsonPath(sourceLocated.bookDir));
    if (!sourceCast?.characters?.length) {
      return res
        .status(409)
        .json({ error: 'Source book has no cast on disk yet — run analysis first.' });
    }
    const source = sourceCast.characters.find((c) => c.id === characterId);
    if (!source) {
      return res
        .status(404)
        .json({ error: `Character "${characterId}" not found in book "${bookId}".` });
    }

    const canonicalVoiceId = source.voiceId ?? source.id;
    const sourceTokens = tokensFor(source);

    /* Decide whether a candidate (in `candBookId`) is in the source's group. */
    const inGroup = (cand: PersistedCharacter, candBookId: string): boolean => {
      if ((cand.voiceId ?? cand.id) === canonicalVoiceId) return true; // shared write key
      if (BUCKET_IDS.has(cand.id)) return false;
      if (!intersects(tokensFor(cand), sourceTokens)) return false;
      if (notLinkedToPair(source, candBookId, cand.id)) return false;
      if (notLinkedToPair(cand, bookId, source.id)) return false;
      return true;
    };

    /* Collect (bookDir, bookTitle, characterIds[]) to write — one entry per book. */
    const writes: Array<{ bookDir: string; bookId: string; bookTitle: string; ids: string[] }> = [];

    /* Source book: the source char + any in-group sibling rows in the same book. */
    const sourceIds = sourceCast.characters.filter((c) => inGroup(c, bookId)).map((c) => c.id);
    if (!sourceIds.includes(source.id)) sourceIds.push(source.id);
    writes.push({
      bookDir: sourceLocated.bookDir,
      bookId,
      bookTitle: sourceLocated.state.title,
      ids: sourceIds,
    });

    /* Series-mates (confirmed, same author+series, source book excluded). */
    const siblings = await scanSeriesFullCharactersForBookId(bookId);
    const byBook = new Map<string, { bookTitle: string; ids: string[] }>();
    for (const rec of siblings) {
      const cand = rec.character as PersistedCharacter;
      if (!inGroup(cand, rec.bookId)) continue;
      const entry = byBook.get(rec.bookId) ?? { bookTitle: rec.bookTitle, ids: [] };
      if (!entry.ids.includes(cand.id)) entry.ids.push(cand.id);
      byBook.set(rec.bookId, entry);
    }
    for (const [siblingBookId, { bookTitle, ids }] of byBook) {
      const located = await findBookByBookId(siblingBookId);
      if (!located) continue;
      writes.push({ bookDir: located.bookDir, bookId: siblingBookId, bookTitle, ids });
    }

    const updated: Array<{ bookId: string; bookTitle: string; characterId: string }> = [];
    const failed: Array<{ bookId: string; bookTitle: string; error: string }> = [];
    for (const w of writes) {
      try {
        const wrote = await applyToBook(w.bookDir, w.ids, canonicalVoiceId, source.voiceUuid, override);
        for (const id of wrote) {
          updated.push({ bookId: w.bookId, bookTitle: w.bookTitle, characterId: id });
        }
      } catch (err) {
        failed.push({
          bookId: w.bookId,
          bookTitle: w.bookTitle,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(
      `[voice-override-linked] source=${bookId}/${characterId} voiceId=${canonicalVoiceId} ` +
        `updated=${updated.length} failed=${failed.length}`,
    );

    return res.status(failed.length > 0 ? 207 : 200).json({ canonicalVoiceId, updated, failed });
  },
);

/* Set voiceId + the voice override on the given character ids in ONE book.
   Returns the ids actually written (present in that book's cast).

   fs-38 Wave 3c Task 4 — a series rebaseline is a designed-voice operation;
   silently repointing or clearing a CONSENTED CLONE is never correct (on
   qwen, dropping a cloned slot's libraryUuid makes the resolver fall back to
   the character's own voiceUuid — which this same write also unifies to the
   canonical one — so a completely different person's voice renders, with no
   error). Refuse the whole book's write, before touching anything, if any
   targeted character's slot would be removed (clear) or replaced (set) while
   carrying `provenance: 'cloned'`. A designed/imported slot rebaselines
   exactly as before.

   fs-38 Wave 3c, Task 20 fix round 1 (MINOR-1) — exported (was module-
   private) so `synthesise-chapter-cloned-resolver.test.ts`'s Task-4 mutator
   test can drive the REAL guard here directly (a temp bookDir with its own
   cast.json is enough — this function has no other dependency on the route's
   express req/res or the series-discovery scan above it), rather than
   re-stating `characterHasClonedSlot`/`hasClonedProvenance` next to a
   fixture built one line earlier — a tautology that stays green even if this
   function's guard collapsed onto the uuid-validating `clonedSlotForEngine`.

   fs-38 Wave 3c, Task 10a (consent-defect fix) — a SECOND, narrower guard
   below closes a gap the CRITICAL-2 guard above doesn't cover: `name` is a
   client string with no format validation (parseOverride only checks
   non-empty), and for a clone-capable engine a name shaped like THIS
   engine's OWN manifest-slot storage-key prefix (`manifestSlotFor(engine) +
   '-'`, e.g. 'xtts-' or 'qwen-') is not just a display label — per
   voice-mapping.ts's `pickVoiceForEngine`, once a target character's slot
   has no validated library uuid of its own, that raw name IS the literal
   storage key the sidecar loads a .pt/latents file from. A character whose
   slot is absent, or has a bare `libraryUuid` with no `provenance`, or
   `provenance:'designed'`/`'cloned'` with no usable `libraryUuid` (legacy
   drift), is unguarded by the CRITICAL-2 check above (which only fires on
   `provenance:'cloned'` WITH a validated uuid to compare) — so nothing
   stopped a planted `xtts-<someone-else's-uuid>` from reaching the sidecar
   and rendering that other person's real consented clone.

   Case fold, deliberately: the prefix test and both allow-arms below compare
   lower-cased strings. The sidecar builds `f"{safe}.pt"` and does
   `os.path.isfile` on it, and NTFS/APFS are case-insensitive — so
   `XTTS-<uuid>` on disk IS `xtts-<uuid>.pt`. A case-SENSITIVE `startsWith`
   check here would let `{engine:'coqui', name:'XTTS-<victimUuid>'}` sail
   past undetected (it doesn't start with lower-case 'xtts-') while still
   resolving to the victim's real artifact at render time — reintroducing
   the exact consent breach this guard exists to close, just one shift-key
   away. */
export async function applyToBook(
  bookDir: string,
  ids: string[],
  canonicalVoiceId: string,
  canonicalVoiceUuid: string | undefined,
  override: { engine: Engine; name: string } | null,
): Promise<string[]> {
  /* #1981 — the read is inside the lock; every guard/throw below (cloned-slot
     refusal, the reserved-prefix consent check) and the write are all
     decisions derived from it. */
  return withCastLock(bookDir, () => applyToBookLocked(bookDir, ids, canonicalVoiceId, canonicalVoiceUuid, override));
}

async function applyToBookLocked(
  bookDir: string,
  ids: string[],
  canonicalVoiceId: string,
  canonicalVoiceUuid: string | undefined,
  override: { engine: Engine; name: string } | null,
): Promise<string[]> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  if (!cast?.characters?.length) throw new Error('Cast on disk is empty');
  const want = new Set(ids);

  for (const c of cast.characters) {
    if (!want.has(c.id)) continue;
    /* fs-38 Wave 3c Task 4 CRITICAL-2 fix: this guard must test provenance
       ALONE, never the uuid-validating clonedSlotForEngine — a cloned slot
       with a missing/malformed libraryUuid is still a consented clone. A
       guard deciding whether to *preserve* a slot must fail safe (preserve
       when in doubt); only code that needs the uuid to resolve/derive/purge
       an artifact should validate it.

       GATE 2 I-B1 — the SET path used to narrow that to
       `hasClonedProvenance(c, override.engine)`: the engine BEING WRITTEN,
       and only that one. But the write below does not just fill a slot, it
       pins `next.ttsEngine = override.engine` — so a character cloned on the
       OTHER clone-capable engine passed the guard and was silently retargeted
       off its clone. The marker survived on disk and became inert:
       `resolveCharacterEngine` routes every one of that character's lines to
       the incoming engine's voice instead, with no error, no per-book `failed`
       entry, and no warning. Property 1's failure mode wearing a disguise —
       and flatly contrary to this guard's own message, which promises a
       series rebaseline "refuses to remove or replace it".

       So both paths now use the whole-character `characterHasClonedSlot`,
       which is exactly the predicate Task 6a used to close the identical
       engine-retarget shape in cast-link-prior.ts (there, `sourceIsCloned` /
       `targetIsCloned` veto the `ttsEngine` assignment as well as the
       denormalise). Refusing a cloned character's series rebaseline outright
       is the intended cost: a bulk propagation reaching a book the user isn't
       looking at is precisely where a silent mute lands unseen, and the
       refusal names the character and tells the user to reassign it
       directly. */
    const blocked = characterHasClonedSlot(c);
    if (blocked) {
      throw new Error(
        `Character "${c.name ?? c.id}" has a consented cloned voice — series rebaseline refuses to ` +
          `remove or replace it. Reassign the character directly instead.`,
      );
    }

    /* Task 10a — reject a planted clone/library storage key (see the
       function-level comment above). Only fires when `override.name` is
       actually shaped like THIS engine's reserved manifest-slot prefix
       (case-folded — see above); an ordinary display name (the common case
       — a designed voice's human-readable label, or a catalog name) is
       untouched: proven by the "ordinary display name … is untouched" test
       below, not just asserted here. Allowed when the name is provably this
       write's own already-consented identity (both comparisons case-folded
       for the same reason as the prefix test):
       (a) `c`'s OWN existing slot already resolves to that exact key via
       the uuid-validating `libraryVoiceForEngine` — structurally this is a
       no-op check: render always prefers the slot's OWN `libraryUuid` over
       `name` once one is set (see voice-mapping.ts), so `name` is inert
       here either way. This arm exists for defence-in-depth and matters
       once coqui voice-library propagation lands through this route — until
       then it is a deferred OVER-block: a client that deliberately restates
       a target's own already-consented key gets accepted, but nothing today
       exercises that path, or (b) it matches
       `cloneStorageKey(engine, canonicalVoiceUuid)` — canonicalVoiceUuid is
       READ from the SOURCE character's on-disk voiceUuid, not taken from
       this request's body. That is weaker than "server-controlled": nothing
       here stops a PRIOR request (e.g. `PUT /api/books/:bookId` with
       `slice:'cast'`, which persists the client's cast wholesale — voiceUuid
       is not in that route's `PRESERVED_DESIGN_FIELDS`) from having stamped
       an attacker-chosen voiceUuid onto the source first. That gap is
       real, is filed separately, and is NOT this guard's job to close — it
       already exists independently of this route (that same PUT writes
       `overrideTtsVoices` directly with no guard at all), so this fix still
       narrows a real path even though it doesn't close every path to
       `canonicalVoiceUuid`. What arm (b) DOES correctly authenticate is
       "this name matches what THIS series-unify call itself is about to
       stamp everywhere" — which is exactly how a bespoke (non-library) Qwen
       design's storage key legitimately propagates across a series via this
       route (rebaseline-modal.tsx's Approve step writes `{engine:'qwen',
       name: <voiceId returned by designQwenVoice>}` with no libraryUuid at
       all — the qwen branch of `pickVoiceForEngine` ignores `name` entirely
       when no libraryUuid is set, so this arm's role is authorisation, not
       resolution). Anything else is a foreign key — e.g.
       'xtts-<someone-else's-uuid>' (or a case-varied 'XTTS-<uuid>', folded
       away by the comparisons above) — that would otherwise render (and
       consent-breach) another person's real cloned artifact. */
    if (override !== null && isCloneEngine(override.engine)) {
      const engine = override.engine;
      const prefix = `${manifestSlotFor(engine)}-`; // manifestSlotFor already returns lower-case
      const nameLower = override.name.toLowerCase();
      if (nameLower.startsWith(prefix)) {
        const ownLib = libraryVoiceForEngine(c, engine);
        const matchesOwnLibrary =
          ownLib !== undefined &&
          nameLower === cloneStorageKey(engine, ownLib.libraryUuid).toLowerCase();
        const matchesCanonical =
          canonicalVoiceUuid !== undefined &&
          nameLower === cloneStorageKey(engine, canonicalVoiceUuid).toLowerCase();
        if (!matchesOwnLibrary && !matchesCanonical) {
          throw new Error(
            `Character "${c.name ?? c.id}" — refusing to write "${override.name}" as its ${engine} ` +
              `voice: it doesn't match this character's own consented voice.`,
          );
        }
      }
    }
  }

  const wrote: string[] = [];
  let dirty = false;
  cast.characters = cast.characters.map((c) => {
    if (!want.has(c.id)) return c;
    const next: PersistedCharacter = { ...c, voiceId: canonicalVoiceId };
    if (canonicalVoiceUuid) next.voiceUuid = canonicalVoiceUuid;
    if (override === null) {
      delete next.overrideTtsVoices;
    } else {
      /* Spread the existing slot (voices.ts:781's shape) so a re-baseline
         doesn't drop libraryUuid/provenance for a designed/imported voice —
         only `name` (and, for qwen, the resolver's storage key derived from
         it) is what this write is meant to change. */
      next.overrideTtsVoices = {
        ...(c.overrideTtsVoices ?? {}),
        [override.engine]: { ...(c.overrideTtsVoices?.[override.engine] ?? {}), name: override.name },
      };
      next.ttsEngine = override.engine;
    }
    delete next.overrideTtsVoice; // fold away the legacy singular field
    dirty = true;
    wrote.push(c.id);
    return next;
  });
  if (dirty) await writeJsonAtomic(castJsonPath(bookDir), cast);
  return wrote;
}

/* Cross-book match key, shared with plan-94 series-prior dedup +
   cast-series-patch. Plan 219 moved it to the Unicode-exact `normaliseNameKey`
   (was `[^a-z0-9]`, which erased Cyrillic). */
function normaliseToken(s: string | undefined): string {
  return normaliseNameKey(s);
}

function tokensFor(c: PersistedCharacter): Set<string> {
  const out = new Set<string>();
  const n = normaliseToken(c.name);
  if (n) out.add(n);
  for (const a of c.aliases ?? []) {
    const t = normaliseToken(a);
    if (t) out.add(t);
  }
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

function notLinkedToPair(c: PersistedCharacter, otherBookId: string, otherCharacterId: string): boolean {
  return (c.notLinkedTo ?? []).some(
    (p) => p.bookId === otherBookId && p.characterId === otherCharacterId,
  );
}
