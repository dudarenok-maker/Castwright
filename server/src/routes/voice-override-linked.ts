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
import { normaliseNameKey } from '../util/safe-id.js';
import { scanSeriesFullCharactersForBookId } from '../workspace/series-full-cast-scan.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const voiceOverrideLinkedRouter = Router();

type Engine = 'coqui' | 'gemini' | 'piper' | 'kokoro' | 'qwen';

/* cast.json carries fields the analyzer schema doesn't declare — widen here so
   the round-trip read/write preserves them. */
type PersistedCharacter = CharacterOutput & {
  voiceId?: string;
  overrideTtsVoices?: Partial<Record<Engine, { name: string }>>;
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
        const wrote = await applyToBook(w.bookDir, w.ids, canonicalVoiceId, override);
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
   Returns the ids actually written (present in that book's cast). */
async function applyToBook(
  bookDir: string,
  ids: string[],
  canonicalVoiceId: string,
  override: { engine: Engine; name: string } | null,
): Promise<string[]> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  if (!cast?.characters?.length) throw new Error('Cast on disk is empty');
  const want = new Set(ids);
  const wrote: string[] = [];
  let dirty = false;
  cast.characters = cast.characters.map((c) => {
    if (!want.has(c.id)) return c;
    const next: PersistedCharacter = { ...c, voiceId: canonicalVoiceId };
    if (override === null) {
      delete next.overrideTtsVoices;
    } else {
      next.overrideTtsVoices = { ...(c.overrideTtsVoices ?? {}), [override.engine]: { name: override.name } };
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
