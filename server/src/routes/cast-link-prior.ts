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

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { normaliseForMatch } from './analysis.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import type { TtsEngine } from '../tts/index.js';

export const castLinkPriorRouter = Router();

/* cast.json on disk carries voiceId + the bespoke-voice fields (written by
   the post-confirm pipeline / voice-design flow) even though the analyzer's
   CharacterOutput schema doesn't declare them. Widen the read shape here so
   the link-prior response can echo the target's voiceId back to the frontend
   AND so the link can denormalise the designed qwen voice onto the source. */
type PersistedCharacter = CharacterOutput & {
  voiceId?: string;
  ttsEngine?: TtsEngine | null;
  overrideTtsVoices?: Partial<Record<TtsEngine, { name: string }>> | null;
};
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
  const sourceCharacterId =
    typeof body.sourceCharacterId === 'string' ? body.sourceCharacterId.trim() : '';
  const targetBookId = typeof body.targetBookId === 'string' ? body.targetBookId.trim() : '';
  const targetCharacterId =
    typeof body.targetCharacterId === 'string' ? body.targetCharacterId.trim() : '';

  if (!sourceBookId || !sourceCharacterId || !targetBookId || !targetCharacterId) {
    return res.status(400).json({
      error:
        'bookId (path), sourceCharacterId, targetBookId, and targetCharacterId are all required.',
    });
  }
  if (sourceBookId === targetBookId) {
    return res.status(400).json({
      error:
        'targetBookId must differ from the path bookId — use POST /:bookId/cast/merge for in-book merges.',
    });
  }

  const sourceLocated = await findBookByBookId(sourceBookId);
  if (!sourceLocated)
    return res.status(404).json({ error: `Source book "${sourceBookId}" not found.` });
  const targetLocated = await findBookByBookId(targetBookId);
  if (!targetLocated)
    return res.status(404).json({ error: `Target book "${targetBookId}" not found.` });

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
    return res
      .status(409)
      .json({ error: 'Source book has no cast on disk yet. Run analysis before linking.' });
  }
  if (!targetCast?.characters?.length) {
    return res.status(409).json({ error: 'Target book has no cast on disk.' });
  }

  const source = sourceCast.characters.find((c) => c.id === sourceCharacterId);
  if (!source)
    return res.status(404).json({ error: `Source character "${sourceCharacterId}" not found.` });
  const target = targetCast.characters.find((c) => c.id === targetCharacterId);
  if (!target)
    return res.status(404).json({ error: `Target character "${targetCharacterId}" not found.` });

  /* Append source.name + source.aliases to target.aliases (case-insensitive
     dedup, drop target.name itself). The matcher uses these on future
     books to recognise either surface form. Skip the write entirely when
     no new alias would land — keeps the call idempotent on the disk side. */
  const nextAliases = appendAliases(target, source);
  const aliasesChanged = !arraysShallowEqual(target.aliases ?? [], nextAliases ?? []);

  if (aliasesChanged) {
    const mergedTarget: CharacterOutput = { ...target, aliases: nextAliases };
    const nextTargetCharacters = targetCast.characters.map((c) =>
      c.id === targetCharacterId ? mergedTarget : c,
    );
    await writeJsonAtomic(castJsonPath(targetLocated.bookDir), {
      characters: nextTargetCharacters,
    });
  }

  /* Unify the propagation key (plan 122). Aliases alone let the matcher
     RECOGNISE both surface forms, but they don't make the two rows share the
     series-override write key `voiceId ?? id` — so a later "Propose voices"
     approve would skip the source book. Stamp the source character's voiceId
     with the target's canonical key so a manual continuity link truly unifies
     them. Idempotent: skip the write when it already matches. */
  const canonicalVoiceId = target.voiceId ?? target.id;
  const voiceIdChanged = source.voiceId !== canonicalVoiceId;

  /* Denormalise the bespoke (qwen) voice onto the source at link time. A
     reused character whose own `overrideTtsVoices.qwen` is empty would
     otherwise resolve to '' at generation and fall back to Kokoro — the
     reused-voice consistency bug. Copying the target's designed voice (engine
     + override) here keeps the source's cast.json self-complete, so it no
     longer depends on read-time hydration. Only fills when the source lacks
     its own qwen voice and the target carries one; never clobbers an explicit
     source override. The persona (`voiceStyle`) rides along the same gate
     (srv-18) — copied from the target only when the source lacks its own, so
     the reused row carries the persona on disk without a backfill. */
  const sourceHasQwen = !!source.overrideTtsVoices?.qwen?.name;
  const targetQwen = target.overrideTtsVoices?.qwen?.name;
  const shouldDenormaliseVoice = !sourceHasQwen && !!targetQwen;

  /* Carry the prior character's PROFILE content onto the source at link time.
     A manual continuity link declares "these are the same person", so the
     reused row should inherit the canonical character's representative quotes
     and descriptors — not just its voice. Without this a roster-carried row
     (e.g. an The Floodmark "Dame Linnet" with zero of its own detected lines) stays
     blank after linking, which reads as "the link did nothing". Merge rules
     mirror the in-book merge (cast-merge.ts): union the list fields (evidence,
     attributes) source-first so the current book's own quotes lead, and
     fill-if-missing the scalar fields (description, tone, gender, ageRange) so
     a richer local profile is never clobbered. */
  const mergedEvidence = mergeEvidence(source.evidence, target.evidence);
  const mergedAttributes = unionStrings(source.attributes, target.attributes);
  const mergedDescription =
    source.description && source.description.trim() ? source.description : target.description;
  const mergedTone =
    source.tone || target.tone ? { ...target.tone, ...source.tone } : undefined;
  const mergedGender = source.gender ?? target.gender;
  const mergedAgeRange = source.ageRange ?? target.ageRange;

  const profileChanged =
    !evidenceEqual(source.evidence, mergedEvidence) ||
    !arraysShallowEqual(source.attributes ?? [], mergedAttributes ?? []) ||
    source.description !== mergedDescription ||
    source.gender !== mergedGender ||
    source.ageRange !== mergedAgeRange ||
    JSON.stringify(source.tone ?? null) !== JSON.stringify(mergedTone ?? null);

  if (voiceIdChanged || shouldDenormaliseVoice || profileChanged) {
    const mergedSource: PersistedCharacter = {
      ...source,
      voiceId: canonicalVoiceId,
      evidence: mergedEvidence,
      attributes: mergedAttributes,
      description: mergedDescription,
      tone: mergedTone,
      gender: mergedGender,
      ageRange: mergedAgeRange,
    };
    if (shouldDenormaliseVoice) {
      mergedSource.ttsEngine = source.ttsEngine ?? target.ttsEngine ?? 'qwen';
      mergedSource.overrideTtsVoices = {
        ...(target.overrideTtsVoices ?? {}),
        ...(source.overrideTtsVoices ?? {}),
      };
      mergedSource.voiceStyle = source.voiceStyle ?? target.voiceStyle;
    }
    const nextSourceCharacters = sourceCast.characters.map((c) =>
      c.id === sourceCharacterId ? mergedSource : c,
    );
    await writeJsonAtomic(castJsonPath(sourceLocated.bookDir), {
      characters: nextSourceCharacters,
    });
  }

  console.log(
    `[cast-link-prior] ${sourceBookId}/${sourceCharacterId} → ${targetBookId}/${targetCharacterId}` +
      (aliasesChanged ? ' (alias added)' : ' (no-op: alias already present)') +
      (voiceIdChanged ? ` (voiceId → ${canonicalVoiceId})` : '') +
      (profileChanged ? ' (merged profile)' : ''),
  );

  return res.json({
    matchedFrom: {
      bookId: targetBookId,
      characterId: targetCharacterId,
      bookTitle: targetLocated.state.title,
      confidence: 1,
    },
    voiceId: canonicalVoiceId,
    /* Echo the merged profile so the frontend updates the open drawer +
       redux without a reload. Only present when something changed. */
    profile: profileChanged
      ? {
          evidence: mergedEvidence,
          attributes: mergedAttributes,
          description: mergedDescription,
          tone: mergedTone,
          gender: mergedGender,
          ageRange: mergedAgeRange,
        }
      : undefined,
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

/* Union two evidence (representative-quote) lists, source-first, dedup on
   normalised quote text so smart/straight-quote variants don't double up.
   Mirrors cast-merge.ts::mergeEvidence — inlined to keep this route file
   self-contained (same rationale as appendAliases above). */
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

/* True when two evidence lists carry the same set of normalised quotes
   (order-insensitive) — used to detect a no-op profile merge. */
function evidenceEqual(
  a: CharacterOutput['evidence'] | undefined,
  b: CharacterOutput['evidence'] | undefined,
): boolean {
  const keys = (e: CharacterOutput['evidence'] | undefined) =>
    new Set((e ?? []).map((x) => normaliseForMatch(x.quote)).filter(Boolean));
  const ka = keys(a);
  const kb = keys(b);
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}

/* Union two string lists, source-first, lower-case dedup, preserving
   first-seen casing. Mirrors cast-merge.ts::unionStrings. */
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
