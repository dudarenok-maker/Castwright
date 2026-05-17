/* POST /api/books/:bookId/cast/link-prior

   Manual continuity link: the user has just declared "this character in
   my current book is the same person as that character from a prior
   book in the same series." Complements the auto-matcher
   (POST /api/books/:bookId/voice-match) — used when the name-score
   floor in voice-match.ts dropped a legitimate match (e.g.
   "Hartwell Brennan Vale" vs "Hart" — token Jaccard is 0, so the matcher
   never surfaced the candidate).

   Side effect (the durable bit): the SOURCE character's name (and any
   of its aliases) is appended to the TARGET character's aliases list
   in the prior book's cast.json (atomic-rename). Case-insensitive
   dedup, target's own name filtered out — same alias contract as the
   in-book merge (server/src/routes/cast-merge.ts::mergeAliases). On a
   future voice-match run for any book in the series, the matcher's
   alias-aware name score will now hit because the prior record carries
   both surface forms.

   Response shape: { matchedFrom: { bookId, characterId, bookTitle,
   confidence: 1 }, voiceId }. The frontend dispatches a single-row
   castActions.applyManualMatch with this payload so the "Continuity
   preserved" footer + "Sync profile" checkbox light up on the source
   book's confirm card, identical to the auto-match flow.

   Guard: targetBookId must share (author, series) with the source book
   and neither side may be a standalone. Cross-series linking is out of
   scope (same boundary plan 09 / series-cast-scan.ts call out). */

import { Router, type Request, type Response } from 'express';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castLinkPriorRouter = Router();

/* cast.json on disk carries voiceId (written by the post-confirm
   pipeline) even though the analyzer's CharacterOutput schema doesn't
   declare it. Widen the read shape here so the link-prior response can
   echo the target's voiceId back to the frontend. */
type PersistedCharacter = CharacterOutput & { voiceId?: string };
interface CastFile {
  characters: PersistedCharacter[];
}

interface LinkPriorBody {
  sourceCharacterId?: unknown;
  targetBookId?: unknown;
  targetCharacterId?: unknown;
}

castLinkPriorRouter.post('/:bookId/cast/link-prior', async (req: Request, res: Response) => {
  const sourceBookId = req.params.bookId;
  const body = (req.body ?? {}) as LinkPriorBody;
  const sourceCharacterId = typeof body.sourceCharacterId === 'string' ? body.sourceCharacterId.trim() : '';
  const targetBookId      = typeof body.targetBookId      === 'string' ? body.targetBookId.trim()      : '';
  const targetCharacterId = typeof body.targetCharacterId === 'string' ? body.targetCharacterId.trim() : '';

  if (!sourceBookId || !sourceCharacterId || !targetBookId || !targetCharacterId) {
    return res.status(400).json({
      error: 'bookId (path), sourceCharacterId, targetBookId, and targetCharacterId are all required.',
    });
  }
  if (sourceBookId === targetBookId) {
    return res.status(400).json({
      error: 'targetBookId must differ from the path bookId — use POST /:bookId/cast/merge for in-book merges.',
    });
  }

  const sourceLocated = await findBookByBookId(sourceBookId);
  if (!sourceLocated) return res.status(404).json({ error: `Source book "${sourceBookId}" not found.` });
  const targetLocated = await findBookByBookId(targetBookId);
  if (!targetLocated) return res.status(404).json({ error: `Target book "${targetBookId}" not found.` });

  /* Series-scope guard: same author + series, neither standalone.
     Mirrors the filter scanSeriesCharactersForBookId applies, so the
     frontend's dropdown and the server's accept-set stay aligned. */
  if (
    sourceLocated.state.author !== targetLocated.state.author ||
    sourceLocated.state.series !== targetLocated.state.series ||
    sourceLocated.state.isStandalone === true ||
    targetLocated.state.isStandalone === true
  ) {
    return res.status(404).json({
      error: 'Target book is not a series-mate of the source book.',
    });
  }

  const sourceCast = await readJson<CastFile>(castJsonPath(sourceLocated.bookDir));
  const targetCast = await readJson<CastFile>(castJsonPath(targetLocated.bookDir));
  if (!sourceCast?.characters?.length) {
    return res.status(409).json({ error: 'Source book has no cast on disk yet. Run analysis before linking.' });
  }
  if (!targetCast?.characters?.length) {
    return res.status(409).json({ error: 'Target book has no cast on disk.' });
  }

  const source = sourceCast.characters.find(c => c.id === sourceCharacterId);
  if (!source) return res.status(404).json({ error: `Source character "${sourceCharacterId}" not found.` });
  const target = targetCast.characters.find(c => c.id === targetCharacterId);
  if (!target) return res.status(404).json({ error: `Target character "${targetCharacterId}" not found.` });

  /* Append source.name + source.aliases to target.aliases (case-insensitive
     dedup, drop target.name itself). The matcher uses these on future
     books to recognise either surface form. Skip the write entirely when
     no new alias would land — keeps the call idempotent on the disk side. */
  const nextAliases = appendAliases(target, source);
  const aliasesChanged = !arraysShallowEqual(target.aliases ?? [], nextAliases ?? []);

  if (aliasesChanged) {
    const mergedTarget: CharacterOutput = { ...target, aliases: nextAliases };
    const nextTargetCharacters = targetCast.characters.map(c =>
      c.id === targetCharacterId ? mergedTarget : c,
    );
    await writeJsonAtomic(castJsonPath(targetLocated.bookDir), { characters: nextTargetCharacters });
  }

  console.log(
    `[cast-link-prior] ${sourceBookId}/${sourceCharacterId} → ${targetBookId}/${targetCharacterId}` +
    (aliasesChanged ? ' (alias added)' : ' (no-op: alias already present)'),
  );

  return res.json({
    matchedFrom: {
      bookId: targetBookId,
      characterId: targetCharacterId,
      bookTitle: targetLocated.state.title,
      confidence: 1,
    },
    voiceId: target.voiceId,
  });
});

/* Build the aliases list to write back on target. Identical to
   cast-merge.ts::mergeAliases in spirit: target's existing aliases
   first, then source.name (the new alias to learn), then source's
   existing aliases. Drop target.name (no self-aliases). Lower-case
   dedup. Inlined rather than imported so this route file stays
   self-contained — see plan 09 §Manual continuity link for the
   shared-helper extraction note. */
function appendAliases(target: CharacterOutput, source: CharacterOutput): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  const ownName = target.name.trim().toLowerCase();
  const push = (name: string | undefined) => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (key === ownName) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const a of target.aliases ?? []) push(a);
  push(source.name);
  for (const a of source.aliases ?? []) push(a);
  return out.length ? out : undefined;
}

function arraysShallowEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
