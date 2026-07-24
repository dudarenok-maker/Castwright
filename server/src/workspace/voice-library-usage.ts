/* fs-38 Wave 1, Task 5 — voice-library usage scan + reference clearing.

   DELETE /api/voice-library/:voiceUuid needs to know, before erasing
   anything, which cast characters (across every book in the workspace)
   currently reference the voice — so the route can report it and require
   an explicit confirm. Reuses the SAME books/ directory-walk shape as
   `routes/voices.ts`'s `aggregateVoices` (author/series/title, gated on
   `state.castConfirmed`), but reads far less: no voice aggregation, no
   sample-cache lookups, just a scan for the matching `libraryUuid`. */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKS_ROOT, castJsonPath, stateJsonPath } from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import type { BookStateJson } from './scan.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

export interface LibraryVoiceUsage {
  bookId: string;
  bookTitle: string;
  characterId: string;
  characterName: string;
}

interface CastJson {
  characters?: CastCharacter[];
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

/* Walk every confirmed book's cast.json, yielding (bookDir, state, cast)
   for the ones that actually have characters. Shared by the scan below and
   `clearLibraryVoiceReferences` so both agree on which books are in scope. */
async function* walkConfirmedCasts(): AsyncGenerator<{
  bookDir: string;
  state: BookStateJson;
  cast: CastJson;
}> {
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        yield { bookDir, state, cast };
      }
    }
  }
}

function referencesVoice(character: CastCharacter, voiceUuid: string): boolean {
  const overrides = character.overrideTtsVoices;
  if (!overrides) return false;
  return Object.values(overrides).some((slot) => slot?.libraryUuid === voiceUuid);
}

/** Every (book, character) pair whose `overrideTtsVoices[*].libraryUuid`
    references `voiceUuid`. Used by the DELETE route's pre-flight usage
    report — 409s with this list unless the caller passes `?confirm=1`. */
export async function scanLibraryVoiceUsage(voiceUuid: string): Promise<LibraryVoiceUsage[]> {
  const out: LibraryVoiceUsage[] = [];
  for await (const { state, cast } of walkConfirmedCasts()) {
    for (const c of cast.characters ?? []) {
      if (!referencesVoice(c, voiceUuid)) continue;
      out.push({
        bookId: state.bookId,
        bookTitle: state.title,
        characterId: c.id,
        characterName: c.name ?? c.id,
      });
    }
  }
  return out;
}

/** Drops every `overrideTtsVoices[engine]` slot that references `voiceUuid`,
    leaving the character voiceless on that engine (fe-46's gate then
    surfaces "needs a voice"). Sibling engine slots and every other
    character/book are left untouched. Only writes a cast.json that
    actually changed. Called by the DELETE route after usage is confirmed
    (or when the voice turns out to be unused, where this is a no-op). */
export async function clearLibraryVoiceReferences(voiceUuid: string): Promise<void> {
  for await (const { bookDir, cast } of walkConfirmedCasts()) {
    let dirty = false;
    const characters = (cast.characters ?? []).map((c) => {
      const overrides = c.overrideTtsVoices;
      if (!overrides) return c;
      const next = { ...overrides };
      let changed = false;
      for (const engine of Object.keys(overrides) as (keyof typeof overrides)[]) {
        if (overrides[engine]?.libraryUuid === voiceUuid) {
          delete next[engine];
          changed = true;
        }
      }
      if (!changed) return c;
      dirty = true;
      return { ...c, overrideTtsVoices: next };
    });

    if (dirty) {
      await writeJsonAtomic(castJsonPath(bookDir), { ...cast, characters });
    }
  }
}
