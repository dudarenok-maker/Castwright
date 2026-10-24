/* srv-35 (plan 190) — stable per-chapter identifier primitives.
 *
 * Chapter `id` is positional (re-issued 1..N on restructure) and `slug`
 * embeds the id, so neither survives a merge/split/reorder/rename. These
 * pure helpers maintain an immutable `uuid` on each chapter:
 *
 *  - `ensureChapterUuids` is the LAZY-MIGRATION primitive — it mints a uuid
 *    for any chapter that lacks one (including excluded chapters, which can
 *    be re-included). Called at the read seams that already persist (scan,
 *    book-state GET, restructure) so a legacy book gains uuids on first
 *    touch. Idempotent: an existing uuid is never regenerated.
 *  - `reconcileChapterUuids` is the ANTI-STRIP primitive — when a caller
 *    replaces `state.chapters` wholesale (the generic PUT /:bookId/state
 *    patch), it carries each chapter's uuid across from the matching on-disk
 *    chapter (see `sameChapter`) so a frontend that doesn't track uuid can't
 *    erase it. The on-disk uuid always wins over one the client sends
 *    (#3683). A chapter with no match keeps its client uuid only if no
 *    on-disk chapter and no earlier output chapter holds it; otherwise it is
 *    minted. Output uuids are always unique.
 *
 * See docs/features/190-srv-35-stable-chapter-uuid.md. */

import { randomUUID } from 'node:crypto';
import type { BookStateJson } from './scan.js';

type Chapter = BookStateJson['chapters'][number];

/** The identity key for this PUT: a client chapter is the same chapter as a
 *  disk chapter only on `id` AND `slug`. It is NOT the scan self-heal's key
 *  (`scan.ts` also requires the uuids to agree when both sides carry one):
 *  here `uuid` is deliberately not part of the key, so a client uuid that
 *  differs is ignored and the disk uuid wins (#3683, owner decision
 *  2026-10-25). `carryTitleSynthesized`
 *  deliberately does not use it (see there). `id` alone is not enough: a
 *  restructure renumbers ids 1..N and recomputes slugs while each chapter
 *  keeps its uuid and stamps, so a pre-restructure copy shares ids with the
 *  wrong chapters. */
function sameChapter(a: Chapter, b: Chapter): boolean {
  return a.id === b.id && a.slug === b.slug;
}

function indexById(chapters: readonly Chapter[]): Map<number, Chapter> {
  const byId = new Map<number, Chapter>();
  for (const c of chapters) byId.set(c.id, c);
  return byId;
}

/** Mint a uuid for every chapter missing one. Mutates `state.chapters`
 *  in place (the state was just parsed from disk) and returns whether any
 *  uuid was added, so the caller can skip the persist write when nothing
 *  changed. Idempotent — an existing uuid is preserved untouched. */
export function ensureChapterUuids(state: BookStateJson): boolean {
  let changed = false;
  for (const chapter of state.chapters) {
    if (!chapter.uuid) {
      chapter.uuid = randomUUID();
      changed = true;
    }
  }
  return changed;
}

/** Overlay the `uuid` of each existing chapter onto the incoming chapter it
 *  matches (`sameChapter`), returning a new array (the incoming array is not
 *  mutated). The existing uuid wins over any client-supplied one (#3683). An
 *  incoming chapter with no match, or whose match has no uuid, keeps its own
 *  uuid only when no existing chapter and no earlier output chapter holds it,
 *  else a fresh one is minted, so output uuids are unique and no chapter ever
 *  takes another's. Used where the frontend round-trips `state.chapters` and
 *  would otherwise drop the server-only uuid field. */
export function reconcileChapterUuids(
  incoming: readonly Chapter[],
  existing: readonly Chapter[],
): Chapter[] {
  const existingById = indexById(existing);
  const diskUuids = new Set<string>();
  for (const c of existing) if (c.uuid) diskUuids.add(c.uuid);
  const used = new Set<string>();
  return incoming.map((c) => {
    const d = existingById.get(c.id);
    const matched = d && sameChapter(c, d) ? d.uuid : undefined;
    let uuid: string;
    if (matched && !used.has(matched)) {
      uuid = matched;
    } else if (c.uuid && !diskUuids.has(c.uuid) && !used.has(c.uuid)) {
      uuid = c.uuid;
    } else {
      uuid = randomUUID();
    }
    used.add(uuid);
    return { ...c, uuid };
  });
}

/** Carry the server-owned `titleSynthesized` flag across a wholesale chapter
 *  replace. The frontend never tracks the flag, and a client value is
 *  ignored: for each incoming chapter the flag is taken from the existing
 *  chapter with the same `id` (kept only when `true` AND the incoming title
 *  still equals the stored one, otherwise the key is removed: a retitled
 *  chapter is no longer app-made). Matched by `id` alone, not `sameChapter`:
 *  the analysis persist shares this helper and re-derives every slug, and the
 *  title-equality guard is the identity check that stops the flag moving onto
 *  a different heading. Returns a new array; the incoming array is not
 *  mutated. */
export function carryTitleSynthesized(
  incoming: readonly Chapter[],
  existing: readonly Chapter[],
): Chapter[] {
  const synthesizedTitleById = new Map<number, string>();
  for (const c of existing) {
    if (c.titleSynthesized === true) synthesizedTitleById.set(c.id, c.title);
  }
  return incoming.map((c) => {
    const { titleSynthesized: _clientValue, ...rest } = c;
    return synthesizedTitleById.get(c.id) === c.title ? { ...rest, titleSynthesized: true } : rest;
  });
}

/** Chapter fields only the server stamps (finalize's success stamp). On a
 *  wholesale chapters replace they come from disk; a client value is never used. */
const SERVER_OWNED_CHAPTER_FIELDS = [
  'duration',
  'audioRenderedAt',
  'audioModelKey',
  'audioEngines',
  'audioQa',
] as const;

/** Server-stamped failure fields (generation's failure stamp). Disk wins, but
 *  the client may clear one with an explicit `null` (e.g. on Retry). */
const CLIENT_CLEARABLE_CHAPTER_FIELDS = [
  'generationState',
  'generationError',
  'generationErrorCode',
  'generationRemediation',
] as const;

/** Carry the server-owned chapter fields across a wholesale chapter replace
 *  (operator decision 2026-10-23, #3683): the matching on-disk copy
 *  (`sameChapter`: `id` AND `slug`; owner decision 2026-10-25)
 *  always wins, so a stale client copy can never erase or overwrite a server
 *  stamp. `SERVER_OWNED_CHAPTER_FIELDS` come from disk only; a client value is
 *  never used, even for a chapter with no match. For
 *  `CLIENT_CLEARABLE_CHAPTER_FIELDS` an explicit client `null` clears the
 *  field (the key is dropped, no `null` is written); an absent or non-null
 *  client value keeps the disk value. `uuid` is deliberately not in these
 *  lists: `reconcileChapterUuids` owns it. Every other field passes through
 *  from the incoming chapter. Returns a new array; nothing is mutated. */
export function carryServerOwnedChapterFields(
  incoming: readonly Chapter[],
  existing: readonly Chapter[],
): Chapter[] {
  const existingById = indexById(existing);
  return incoming.map((c) => {
    const found = existingById.get(c.id);
    const d = found && sameChapter(c, found) ? found : undefined;
    const out: Record<string, unknown> = { ...c };
    for (const key of SERVER_OWNED_CHAPTER_FIELDS) delete out[key];
    for (const key of CLIENT_CLEARABLE_CHAPTER_FIELDS) delete out[key];
    if (d) {
      for (const key of SERVER_OWNED_CHAPTER_FIELDS) {
        if (d[key] !== undefined) out[key] = d[key];
      }
      for (const key of CLIENT_CLEARABLE_CHAPTER_FIELDS) {
        if ((c as Record<string, unknown>)[key] === null) continue;
        if (d[key] !== undefined) out[key] = d[key];
      }
    }
    return out as Chapter;
  });
}
