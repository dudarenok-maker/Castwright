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
 *    patch), it carries each chapter's uuid across by `id` so a frontend
 *    that doesn't track uuid can't erase it. A uuid the incoming chapter
 *    already carries wins; a genuinely-new chapter is minted.
 *
 * See docs/features/190-srv-35-stable-chapter-uuid.md. */

import { randomUUID } from 'node:crypto';
import type { BookStateJson } from './scan.js';

type Chapter = BookStateJson['chapters'][number];

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

/** Overlay the `uuid` of each existing chapter onto the incoming chapter
 *  with the same `id`, returning a new array (the incoming array is not
 *  mutated). An incoming chapter that already carries a uuid keeps it; one
 *  with no matching existing id is minted a fresh uuid. Used where the
 *  frontend round-trips `state.chapters` and would otherwise drop the
 *  server-only uuid field. */
export function reconcileChapterUuids(
  incoming: readonly Chapter[],
  existing: readonly Chapter[],
): Chapter[] {
  const uuidById = new Map<number, string>();
  for (const c of existing) {
    if (c.uuid) uuidById.set(c.id, c.uuid);
  }
  return incoming.map((c) => {
    if (c.uuid) return c;
    return { ...c, uuid: uuidById.get(c.id) ?? randomUUID() };
  });
}
