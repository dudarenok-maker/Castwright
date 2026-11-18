/* #4341 (of #4319, spec §4.3 "The PUT's `slug`", R4-4 / R5-8 / R6-5) - the
   slug-binding checks of `PUT /api/books/:bookId/state` when it sends `chapters`.
   A chapter's slug names its take files, so a PUT must not separate a chapter
   from its audio. Pure decision over the FRESH disk chapters (the caller reads
   them inside the state-json lock) plus the probes for "a take on disk"; it
   writes nothing. */

import type { BookStateJson } from './scan.js';
import { chapterAudioExists, findPreviousAudio } from './chapter-take.js';

type Chapter = BookStateJson['chapters'][number];

/** Fixed, path-free sentence for the 409 body. */
export const SLUG_BOUND_SENTENCE =
  'A chapter\'s audio files are named after its slug, so this save would separate a chapter from its audio. Chapter files move only through the chapter restructure tools.';

/** Thrown by the PUT's locked merge; the route answers it 409 `slug_bound`. */
export class SlugBoundError extends Error {
  constructor() {
    super(SLUG_BOUND_SENTENCE);
    this.name = 'SlugBoundError';
  }
}

function hasTakeOnDisk(audioRoot: string, slug: string): boolean {
  return chapterAudioExists(audioRoot, slug) || findPreviousAudio(audioRoot, slug) !== null;
}

/** Throws `SlugBoundError` when `incoming` would rebind a slug (R4-4, R5-8) or
 *  strand a take (R6-5). Matching is by `uuid`, else by `id`. */
export function assertSlugBinding(
  incoming: readonly Chapter[],
  disk: readonly Chapter[],
  audioRoot: string,
): void {
  const diskByUuid = new Map<string, Chapter>();
  const diskById = new Map<number, Chapter>();
  const diskSlugs = new Set<string>();
  for (const d of disk) {
    if (d.uuid) diskByUuid.set(d.uuid, d);
    diskById.set(d.id, d);
    diskSlugs.add(d.slug);
  }
  const matchedDisk = new Set<Chapter>();
  for (const c of incoming) {
    const d = (c.uuid ? diskByUuid.get(c.uuid) : undefined) ?? diskById.get(c.id);
    if (d) {
      matchedDisk.add(d);
      if (c.slug !== d.slug) throw new SlugBoundError();
      if (Boolean(c.excluded) !== Boolean(d.excluded)) throw new SlugBoundError();
    } else if (diskSlugs.has(c.slug) || hasTakeOnDisk(audioRoot, c.slug)) {
      throw new SlugBoundError();
    }
  }
  for (const d of disk) {
    if (!matchedDisk.has(d) && hasTakeOnDisk(audioRoot, d.slug)) throw new SlugBoundError();
  }
}
