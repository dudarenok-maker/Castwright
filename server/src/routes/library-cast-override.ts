/* POST /api/library-cast/override

   Symmetric "best-of-both" profile merge across two books that the voice
   matcher linked together. After the call both cast.json files (the
   source book the user is confirming + the target library book it matched
   against) carry the same merged identity-level profile, while each book
   retains its own audio identity and per-book metrics.

   Use case: a novella first met Oduvan in passing; a later full novel has
   208 lines and 7 scenes of him. The user is on the full novel's confirm
   page, has picked "Reuse" so the new book uses the novella's voice, and
   ticks the override checkbox. Result: both books' cast.json entries gain
   the richer description, attributes, and aliases (longest description
   wins; attributes / aliases unioned). Future books in the series score
   against either side's better data; the novella's own profile no longer
   looks anaemic when the user revisits it.

   Per-field rules (same on both sides):
     - description: longest string wins. The merge fully replaces both
       sides' descriptions with the same winning string.
     - attributes: union, source-first ordering, case-insensitive dedup.
     - role, gender, ageRange: prefer non-empty; source wins on conflict
       (the user invoked the action from the source book — explicit signal
       of trust). If source lacks a value, target's value survives.
     - tone: per-field merge — fill in missing fields from either side;
       on conflict prefer source.
     - aliases: union of (target's aliases ∪ source's aliases ∪ target.name
       ∪ source.name). Each side then drops its OWN name from the list so
       no record self-aliases.

   Fields each side PRESERVES from its own record:
     - id, voiceId, color, name, voiceState — audio identity must not
       change; the already-generated chapter audio in either book is tied
       to voiceId, and the matcher's alias contract works on name.
     - lines, scenes, evidence — per-book metrics + per-book quotes don't
       port across manuscripts (the source's quotes are from the source's
       text and wouldn't resolve against the target's, and vice versa).

   manuscript-edits.json + analysis-cache on either side are NOT touched
   — those reference characters by id, which is preserved. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const libraryCastOverrideRouter = Router();

interface CastFile {
  characters: CharacterOutput[];
}

interface OverrideBody {
  sourceBookId?: unknown;
  sourceCharacterId?: unknown;
  targetBookId?: unknown;
  targetCharacterId?: unknown;
}

libraryCastOverrideRouter.post('/library-cast/override', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as OverrideBody;
  const sourceBookId = typeof body.sourceBookId === 'string' ? body.sourceBookId.trim() : '';
  const sourceCharacterId =
    typeof body.sourceCharacterId === 'string' ? body.sourceCharacterId.trim() : '';
  const targetBookId = typeof body.targetBookId === 'string' ? body.targetBookId.trim() : '';
  const targetCharacterId =
    typeof body.targetCharacterId === 'string' ? body.targetCharacterId.trim() : '';

  if (!sourceBookId || !sourceCharacterId || !targetBookId || !targetCharacterId) {
    return res.status(400).json({
      error:
        'sourceBookId, sourceCharacterId, targetBookId, and targetCharacterId are all required.',
    });
  }
  if (sourceBookId === targetBookId && sourceCharacterId === targetCharacterId) {
    return res.status(400).json({ error: 'Source and target must differ — nothing to override.' });
  }

  const sourceLocated = await findBookByBookId(sourceBookId);
  if (!sourceLocated)
    return res.status(404).json({ error: `Source book "${sourceBookId}" not found.` });
  const targetLocated = await findBookByBookId(targetBookId);
  if (!targetLocated)
    return res.status(404).json({ error: `Target book "${targetBookId}" not found.` });

  const sourceCast = await readJson<CastFile>(castJsonPath(sourceLocated.bookDir));
  const targetCast = await readJson<CastFile>(castJsonPath(targetLocated.bookDir));
  if (!sourceCast?.characters?.length) {
    return res.status(409).json({ error: 'Source book has no cast on disk.' });
  }
  if (!targetCast?.characters?.length) {
    return res.status(409).json({ error: 'Target book has no cast on disk.' });
  }

  const source = sourceCast.characters.find((c) => c.id === sourceCharacterId);
  const target = targetCast.characters.find((c) => c.id === targetCharacterId);
  if (!source)
    return res.status(404).json({ error: `Source character "${sourceCharacterId}" not found.` });
  if (!target)
    return res.status(404).json({ error: `Target character "${targetCharacterId}" not found.` });

  /* Identity-level fields are merged ONCE — both books end up with these
     identical values. Per-book audio + metric fields are then applied
     when each side's record is composed. */
  const sharedDescription = longest(source.description, target.description);
  const sharedRole = preferSource(source.role, target.role);
  const sharedGender = preferSource(source.gender, target.gender);
  const sharedAgeRange = preferSource(source.ageRange, target.ageRange);
  const sharedTone = mergeTone(source.tone, target.tone);
  const sharedAttributes = unionStrings(source.attributes, target.attributes);

  /* Aliases — union of the full pool of name forms across both sides
     (each side's aliases plus the other side's name). Each side then
     drops its OWN name from the list so no record self-aliases. Same
     shape as the manual-merge alias contract; the matcher uses these on
     future books. */
  const aliasPool = collectAliasPool(source, target);
  const mergedSource: CharacterOutput = {
    ...source,
    description: sharedDescription ?? source.description,
    role: sharedRole ?? source.role,
    gender: sharedGender,
    ageRange: sharedAgeRange,
    tone: sharedTone,
    attributes: sharedAttributes,
    aliases: aliasesExcludingSelf(aliasPool, source.name),
  };
  const mergedTarget: CharacterOutput = {
    ...target,
    description: sharedDescription ?? target.description,
    role: sharedRole ?? target.role,
    gender: sharedGender,
    ageRange: sharedAgeRange,
    tone: sharedTone,
    attributes: sharedAttributes,
    aliases: aliasesExcludingSelf(aliasPool, target.name),
  };

  const nextSourceCharacters = sourceCast.characters.map((c) =>
    c.id === sourceCharacterId ? mergedSource : c,
  );
  const nextTargetCharacters = targetCast.characters.map((c) =>
    c.id === targetCharacterId ? mergedTarget : c,
  );

  /* Write both sides. Atomic-rename each — if the target write fails
     after the source write succeeded, re-running the call is safe: the
     merge is deterministic and re-merging already-merged records yields
     the same fixed point. */
  await writeJsonAtomic(castJsonPath(sourceLocated.bookDir), { characters: nextSourceCharacters });
  await writeJsonAtomic(castJsonPath(targetLocated.bookDir), { characters: nextTargetCharacters });

  console.log(
    `[library-cast-override] ${sourceBookId}/${sourceCharacterId} ⇄ ${targetBookId}/${targetCharacterId}`,
  );

  return res.json({ source: mergedSource, target: mergedTarget });
});

/* Longest non-empty string wins. Same rule cast-merge.ts uses inside one
   book — applied symmetrically here so neither side loses a richer
   description it already had. */
function longest(a: string | undefined, b: string | undefined): string | undefined {
  const av = a?.trim() ?? '';
  const bv = b?.trim() ?? '';
  if (!av && !bv) return undefined;
  if (!av) return b;
  if (!bv) return a;
  return av.length >= bv.length ? a : b;
}

/* Prefer source's value when both sides have one; fall back to target's
   when source is empty. Used for the structured identity fields where
   "longest wins" doesn't make sense. The user invoked the override from
   the source book — that's the side they're signalling trust in. */
function preferSource<T extends string | undefined>(source: T, target: T): T {
  if (source && String(source).trim()) return source;
  return target;
}

/* Tone is a {warmth, pace, authority, emotion} bag of optional 0–100
   numbers. Merge per-field: source wins on conflict, target fills in
   what source lacks. Returns undefined when both sides are empty so the
   field stays absent on output (matches the analyzer's tone-optional
   convention). */
function mergeTone(
  a: CharacterOutput['tone'] | undefined,
  b: CharacterOutput['tone'] | undefined,
): CharacterOutput['tone'] {
  if (!a && !b) return undefined;
  return { ...(b ?? {}), ...(a ?? {}) };
}

/* Union two string lists, case-insensitive dedup, preserving the first
   list's order and casing. Identical shape to cast-merge.ts's helper —
   inlined here to keep this route file self-contained. */
function unionStrings(
  primary: string[] | undefined,
  secondary: string[] | undefined,
): string[] | undefined {
  if (!primary?.length && !secondary?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(primary ?? []), ...(secondary ?? [])]) {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length ? out : undefined;
}

/* The full pool of name forms both sides should know about: target's
   aliases, then source.name, then source's aliases, then target.name.
   Each side's final aliases list is this pool with its OWN name removed
   (see `aliasesExcludingSelf`). Order seeds the matcher's tie-breaking
   so the order matters — target-side first so existing match-detail
   modals keep the same canonical surface form. */
function collectAliasPool(source: CharacterOutput, target: CharacterOutput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string | undefined) => {
    if (!s) return;
    const trimmed = s.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const a of target.aliases ?? []) push(a);
  push(source.name);
  for (const a of source.aliases ?? []) push(a);
  push(target.name);
  return out;
}

/* From the full alias pool, drop entries that equal the supplied "own
   name" (case-insensitive) — a record never aliases itself. Returns
   undefined when the resulting list would be empty so the field stays
   absent on the output character. */
function aliasesExcludingSelf(pool: string[], ownName: string): string[] | undefined {
  const own = ownName.trim().toLowerCase();
  const out = pool.filter((s) => s.trim().toLowerCase() !== own);
  return out.length ? out : undefined;
}
