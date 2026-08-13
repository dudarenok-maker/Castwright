/* In-memory staging area for parsed-but-not-yet-confirmed imports.

   POST /api/import parses the file and stores the result here keyed by a
   short tempId. POST /api/books then drains the entry (writing to disk +
   creating state.json) and evicts it. Entries auto-expire after 30 minutes
   to avoid leaking memory if the user abandons the confirm screen. */

import type { ChapterHint, ManuscriptFormat } from './manuscripts.js';

export interface StagedImport {
  tempId: string;
  format: ManuscriptFormat;
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
  /** True when series came from a title-parenthetical heuristic rather
      than authoritative metadata. Surfaced to the confirm screen so the
      user can verify the guess. See server/src/parsers/text.ts
      `parseSeriesFromTitle`. */
  seriesFromTitle: boolean;
  sourceText: string;
  chapters: ChapterHint[];
  originalFileName: string | null;
  byteSize: number;
  /** Original uploaded bytes — verbatim. Persisted to disk on confirm
      so re-parse can re-run the parser over the same input later.
      Required for ALL formats: EPUB/PDF need the binary, but markdown/
      plaintext also need it because parseText strips headings and
      injects audio tags into sourceText, so sourceText is NOT a
      faithful copy of the original. */
  originalBuffer: Buffer;
  /** The language `/import` detected from the chapter bodies, and whether the
      registry supports it. Stored — not merely returned to the client — so the
      confirm step can fall back to it when the caller omits `language`.

      Without this the detection was computed, sent over the wire, and dropped:
      `POST /books` read only `body.language` and defaulted to English, so a
      caller that didn't echo the field back got an English book while the
      server still held the right answer in memory. That is how a Russian book
      was analysed as English for a full 20-hour run (#2306) — no language
      preamble, so stage 1 transliterated every name and stage 2 read
      dash-marked dialogue as narration.

      Optional only because a `StagedImport` is an in-memory record written by
      the same process that reads it — there is no persisted or cross-version
      entry that could lack these, so the optionality is type hygiene, not a
      compatibility path. */
  detectedLanguage?: string;
  detectedLanguageSupported?: boolean;
  /** True when the detection SURRENDERED rather than deciding it — the RULE,
      not an enumeration of `detectManuscriptLanguageFromChapters`'s surrender
      branches (which has grown a new one at least once per review round;
      re-listing them here is a copy that goes stale, the function itself is
      the source of truth): any path through it or the `voteLanguage` it
      delegates to that returns `resultFor(_, true)` — no candidate chapters
      at all, no chapter whose own per-chapter detection didn't itself
      surrender (including, since #2337 review C1, a franc match restricted
      to the registry's Latin set that a second, unrestricted franc call
      flags as a coercion rather than a genuine decision), no strict majority
      of the non-surrendered mass, or a winning language whose combined
      prose-unit count sits under `PROSE_UNIT_FLOOR`. Filled
      from `detectManuscriptLanguageFromChapters`
      (not the single-call `detectManuscriptLanguage` C1 itself patched), and
      that function's `voteLanguage` filters every `fallback: true` ballot
      out of the vote before it runs, so ALL of its surrender branches —
      including the all-coerced one — are hardcoded to `language: 'en'` (see
      `detect-language.ts`, pinned by `detect-language.test.ts`'s "#2337
      review N3" test). So `detectedLanguage` is `'en'` whenever this field is
      `true`, same as before C1 — C1 changed what a single
      `detectManuscriptLanguage` call can return, not what this field ends up
      holding. `supported` cannot distinguish a surrender from a real
      decision regardless (a surrender's guessed language is itself
      `supported: true`), and DetectionResult.fallback's own doc says a
      caller that must "never write a language they only guessed" (#2246)
      needs this field. This route is such a writer, so a surrendered
      detection is NOT used as the fallback — the confirm route falls
      through to `normaliseBookLanguage(body.language)` instead, which keeps
      the historical English default when the caller also said nothing. */
  detectedLanguageFallback?: boolean;
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const staging = new Map<string, StagedImport>();

function evictStale(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of staging) {
    if (v.createdAt < cutoff) staging.delete(k);
  }
}

export function putStaging(entry: StagedImport): void {
  evictStale();
  staging.set(entry.tempId, entry);
}

export function getStaging(tempId: string): StagedImport | undefined {
  evictStale();
  return staging.get(tempId);
}

export function dropStaging(tempId: string): void {
  staging.delete(tempId);
}
