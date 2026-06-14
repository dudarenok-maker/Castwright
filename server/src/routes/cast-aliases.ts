/* POST /api/books/:bookId/cast/unlink-alias
   POST /api/books/:bookId/cast/add-alias

   Symmetric chip-management for the Profile Drawer's "Also known as" row.
   Aliases get into a character via the fold step
   (server/src/analyzer/fold-minor-cast.ts) and via the manual merge route
   (cast-merge.ts), both of which append. There has been no reverse
   operation, which left the user with no recovery path when the auto-fold
   over-merged a real distinct cast member as an alias (e.g. "Garrow"
   folded into "Saltgrave Figure").

   The primary lineage path is deterministic: the per-book merge journal
   (`cast-merges.json`, srv-1) records the exact (chapterId, sentenceId)
   pairs each merge rewrote, so unlink reads that directly. The journal
   path falls back to the `chapterCast` heuristic (Phase-0a per-chapter
   raw roster, kept untouched across merges) only for pre-journal books,
   chained merges, and manual add-alias chips that never rewrote sentences
   (see `impactedChaptersFromJournal` / `impactedChaptersFromChapterCast`
   below). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath, manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { loadCastMerges } from '../store/cast-merges.js';
import { slug } from '../workspace/paths.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';

export const castAliasesRouter = Router();

interface CastFile {
  characters: CharacterOutput[];
}

interface EditsFile {
  sentences?: SentenceOutput[];
}

interface UnlinkBody {
  sourceCharacterId?: unknown;
  aliasName?: unknown;
}

interface AddBody {
  characterId?: unknown;
  aliasName?: unknown;
}

interface ImpactedChapter {
  chapterId: number;
  candidateSentenceIds: number[];
}

interface UnlinkResponse {
  /** The freshly-minted standalone character (the alias, now its own
      cast member). Frontend dispatches a delta reducer that prunes the
      alias from the source and appends this character — no need to
      round-trip the full cast for what is structurally a two-row edit. */
  newCharacter: CharacterOutput;
  /** Chapters containing sentences this alias's merge rewrote (journal
      path), or where it appeared in the Phase-0a roster (fallback path).
      Each chapter lists the IDs of sentences currently attributed to the
      source character — the candidates the user reviews + reattributes in
      the Reattribute Lines modal. */
  impactedChapters: ImpactedChapter[];
}

function normaliseAlias(s: unknown): string {
  return typeof s === 'string' ? s.trim() : '';
}

/* Make a fresh character id from the alias name, suffixing with -2, -3, …
   until it doesn't collide with an existing id in the cast. */
function mintCharacterId(name: string, existing: Set<string>): string {
  const base = slug(name);
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!existing.has(next)) return next;
  }
  /* 1000 collisions is absurd — fall back to a randomised suffix so the
     route never wedges on an unbounded loop. */
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

castAliasesRouter.post(
  '/:bookId/cast/unlink-alias',
  async (req: Request, res: Response<UnlinkResponse | { error: string }>) => {
    const { bookId } = req.params;
    const body = (req.body ?? {}) as UnlinkBody;
    const sourceCharacterId = normaliseAlias(body.sourceCharacterId);
    const aliasName = normaliseAlias(body.aliasName);

    if (!sourceCharacterId || !aliasName) {
      return res.status(400).json({ error: 'sourceCharacterId and aliasName are required.' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before editing aliases.',
      });
    }

    const sourceIdx = cast.characters.findIndex((c) => c.id === sourceCharacterId);
    if (sourceIdx === -1) {
      return res.status(404).json({ error: `Character "${sourceCharacterId}" not found.` });
    }
    const source = cast.characters[sourceIdx];
    const aliasKey = aliasName.toLowerCase();
    const aliasIdx = (source.aliases ?? []).findIndex((a) => a.trim().toLowerCase() === aliasKey);
    if (aliasIdx === -1) {
      return res.status(404).json({
        error: `Alias "${aliasName}" is not on character "${source.name}".`,
      });
    }

    /* Preserve the chip's display casing (not the lower-cased key) for the
       new character's name. */
    const displayName = (source.aliases ?? [])[aliasIdx];

    /* Strip the alias off the source. Filter rather than splice so we
       leave the source's array untouched in case other concurrent paths
       hold a reference. */
    const nextSourceAliases = (source.aliases ?? []).filter(
      (a) => a.trim().toLowerCase() !== aliasKey,
    );

    /* Synthesise the new standalone character. Field selection mirrors
       `makeBucket` from fold-minor-cast.ts: id, name, role, color,
       optional gender/ageRange inherited from the source so the voice
       picker has something to work with on day one. No description, no
       attributes, no tone — the user will fill those in via the drawer
       if it matters. No `aliases` (defaults to empty). */
    const existingIds = new Set(cast.characters.map((c) => c.id));
    const newCharacterId = mintCharacterId(displayName, existingIds);
    const newCharacter: CharacterOutput = {
      id: newCharacterId,
      name: displayName,
      role: 'character',
      color: 'narrator',
      aliases: [],
    };
    if (source.gender) newCharacter.gender = source.gender;
    if (source.ageRange) newCharacter.ageRange = source.ageRange;

    /* Build the updated character list: source with the trimmed aliases,
       new character appended at the end (consistent with mergeCharacters'
       append-on-new convention in cast-slice.ts). */
    const nextCharacters: CharacterOutput[] = cast.characters.map((c, i) =>
      i === sourceIdx ? { ...c, aliases: nextSourceAliases } : c,
    );
    nextCharacters.push(newCharacter);

    await writeJsonAtomic(castJsonPath(bookDir), { characters: nextCharacters });

    /* srv-1 — prefer the deterministic merge journal. A journal entry that
       records THIS alias (sourceName) being merged onto THIS character
       (targetId === sourceCharacterId) pins the exact sentences that merge
       rewrote. Fall back to the chapterCast heuristic for pre-journal books,
       chained merges, manual `add-alias` chips, and any alias produced by a
       path that never rewrote sentences (see store/cast-merges.ts header). */
    const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
    let impactedChapters = await impactedChaptersFromJournal(
      bookDir,
      sourceCharacterId,
      aliasKey,
      edits,
    );
    let lineageSource: 'journal' | 'fallback' = 'journal';
    if (!impactedChapters) {
      lineageSource = 'fallback';
      impactedChapters = await impactedChaptersFromChapterCast(
        state.manuscriptId,
        sourceCharacterId,
        edits,
        aliasKey,
      );
    }

    console.log(
      `[cast-aliases] book=${bookId} unlinked alias "${aliasName}" from ${sourceCharacterId}` +
        ` → ${newCharacterId} (${impactedChapters.length} impacted chapters, ${lineageSource})`,
    );

    return res.json({ newCharacter, impactedChapters });
  },
);

interface AddResponse {
  /** Echo of the alias addition so the frontend can dispatch a delta
      reducer instead of replacing the whole cast. Mirrors the shape
      cast-add-from-roster returns. */
  characterId: string;
  alias: string;
  /** True when the alias was already present (idempotent re-add) and the
      route was a no-op on disk. Lets the frontend distinguish "appended"
      from "already there" without parsing the cast.json mtime. */
  alreadyPresent: boolean;
}

castAliasesRouter.post(
  '/:bookId/cast/add-alias',
  async (req: Request, res: Response<AddResponse | { error: string }>) => {
    const { bookId } = req.params;
    const body = (req.body ?? {}) as AddBody;
    const characterId = normaliseAlias(body.characterId);
    const aliasName = normaliseAlias(body.aliasName);

    if (!characterId || !aliasName) {
      return res.status(400).json({ error: 'characterId and aliasName are required.' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before editing aliases.',
      });
    }

    const idx = cast.characters.findIndex((c) => c.id === characterId);
    if (idx === -1) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    const target = cast.characters[idx];
    /* Drop self-alias (matching the character's own name) and dedup
       case-insensitively against the existing aliases, mirroring the
       cast-merge.mergeAliases helper. */
    const key = aliasName.toLowerCase();
    if (key === target.name.trim().toLowerCase()) {
      return res.status(400).json({
        error: "Cannot add a character's own name as one of its aliases.",
      });
    }
    const existing = target.aliases ?? [];
    if (existing.some((a) => a.trim().toLowerCase() === key)) {
      /* Idempotent — no disk write, but echo the addition so the frontend
         can dispatch the same delta reducer regardless of whether the
         alias was already on the character. */
      return res.json({ characterId, alias: aliasName, alreadyPresent: true });
    }

    const nextCharacters = cast.characters.map((c, i) =>
      i === idx ? { ...c, aliases: [...existing, aliasName] } : c,
    );

    await writeJsonAtomic(castJsonPath(bookDir), { characters: nextCharacters });

    console.log(`[cast-aliases] book=${bookId} added alias "${aliasName}" to ${characterId}`);

    return res.json({ characterId, alias: aliasName, alreadyPresent: false });
  },
);

/* srv-1 — deterministic lineage from the merge journal. Returns null (→ caller
   falls back to chapterCast) when no entry matches OR when the matched entries
   carry no recorded sentences at all (a merge logged before stage-2
   attribution existed — ambiguous, so let the heuristic decide). When entries
   DO carry recorded sentences, returns the intersection with the lines still
   attributed to the source — even if that intersection is empty (the user
   already reattributed them; there is genuinely nothing left to surface). */
async function impactedChaptersFromJournal(
  bookDir: string,
  sourceCharacterId: string,
  aliasKey: string,
  edits: EditsFile | null,
): Promise<ImpactedChapter[] | null> {
  const journal = await loadCastMerges(bookDir);
  const matched = journal.entries.filter(
    (e) => e.targetId === sourceCharacterId && e.sourceName.trim().toLowerCase() === aliasKey,
  );
  if (matched.length === 0) return null;

  /* Union the recorded (chapterId, sentenceId) pairs, dedup on composite key. */
  const recorded = new Set<string>();
  for (const e of matched) {
    for (const a of e.affected) recorded.add(`${a.chapterId}:${a.sentenceId}`);
  }
  if (recorded.size === 0) return null; // ambiguous pre-stage-2 merge → fall back

  /* Intersect with sentences STILL attributed to the source (drops lines the
     user already reattributed, and any stale pair whose id no longer exists). */
  const byChapter = new Map<number, number[]>();
  for (const s of edits?.sentences ?? []) {
    if (s.characterId !== sourceCharacterId) continue;
    if (!recorded.has(`${s.chapterId}:${s.id}`)) continue;
    const list = byChapter.get(s.chapterId);
    if (list) list.push(s.id);
    else byChapter.set(s.chapterId, [s.id]);
  }
  return [...byChapter.keys()]
    .sort((a, b) => a - b)
    .map((chapterId) => ({
      chapterId,
      candidateSentenceIds: (byChapter.get(chapterId) ?? []).sort((a, b) => a - b),
    }));
}

/* Legacy heuristic (pre-srv-1 behaviour, unchanged): a chapter is "impacted"
   when its preserved Phase-0a chapterCast roster contained a character matching
   the alias name. Candidate sentences are the source-attributed lines in those
   chapters. Over-reports (the reason srv-1 exists), but it is the best lineage
   available when the journal has nothing for this alias. */
async function impactedChaptersFromChapterCast(
  manuscriptId: string,
  sourceCharacterId: string,
  edits: EditsFile | null,
  aliasKey: string,
): Promise<ImpactedChapter[]> {
  const cache = await loadAnalysisCache(manuscriptId);
  const impactedChapterIds = new Set<number>();
  if (cache.chapterCast) {
    for (const [rawId, roster] of Object.entries(cache.chapterCast)) {
      const chapterId = Number(rawId);
      if (!Number.isFinite(chapterId)) continue;
      for (const c of roster) {
        if (c.name.trim().toLowerCase() === aliasKey) {
          impactedChapterIds.add(chapterId);
          break;
        }
        if ((c.aliases ?? []).some((a) => a.trim().toLowerCase() === aliasKey)) {
          impactedChapterIds.add(chapterId);
          break;
        }
      }
    }
  }
  const byChapter = new Map<number, number[]>();
  for (const s of edits?.sentences ?? []) {
    if (s.characterId !== sourceCharacterId) continue;
    if (!impactedChapterIds.has(s.chapterId)) continue;
    const list = byChapter.get(s.chapterId);
    if (list) list.push(s.id);
    else byChapter.set(s.chapterId, [s.id]);
  }
  return [...impactedChapterIds]
    .sort((a, b) => a - b)
    .map((chapterId) => ({
      chapterId,
      candidateSentenceIds: (byChapter.get(chapterId) ?? []).sort((a, b) => a - b),
    }));
}
