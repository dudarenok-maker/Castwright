/* Pure transforms for chapter restructure (merge / split / reorder).
   No I/O — the route handler is responsible for reading + writing files
   based on the result objects this module produces.

   See docs/features/51-restructure-chapters.md for the design contract.

   Output shape covers four downstream layers in one pass:
   - state.chapters (slug regen + audioModelKey/audioRenderedAt clearing
     for content-changed chapters, preserved for renumbered-only)
   - in-memory ChapterHint[] (bodies + new positional ids)
   - sentences (chapterId rewritten + per-chapter id renumbered)
   - audioOps (delete for content-changed, rename for renumbered-only)
   plus a sentence remap the route returns to the frontend so it can
   update its manuscript-slice without re-fetching the whole list. */

import { slug } from './paths.js';
import type { BookStateJson } from './scan.js';
import type { ChapterHint } from '../store/manuscripts.js';

/** Shape of one row in manuscript-edits.json. Extra fields pass through
    untouched — sentences may carry confidence/startMs/endMs etc. that
    aren't structural and shouldn't be lost on a remap. */
export interface RestructureSentence {
  id: number;
  chapterId: number;
  characterId: string;
  text: string;
  [extra: string]: unknown;
}

export interface SentenceRemap {
  oldChapterId: number;
  oldSentenceId: number;
  newChapterId: number;
  newSentenceId: number;
}

/** Audio file lifecycle op the route handler applies via
    `rewriteChapterSlugs` after the structural write succeeds. */
export type AudioOp =
  | { kind: 'delete'; from: string }
  | {
      kind: 'rename';
      from: string;
      to: string;
      newChapterId: number;
      newChapterTitle: string;
    };

export interface RestructureResult {
  state: BookStateJson;
  hints: ChapterHint[];
  sentences: RestructureSentence[];
  remap: SentenceRemap[];
  audioOps: AudioOp[];
  /** Non-fatal advisories surfaced to the caller: orphan-sentence
      recovery counts, empty-chapter prune counts, generic-title
      renumber counts. Empty when the operation was clean. */
  warnings: string[];
}

export interface MergeOp {
  chapterIds: number[];
  mergedTitle?: string;
}

export interface SplitOp {
  chapterId: number;
  afterSentenceId: number;
  newTitle?: string;
}

export interface ReorderOp {
  order: number[];
}

/* -- helpers -------------------------------------------------------- */

function chapterSlug(id: number, title: string): string {
  return `${String(id).padStart(2, '0')}-${slug(title)}`;
}

function sortById<T extends { id: number }>(arr: readonly T[]): T[] {
  return [...arr].sort((a, b) => a.id - b.id);
}

/** Map each surviving old chapter id to its new id (one-to-one or
    many-to-one for merge). Chapters that vanished entirely (merged
    INTO another id) still appear in the map but pointed at the
    survivor — callers can use that to attribute their audio to the
    right delete op. */
interface OldChapterFate {
  oldId: number;
  newId: number;
  contentChanged: boolean;
  /** For split: when the user splits chapter C after sentence K, sentences
      with id > K move to the second half. This index lets the sentence
      remap below know where to switch. */
  splitAfterSentenceId?: number;
  /** For split's second half: the new chapter id for sentences > splitAfterSentenceId. */
  splitSecondHalfNewId?: number;
}

/** Build the new sentence list + remap from old sentences + a fate map.
    Per-chapter sentence ids are renumbered 1..N within each new chapter,
    in the same order they appeared within the old chapter. Merge folds
    multiple old chapters' sentences into one new chapter, with sentence
    ids assigned in the order the merged chapters appeared.

    Orphan handling: sentences whose `chapterId` is not present in
    `oldChapterIdOrder` (stale data from a prior corrupt restructure)
    are recovered by re-attaching to the nearest preceding surviving
    chapter (lowest known id ≤ orphan's chapterId; falls back to the
    smallest known id when no preceding survivor exists). This replaces
    the previous silent-skip behaviour that caused intermittent data
    loss visible as empty end-of-list chapters after sequential merges. */
function remapSentences(
  oldSentences: readonly RestructureSentence[],
  fates: Map<number, OldChapterFate>,
  /** Order of old chapter ids in which to assign sentence-ids inside any
      merged new chapter. Merge wants them concatenated in original
      narrative order. */
  oldChapterIdOrder: readonly number[],
): { sentences: RestructureSentence[]; remap: SentenceRemap[]; warnings: string[] } {
  const warnings: string[] = [];
  const knownIds = new Set(oldChapterIdOrder);
  const sortedKnownIds = [...knownIds].sort((a, b) => a - b);

  // First pass: re-attach orphans (sentences whose chapterId is not in
  // oldChapterIdOrder) onto the nearest preceding surviving chapter.
  // The original chapter id is tracked separately so the emitted remap
  // can still answer the frontend's `(originalOldChapterId, oldSentenceId)`
  // lookup — otherwise the frontend reducer would itself drop the orphan
  // a second time.
  const recoveredSentences: RestructureSentence[] = [];
  const originalChapterIdOf = new Map<RestructureSentence, number>();
  let orphanCount = 0;
  for (const s of oldSentences) {
    if (knownIds.has(s.chapterId)) {
      recoveredSentences.push(s);
      continue;
    }
    if (sortedKnownIds.length === 0) {
      // No chapters at all to attach to — drop with warning. Should be
      // unreachable in practice (a book without chapters has no sentences
      // either) but defensive.
      orphanCount++;
      continue;
    }
    let attachToOldId = sortedKnownIds[0];
    for (const knownId of sortedKnownIds) {
      if (knownId <= s.chapterId) attachToOldId = knownId;
      else break;
    }
    const reattached: RestructureSentence = { ...s, chapterId: attachToOldId };
    recoveredSentences.push(reattached);
    originalChapterIdOf.set(reattached, s.chapterId);
    orphanCount++;
  }
  if (orphanCount > 0) {
    const msg = `Recovered ${orphanCount} orphaned sentence${orphanCount === 1 ? '' : 's'} attached to chapters not present in the current structure.`;
    warnings.push(msg);
    console.warn(`[restructure] ${msg}`);
  }

  // Group sentences by newChapterId, in the right order.
  const groupedByNewId = new Map<number, RestructureSentence[]>();

  for (const oldChapterId of oldChapterIdOrder) {
    const fate = fates.get(oldChapterId);
    if (!fate) continue;
    const oldChapterSentences = sortById(
      recoveredSentences.filter((s) => s.chapterId === oldChapterId),
    );

    for (const s of oldChapterSentences) {
      let destNewId = fate.newId;
      // Split case: sentences past the pivot go to the second half
      if (
        fate.splitAfterSentenceId !== undefined &&
        fate.splitSecondHalfNewId !== undefined &&
        s.id > fate.splitAfterSentenceId
      ) {
        destNewId = fate.splitSecondHalfNewId;
      }
      let bucket = groupedByNewId.get(destNewId);
      if (!bucket) {
        bucket = [];
        groupedByNewId.set(destNewId, bucket);
      }
      bucket.push(s);
    }
  }

  const newSentences: RestructureSentence[] = [];
  const remap: SentenceRemap[] = [];

  // Emit new sentences ordered by new chapter id, then by old narrative order
  const newChapterIdsSorted = [...groupedByNewId.keys()].sort((a, b) => a - b);
  for (const newChapterId of newChapterIdsSorted) {
    const bucket = groupedByNewId.get(newChapterId)!;
    let newSentenceId = 1;
    for (const s of bucket) {
      const remapped: RestructureSentence = {
        ...s,
        chapterId: newChapterId,
        id: newSentenceId,
      };
      newSentences.push(remapped);
      // For recovered orphans, surface the ORIGINAL stale chapter id in
      // the remap so the frontend's `(oldChapterId, oldSentenceId)` lookup
      // resolves. For non-orphans, the original equals s.chapterId.
      const originalOldChapterId = originalChapterIdOf.get(s) ?? s.chapterId;
      remap.push({
        oldChapterId: originalOldChapterId,
        oldSentenceId: s.id,
        newChapterId,
        newSentenceId,
      });
      newSentenceId++;
    }
  }

  return { sentences: newSentences, remap, warnings };
}

/** Build the new state.chapters from the new hints + the old state, with
    per-chapter audio metadata behaviour:
    - content-changed chapters: drop audioModelKey + audioRenderedAt
    - renumbered-only chapters: preserve them (the file will be renamed,
      content still valid)
    Excluded flag and duration carry through. */
function buildNewStateChapters(
  oldState: BookStateJson,
  newHints: readonly ChapterHint[],
  fates: Map<number, OldChapterFate>,
): BookStateJson['chapters'] {
  // newId → primary old chapter (the one we inherit audio metadata from)
  // For merge: multiple old chapters map to one new id. Pick the first
  // (in original narrative order) as the inheritor — but it's marked
  // contentChanged anyway so we'll drop audio metadata.
  const primaryOldByNewId = new Map<number, number>();
  for (const [oldId, fate] of fates) {
    if (!primaryOldByNewId.has(fate.newId)) {
      primaryOldByNewId.set(fate.newId, oldId);
    }
  }

  return newHints.map((hint) => {
    const newId = hint.id;
    const primaryOldId = primaryOldByNewId.get(newId);
    const oldChapter = primaryOldId !== undefined
      ? oldState.chapters.find((c) => c.id === primaryOldId)
      : undefined;
    const fate = primaryOldId !== undefined ? fates.get(primaryOldId) : undefined;

    const newSlug = chapterSlug(newId, hint.title);
    const base: BookStateJson['chapters'][number] = {
      id: newId,
      title: hint.title,
      slug: newSlug,
    };
    if (hint.excluded) base.excluded = true;
    if (oldChapter?.duration) base.duration = oldChapter.duration;

    const contentChanged = fate?.contentChanged ?? true;
    if (!contentChanged && oldChapter) {
      // Preserve audio metadata — file will be renamed, content valid
      if (oldChapter.audioModelKey) base.audioModelKey = oldChapter.audioModelKey;
      if (oldChapter.audioRenderedAt) base.audioRenderedAt = oldChapter.audioRenderedAt;
    }
    return base;
  });
}

/** Build the audio op list. For each OLD chapter that had audio on disk,
    decide: keep (no-op), rename, or delete. */
function buildAudioOps(
  oldStateChapters: BookStateJson['chapters'],
  newStateChapters: BookStateJson['chapters'],
  fates: Map<number, OldChapterFate>,
): AudioOp[] {
  const audioOps: AudioOp[] = [];
  const newById = new Map(newStateChapters.map((c) => [c.id, c]));

  for (const oldChapter of oldStateChapters) {
    if (!oldChapter.audioRenderedAt) continue; // never had audio → nothing to do
    const fate = fates.get(oldChapter.id);
    if (!fate) {
      // Old chapter has no fate → treat as deleted (defensive; shouldn't happen)
      audioOps.push({ kind: 'delete', from: oldChapter.slug });
      continue;
    }
    if (fate.contentChanged) {
      audioOps.push({ kind: 'delete', from: oldChapter.slug });
      continue;
    }
    const newChapter = newById.get(fate.newId);
    if (!newChapter) {
      audioOps.push({ kind: 'delete', from: oldChapter.slug });
      continue;
    }
    if (newChapter.slug !== oldChapter.slug) {
      audioOps.push({
        kind: 'rename',
        from: oldChapter.slug,
        to: newChapter.slug,
        newChapterId: newChapter.id,
        newChapterTitle: newChapter.title,
      });
    }
    // else: slug unchanged + content unchanged → no op
  }

  return audioOps;
}

/* -- post-process passes ------------------------------------------ */

/* Detector for auto-generated "Chapter N" titles (bare or with subtitle).
   These were assigned by the parser when no real heading was present; they
   must re-derive against the chapter's new id after structural changes so
   the visible list doesn't drift from the underlying sequence. Captures
   the optional subtitle in group 2 for round-tripping. User-customised
   titles (anything not matching this shape) are preserved verbatim. */
const GENERIC_TITLE_RE = /^Chapter\s+\d+(\s*[—\-:]\s*(.+))?$/;

function renumberGenericTitlesInChapters(
  chapters: BookStateJson['chapters'],
): { chapters: BookStateJson['chapters']; renumbered: number } {
  let renumbered = 0;
  const next = chapters.map((ch) => {
    const match = GENERIC_TITLE_RE.exec(ch.title.trim());
    if (!match) return ch; // user-custom title — preserve
    const subtitle = match[2]?.trim();
    const newTitle = subtitle ? `Chapter ${ch.id} — ${subtitle}` : `Chapter ${ch.id}`;
    if (newTitle === ch.title) return ch;
    renumbered++;
    return { ...ch, title: newTitle, slug: chapterSlug(ch.id, newTitle) };
  });
  return { chapters: next, renumbered };
}

/* Drop chapters with zero attached sentences, renumber survivors 1..N,
   and propagate the remap / audioOps / hints accordingly.

   This is the structural cleanup pass that resolves the user-reported
   "empty rows at the end of the list" symptom — those rows had stale
   parser state from a previous import path or orphaned sentences that
   were dropped silently by the pre-fix remapSentences. Now that orphan
   recovery preserves content, empty chapters truly mean "no content";
   pruning is safe.

   Excluded chapters are not pruned even when empty — preserving the
   soft-hide invariant. Excluded chapters with sentences attached are
   kept as well. */
function pruneEmptyChaptersInResult(result: RestructureResult): RestructureResult {
  // Pre-analysis books have NO sentences at all — every chapter would
  // look "empty" by our metric. Skip the pass entirely in that case so
  // we don't collapse a freshly imported book down to zero chapters.
  // The empty-chapter symptom only matters post-analysis when SOME
  // chapters have content and others don't.
  if (result.sentences.length === 0) return result;

  const sentenceCountByChapter = new Map<number, number>();
  for (const s of result.sentences) {
    sentenceCountByChapter.set(s.chapterId, (sentenceCountByChapter.get(s.chapterId) ?? 0) + 1);
  }

  const pruned = result.state.chapters.filter(
    (c) => !c.excluded && (sentenceCountByChapter.get(c.id) ?? 0) === 0,
  );
  if (pruned.length === 0) return result;

  const survivors = result.state.chapters.filter((c) => !pruned.includes(c));

  // oldId → newId across the prune renumber
  const idRemap = new Map<number, number>();
  survivors.forEach((c, i) => idRemap.set(c.id, i + 1));

  const renumberedChapters: BookStateJson['chapters'] = survivors.map((c, i) => {
    const newId = i + 1;
    if (c.id === newId) return c;
    return { ...c, id: newId, slug: chapterSlug(newId, c.title) };
  });

  const renumberedHints: ChapterHint[] = result.hints
    .filter((h) => idRemap.has(h.id))
    .map((h) => ({ ...h, id: idRemap.get(h.id)! }));

  const renumberedSentences: RestructureSentence[] = result.sentences.map((s) => {
    const newChapterId = idRemap.get(s.chapterId);
    if (newChapterId === undefined) {
      // Survivor sentence whose chapter was pruned — impossible because
      // we only prune chapters with zero sentences. Defensive throw.
      throw new Error(
        `[restructure] prune-pass invariant violated: sentence in chapter ${s.chapterId} but chapter was pruned.`,
      );
    }
    return { ...s, chapterId: newChapterId };
  });

  // Update the remap's newChapterId for every entry. Survivor entries
  // get the new id; any entry pointing to a pruned chapter is unreachable
  // because pruned chapters have no sentences (and therefore no remap
  // entries).
  const updatedRemap: SentenceRemap[] = result.remap.map((r) => {
    const newChapterId = idRemap.get(r.newChapterId);
    if (newChapterId === undefined) {
      // Defensive: should not happen — see invariant above.
      return r;
    }
    return { ...r, newChapterId };
  });

  // Audio ops: keep deletes for pruned chapters that had audio (they'll
  // be cleaned up); rewrite rename ops that target a renumbered survivor.
  const additionalDeletes: AudioOp[] = pruned
    .filter((c) => c.audioRenderedAt)
    .map((c) => ({ kind: 'delete' as const, from: c.slug }));

  const adjustedAudioOps: AudioOp[] = [
    ...result.audioOps.map((op) => {
      if (op.kind === 'rename') {
        const newId = idRemap.get(op.newChapterId);
        if (newId === undefined) {
          // Rename target was pruned — degrade to delete
          return { kind: 'delete' as const, from: op.from };
        }
        const newChapter = renumberedChapters.find((c) => c.id === newId);
        return {
          ...op,
          newChapterId: newId,
          to: newChapter?.slug ?? op.to,
        };
      }
      return op;
    }),
    ...additionalDeletes,
  ];

  const msg = `Removed ${pruned.length} empty chapter${pruned.length === 1 ? '' : 's'} (${pruned
    .map((c) => c.title)
    .slice(0, 3)
    .join(', ')}${pruned.length > 3 ? ', …' : ''}).`;
  console.warn(`[restructure] ${msg}`);

  return {
    state: { ...result.state, chapters: renumberedChapters },
    hints: renumberedHints,
    sentences: renumberedSentences,
    remap: updatedRemap,
    audioOps: adjustedAudioOps,
    warnings: [...result.warnings, msg],
  };
}

/* Combined post-process: prune empties → renumber generic titles.
   Order matters: pruning may shift ids, after which generic titles must
   re-derive against the new ids. Renumbering also recomputes slugs for
   any title that changed.

   Audio ops referencing a chapter whose generic title got rewritten
   would technically need their `to` slug updated too — but in practice,
   when a chapter is auto-titled "Chapter N", its audio file is keyed off
   the same generic title, so the rename op's `to` already matches. The
   one edge case is a chapter that was auto-titled at parse time, then
   manually renamed by the user, then auto-titled-again here — but the
   regex detector intentionally excludes manually-renamed titles, so this
   case can't arise. */
function postProcessRestructure(result: RestructureResult): RestructureResult {
  const pruned = pruneEmptyChaptersInResult(result);
  const titled = renumberGenericTitlesInChapters(pruned.state.chapters);
  if (titled.renumbered === 0) return pruned;

  // Re-key audio ops whose rename target slug shifted along with the
  // title change. The chapter id is unchanged, but the slug now reflects
  // the new title — update the `to` field.
  const renumberedById = new Map(titled.chapters.map((c) => [c.id, c]));
  const adjustedAudioOps: AudioOp[] = pruned.audioOps.map((op) => {
    if (op.kind === 'rename') {
      const ch = renumberedById.get(op.newChapterId);
      if (ch && ch.slug !== op.to) {
        return { ...op, to: ch.slug, newChapterTitle: ch.title };
      }
    }
    return op;
  });

  const msg = `Renumbered ${titled.renumbered} auto-generated chapter title${titled.renumbered === 1 ? '' : 's'} against new positions.`;
  console.warn(`[restructure] ${msg}`);

  return {
    state: { ...pruned.state, chapters: titled.chapters },
    hints: pruned.hints,
    sentences: pruned.sentences,
    remap: pruned.remap,
    audioOps: adjustedAudioOps,
    warnings: [...pruned.warnings, msg],
  };
}

/* -- merge ---------------------------------------------------------- */

export function applyMerge(
  state: BookStateJson,
  hints: readonly ChapterHint[],
  sentences: readonly RestructureSentence[],
  op: MergeOp,
): RestructureResult {
  if (!Array.isArray(op.chapterIds) || op.chapterIds.length < 2) {
    throw new Error('Merge requires at least 2 chapter ids.');
  }
  const ids = [...new Set(op.chapterIds)];
  if (ids.length !== op.chapterIds.length) {
    throw new Error('Merge chapter ids must be unique.');
  }

  const sortedHints = sortById(hints);
  const sortedHintsIds = sortedHints.map((h) => h.id);
  const indices = ids.map((id) => {
    const idx = sortedHintsIds.indexOf(id);
    if (idx === -1) throw new Error(`Chapter ${id} not found.`);
    return idx;
  });
  indices.sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      throw new Error('Merge requires contiguous chapters.');
    }
  }

  const firstIdx = indices[0];
  const lastIdx = indices[indices.length - 1];
  const mergedOldIds = indices.map((i) => sortedHintsIds[i]);

  const mergedTitle =
    (op.mergedTitle ?? '').trim() || sortedHints[firstIdx].title;
  const mergedBody = mergedOldIds
    .map((id) => sortedHints.find((h) => h.id === id)!.body)
    .join('\n\n');
  const mergedExcluded = mergedOldIds.every(
    (id) => sortedHints.find((h) => h.id === id)!.excluded === true,
  );

  // Build new hints with re-issued ids 1..N
  const beforeHints = sortedHints.slice(0, firstIdx);
  const afterHints = sortedHints.slice(lastIdx + 1);
  const newHintsDraft: ChapterHint[] = [
    ...beforeHints,
    {
      id: 0,
      title: mergedTitle,
      body: mergedBody,
      excluded: mergedExcluded || undefined,
    },
    ...afterHints,
  ];
  const newHints: ChapterHint[] = newHintsDraft.map((h, i) => ({
    ...h,
    id: i + 1,
  }));

  // Build fate map: every old chapter id → new id + content-changed flag
  const fates = new Map<number, OldChapterFate>();
  // 'before' hints survive unchanged structurally; new id = position+1
  beforeHints.forEach((h, i) => {
    fates.set(h.id, { oldId: h.id, newId: i + 1, contentChanged: false });
  });
  // Merged chapters all collapse to one new id
  const mergedNewId = firstIdx + 1;
  for (const oldId of mergedOldIds) {
    fates.set(oldId, { oldId, newId: mergedNewId, contentChanged: true });
  }
  // 'after' hints renumber down by (mergedOldIds.length - 1)
  afterHints.forEach((h, i) => {
    fates.set(h.id, {
      oldId: h.id,
      newId: mergedNewId + 1 + i,
      contentChanged: false,
    });
  });

  // Old narrative order for sentence concatenation
  const oldChapterIdOrder = sortedHintsIds;

  const newStateChapters = buildNewStateChapters(state, newHints, fates);
  const { sentences: newSentences, remap, warnings } = remapSentences(
    sentences,
    fates,
    oldChapterIdOrder,
  );
  const audioOps = buildAudioOps(state.chapters, newStateChapters, fates);

  return postProcessRestructure({
    state: {
      ...state,
      chapters: newStateChapters,
      updatedAt: new Date().toISOString(),
    },
    hints: newHints,
    sentences: newSentences,
    remap,
    audioOps,
    warnings,
  });
}

/* -- split ---------------------------------------------------------- */

/** Compute where to split the chapter body. The user picked "split after
    sentence N"; we locate the byte index in `body` corresponding to the
    end of sentence N, then snap forward to the next paragraph break.
    Falls back to paragraph-count bisection if the locator can't find a
    unique match (e.g. analyzer normalised whitespace away). */
export function computeBodySplitIndex(
  body: string,
  prefixSentences: readonly RestructureSentence[],
  totalSentencesInChapter: number,
): number {
  if (prefixSentences.length === 0) return 0;

  // Build the locator: last ~80 chars of the prefix text, trimmed.
  const fullPrefixText = prefixSentences.map((s) => s.text).join(' ').trim();
  const locator = fullPrefixText.slice(Math.max(0, fullPrefixText.length - 80));

  if (locator.length > 0) {
    const firstHit = body.indexOf(locator);
    const lastHit = body.lastIndexOf(locator);
    if (firstHit !== -1 && firstHit === lastHit) {
      // Unique match → split after this locator
      const splitAt = firstHit + locator.length;
      const nextBreak = body.indexOf('\n\n', splitAt);
      return nextBreak === -1 ? splitAt : nextBreak;
    }
  }

  // Fallback: paragraph-count bisection
  console.warn(
    '[restructure] split locator did not match uniquely; falling back to paragraph-count bisection.',
  );
  const paragraphs = body.split('\n\n');
  if (totalSentencesInChapter <= 0 || paragraphs.length <= 1) return body.length;
  const ratio = prefixSentences.length / totalSentencesInChapter;
  const splitParagraph = Math.max(
    1,
    Math.min(paragraphs.length - 1, Math.round(paragraphs.length * ratio)),
  );
  return paragraphs.slice(0, splitParagraph).join('\n\n').length;
}

export function applySplit(
  state: BookStateJson,
  hints: readonly ChapterHint[],
  sentences: readonly RestructureSentence[],
  op: SplitOp,
): RestructureResult {
  const sortedHints = sortById(hints);
  const sortedHintsIds = sortedHints.map((h) => h.id);
  const targetIdx = sortedHintsIds.indexOf(op.chapterId);
  if (targetIdx === -1) {
    throw new Error(`Chapter ${op.chapterId} not found.`);
  }
  const targetHint = sortedHints[targetIdx];
  const chapterSentences = sortById(
    sentences.filter((s) => s.chapterId === op.chapterId),
  );
  if (chapterSentences.length === 0) {
    throw new Error(
      `Chapter ${op.chapterId} has no sentences; nothing to split on.`,
    );
  }
  const pivotIdx = chapterSentences.findIndex(
    (s) => s.id === op.afterSentenceId,
  );
  if (pivotIdx === -1) {
    throw new Error(
      `Sentence ${op.afterSentenceId} not in chapter ${op.chapterId}.`,
    );
  }
  if (pivotIdx === chapterSentences.length - 1) {
    throw new Error(
      'Cannot split after the last sentence — second half would be empty.',
    );
  }

  const prefixSentences = chapterSentences.slice(0, pivotIdx + 1);
  const splitIdx = computeBodySplitIndex(
    targetHint.body,
    prefixSentences,
    chapterSentences.length,
  );
  const firstBody = targetHint.body.slice(0, splitIdx).trimEnd();
  const secondBody = targetHint.body.slice(splitIdx).trimStart();

  const secondTitle =
    (op.newTitle ?? '').trim() || `${targetHint.title} (cont.)`;

  // Build new hints with re-issued ids 1..N
  const beforeHints = sortedHints.slice(0, targetIdx);
  const afterHints = sortedHints.slice(targetIdx + 1);
  const newHintsDraft: ChapterHint[] = [
    ...beforeHints,
    { ...targetHint, body: firstBody },
    {
      id: 0,
      title: secondTitle,
      body: secondBody,
      excluded: targetHint.excluded,
    },
    ...afterHints,
  ];
  const newHints: ChapterHint[] = newHintsDraft.map((h, i) => ({
    ...h,
    id: i + 1,
  }));

  // Fate map
  const fates = new Map<number, OldChapterFate>();
  beforeHints.forEach((h, i) => {
    fates.set(h.id, { oldId: h.id, newId: i + 1, contentChanged: false });
  });
  const firstHalfNewId = targetIdx + 1;
  const secondHalfNewId = targetIdx + 2;
  fates.set(op.chapterId, {
    oldId: op.chapterId,
    newId: firstHalfNewId,
    contentChanged: true,
    splitAfterSentenceId: op.afterSentenceId,
    splitSecondHalfNewId: secondHalfNewId,
  });
  afterHints.forEach((h, i) => {
    fates.set(h.id, {
      oldId: h.id,
      newId: secondHalfNewId + 1 + i,
      contentChanged: false,
    });
  });

  const newStateChapters = buildNewStateChapters(state, newHints, fates);
  const { sentences: newSentences, remap, warnings } = remapSentences(
    sentences,
    fates,
    sortedHintsIds,
  );
  const audioOps = buildAudioOps(state.chapters, newStateChapters, fates);

  // Split does NOT run the prune/renumber post-pass — split's invariant
  // is "both halves non-empty" (validated above), and the new chapter
  // gets a user-supplied or "(cont.)" title that intentionally diverges
  // from the generic pattern. Running the post-pass here would rewrite
  // the user's split title in a renumber and would never prune anything.
  return {
    state: {
      ...state,
      chapters: newStateChapters,
      updatedAt: new Date().toISOString(),
    },
    hints: newHints,
    sentences: newSentences,
    remap,
    audioOps,
    warnings,
  };
}

/* -- reorder -------------------------------------------------------- */

export function applyReorder(
  state: BookStateJson,
  hints: readonly ChapterHint[],
  sentences: readonly RestructureSentence[],
  op: ReorderOp,
): RestructureResult {
  if (!Array.isArray(op.order)) {
    throw new Error('Reorder requires an order array.');
  }
  const sortedHints = sortById(hints);
  const currentIds = sortedHints.map((h) => h.id);
  if (op.order.length !== currentIds.length) {
    throw new Error(
      `Reorder order length (${op.order.length}) does not match chapter count (${currentIds.length}).`,
    );
  }
  const orderSet = new Set(op.order);
  if (orderSet.size !== op.order.length) {
    throw new Error('Reorder order has duplicates.');
  }
  for (const id of currentIds) {
    if (!orderSet.has(id)) {
      throw new Error(`Reorder order missing chapter ${id}.`);
    }
  }

  // Build new hints with re-issued ids 1..N in the requested order
  const newHints: ChapterHint[] = op.order.map((oldId, i) => {
    const old = sortedHints.find((h) => h.id === oldId)!;
    return { ...old, id: i + 1 };
  });

  const fates = new Map<number, OldChapterFate>();
  op.order.forEach((oldId, i) => {
    fates.set(oldId, { oldId, newId: i + 1, contentChanged: false });
  });

  const newStateChapters = buildNewStateChapters(state, newHints, fates);
  const { sentences: newSentences, remap, warnings } = remapSentences(
    sentences,
    fates,
    currentIds,
  );
  const audioOps = buildAudioOps(state.chapters, newStateChapters, fates);

  return postProcessRestructure({
    state: {
      ...state,
      chapters: newStateChapters,
      updatedAt: new Date().toISOString(),
    },
    hints: newHints,
    sentences: newSentences,
    remap,
    audioOps,
    warnings,
  });
}
