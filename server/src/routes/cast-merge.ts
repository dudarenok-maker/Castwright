/* POST /api/books/:bookId/cast/merge

   Resolves an analyzer-duplicate cast entry by folding `sourceId` into
   `targetId`. The duplicate ("Wren") disappears and its name is added
   to the survivor's ("Wren Sparrow") `aliases` list so the matcher can
   recognise the same person when later books in the series detect the
   character under either form.

   Touches three persisted files (atomic-rename each):
     1. cast.json                 — drop source, merge fields onto target
     2. manuscript-edits.json     — sentences[characterId=sourceId] → targetId
     3. .audiobook/analysis-cache — stage1.characters + per-chapter sentences

   We deliberately do NOT touch `chapterCast` (the raw per-chapter LLM
   outputs). Those are historical record and would re-introduce the source
   id only on a `fresh: true` re-analysis, which clears the whole cache
   anyway. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath, manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { loadAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { normaliseForMatch } from './analysis.js';
import { makeBucket, MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';

export const castMergeRouter = Router();

/* Same shape as cast.json on disk — Character[] with the same fields the
   frontend's Character type uses. We don't validate via Zod here because
   the file has already been through the analyzer-side validator and the
   merge is field-level only. */
interface CastFile {
  characters: CharacterOutput[];
}

interface EditsFile {
  sentences?: SentenceOutput[];
}

interface MergeBody {
  sourceId?: unknown;
  targetId?: unknown;
}

castMergeRouter.post('/:bookId/cast/merge', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const body = (req.body ?? {}) as MergeBody;
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';

  if (!sourceId || !targetId) {
    return res.status(400).json({ error: 'sourceId and targetId are required.' });
  }
  if (sourceId === targetId) {
    return res.status(400).json({ error: 'sourceId and targetId must differ.' });
  }

  const located = await findBookByBookId(bookId);
  if (!located) return res.status(404).json({ error: 'Book not found.' });
  const { bookDir, state } = located;

  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  if (!cast?.characters?.length) {
    return res
      .status(409)
      .json({ error: 'Book has no cast on disk yet. Run analysis before merging characters.' });
  }

  const source = cast.characters.find((c) => c.id === sourceId);
  let target = cast.characters.find((c) => c.id === targetId);
  if (!source) return res.status(404).json({ error: `Character "${sourceId}" not found.` });
  /* Downgrade-to-bucket path: when the caller targets one of the standing
     `unknown-male` / `unknown-female` buckets and that bucket doesn't yet
     exist in cast.json (the book had no auto-folded background speakers),
     synthesise it on the fly using the same factory the analyser's
     post-stage-2 fold uses. Keeps the manual downgrade UI from having to
     special-case "book has never had a background voice before". */
  let createdBucket: CharacterOutput | null = null;
  if (!target && (targetId === MALE_BUCKET_ID || targetId === FEMALE_BUCKET_ID)) {
    createdBucket = makeBucket(targetId, targetId === MALE_BUCKET_ID ? 'male' : 'female');
    cast.characters.push(createdBucket);
    target = createdBucket;
  }
  if (!target) return res.status(404).json({ error: `Character "${targetId}" not found.` });

  /* Build the merged target. Field rules mirror mergeRosterChapter, with
     two twists for the manual-merge case:
       - aliases: target's existing + source's name + source's existing,
         deduped on lower-case. Captures the human's intent ("these are the
         same person") so the matcher can use it later.
       - lines/scenes: recomputed below once we know the remapped sentence
         set. Stored on the merged Character at the end. */
  const merged: CharacterOutput = { ...target };

  /* Aliases — keep target's, then source.name (the new alias), then
     anything source had already learned. Drop target.name itself (no point
     listing a name as its own alias) and dedup case-insensitively. */
  merged.aliases = mergeAliases(target, source);

  /* Description: longer wins. The longer one usually carries more context. */
  if (
    source.description &&
    (!target.description || source.description.length > target.description.length)
  ) {
    merged.description = source.description;
  }

  /* Attributes: union, case-insensitive dedup. Target order first. */
  merged.attributes = unionStrings(target.attributes, source.attributes);

  /* Evidence: union, dedup on normalised quote text. */
  merged.evidence = mergeEvidence(target.evidence, source.evidence);

  /* Tone: target wins per field; missing fields filled from source. */
  if (source.tone || target.tone) {
    merged.tone = { ...source.tone, ...target.tone };
  }

  /* Identity fields: only adopt source's value when target lacks one. */
  if (!merged.gender && source.gender) merged.gender = source.gender;
  if (!merged.ageRange && source.ageRange) merged.ageRange = source.ageRange;

  /* Filter source out of the cast (in-place build for stable order). */
  const nextCharacters: CharacterOutput[] = [];
  for (const c of cast.characters) {
    if (c.id === sourceId) continue;
    nextCharacters.push(c.id === targetId ? merged : c);
  }

  /* Remap sentence attributions in manuscript-edits.json. The edits file
     is the authoritative per-sentence record once stage 2 has completed —
     we rewrite it first so the lines/scenes recompute below sees the new
     state. */
  const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
  let editsTouched = false;
  let editsAfter: SentenceOutput[] | null = null;
  if (edits?.sentences?.length) {
    let changed = 0;
    editsAfter = edits.sentences.map((s) => {
      if (s.characterId === sourceId) {
        changed += 1;
        return { ...s, characterId: targetId };
      }
      return s;
    });
    if (changed > 0) {
      editsTouched = true;
      await writeJsonAtomic(manuscriptEditsJsonPath(bookDir), { sentences: editsAfter });
    }
  }

  /* Recompute lines / scenes on the merged character from the up-to-date
     sentence list. Avoids the over-count that a naive sum produces when
     the same chapter contained both ids. */
  if (editsAfter?.length) {
    let lines = 0;
    const scenes = new Set<number>();
    for (const s of editsAfter) {
      if (s.characterId === targetId) {
        lines += 1;
        scenes.add(s.chapterId);
      }
    }
    merged.lines = lines;
    merged.scenes = scenes.size;
  } else {
    /* No edits on disk — best effort: sum lines, sum scenes (will
       over-count if they overlapped, but that recomputes the moment
       stage 2 lands). */
    merged.lines = (target.lines ?? 0) + (source.lines ?? 0);
    merged.scenes = (target.scenes ?? 0) + (source.scenes ?? 0);
  }

  await writeJsonAtomic(castJsonPath(bookDir), { characters: nextCharacters });

  /* Analysis cache update — stage1.characters AND per-chapter sentences.
     The cache is what the route replays on resume, so leaving the source
     in here would reintroduce the duplicate as soon as the user clicks
     "resume" after a network blip. */
  let cacheTouched = false;
  const cache = await loadAnalysisCache(state.manuscriptId);
  if (cache.stage1?.characters?.length) {
    const before = cache.stage1.characters.length;
    let next = cache.stage1.characters
      .filter((c) => c.id !== sourceId)
      .map((c) => (c.id === targetId ? merged : c));
    /* Auto-created bucket: the cache wouldn't have known about it yet, so
       append the merged entry so a Phase-1 cache replay sees the same
       roster as cast.json. */
    if (createdBucket && !next.some((c) => c.id === targetId)) {
      next = [...next, merged];
      cacheTouched = true;
    }
    if (next.length !== before) cacheTouched = true;
    cache.stage1.characters = next;
  }
  if (cache.chapters) {
    for (const [chapterId, sentences] of Object.entries(cache.chapters)) {
      let chChanged = false;
      const remapped = sentences.map((s) => {
        if (s.characterId === sourceId) {
          chChanged = true;
          return { ...s, characterId: targetId };
        }
        return s;
      });
      if (chChanged) {
        cache.chapters[Number(chapterId)] = remapped;
        cacheTouched = true;
      }
    }
  }
  if (cacheTouched) {
    await saveAnalysisCache(state.manuscriptId, cache);
  }

  console.log(
    `[cast-merge] book=${bookId} merged ${sourceId} → ${targetId}` +
      (editsTouched ? ' (remapped sentences)' : '') +
      (cacheTouched ? ' (rewrote cache)' : ''),
  );

  return res.json({ characters: nextCharacters });
});

/* Build the merged aliases list. Lower-case dedup, target first, then the
   source's name, then any aliases the source had already accumulated. The
   target's own name is filtered out so a self-alias never appears. */
function mergeAliases(target: CharacterOutput, source: CharacterOutput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed.toLowerCase() === target.name.trim().toLowerCase()) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const a of target.aliases ?? []) push(a);
  push(source.name);
  for (const a of source.aliases ?? []) push(a);
  return out;
}

/* Union two evidence lists, dedup on normalised quote so smart/straight
   quote variants don't double up. Mirrors mergeRosterChapter's behaviour. */
function mergeEvidence(
  a: CharacterOutput['evidence'] | undefined,
  b: CharacterOutput['evidence'] | undefined,
): CharacterOutput['evidence'] {
  if (!a?.length && !b?.length) return undefined;
  const seen = new Set<string>();
  const out: NonNullable<CharacterOutput['evidence']> = [];
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const norm = normaliseForMatch(e.quote);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ ...e });
  }
  return out.length ? out : undefined;
}

/* Union two string lists, lower-case dedup, preserving first-seen order
   and casing. */
function unionStrings(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length ? out : undefined;
}
