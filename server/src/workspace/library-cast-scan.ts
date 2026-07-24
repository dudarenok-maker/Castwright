/* Walks the books/ tree and yields every character on disk that belongs to
   a confirmed cast. Distinct from `scan.ts` (which produces the high-level
   library view) and `voices.ts` (which projects a derived per-voice display
   shape): this returns the raw cast entries so cross-book matchers can
   score against name + aliases + attributes without re-walking the tree. */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKS_ROOT, castJsonPath, ensureWorkspace, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import type { BookStateJson } from './scan.js';
import type { TtsEngine } from '../tts/index.js';
import type { Emotion } from '../handoff/schemas.js';

export interface LibraryCastCharacter {
  id: string;
  name?: string;
  role?: string;
  voiceId?: string;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time. */
  voiceUuid?: string;
  aliases?: string[];
  attributes?: string[];
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  /** Per-engine user-set voice overrides — carried through by reference from
      cast.json (see scanLibraryCharacters below, which pushes `character: c`
      whole). fs-38 Wave 1 widens the qwen slot with libraryUuid/provenance so
      the usage-scan filter (Task 8) can identify library-sourced assignments. */
  overrideTtsVoices?: Partial<
    Record<
      TtsEngine,
      {
        name: string;
        libraryUuid?: string;
        provenance?: 'designed' | 'cloned' | 'imported';
        variants?: Partial<Record<Emotion, { name: string }>>;
      }
    >
  > | null;
}

export interface LibraryCharacterRecord {
  bookId: string;
  bookTitle: string;
  character: LibraryCastCharacter;
}

interface CastJson {
  characters?: LibraryCastCharacter[];
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export async function scanLibraryCharacters(): Promise<LibraryCharacterRecord[]> {
  ensureWorkspace();
  const out: LibraryCharacterRecord[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        /* spec §6 "Matcher exclusion — assignment-level, not manifest-level": a
           cloned-provenance assignment is a person's own voice and must NEVER be
           offered back to a stranger's book by the cross-book matcher, so it is
           excluded here at the single seam feeding both projectLibraryVoice()
           (routes/voice-match.ts) and series-reuse-link.ts. imported/designed and
           provenance-less (legacy) characters pass through unchanged. */
        const eligible = cast.characters.filter(
          (c) => !Object.values(c.overrideTtsVoices ?? {}).some((slot) => slot?.provenance === 'cloned'),
        );
        for (const c of eligible) {
          if (!c.id) continue;
          out.push({ bookId: state.bookId, bookTitle: state.title, character: c });
        }
      }
    }
  }
  return out;
}
