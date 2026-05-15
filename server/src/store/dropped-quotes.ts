/* Per-book ledger of evidence quotes that the analyser's verifier
   rejected for not appearing verbatim in the source text. Each Phase 0
   verify pass appends one batch; we never overwrite, so the user
   (and any audit script) can see what every analyser run fabricated.

   Read sites:
   - GET /api/books/:bookId/dropped-quotes (the analysing view's panel)
   - PowerShell `Get-Content .audiobook/dropped-quotes.json | ConvertFrom-Json`
     during qwen3.5:4b reliability tuning.

   Write sites: the two analysis routes (full /analysis/stream and
   subset /analysis/chapters), once each per verify pass, after
   verifyEvidenceAgainstSource has folded its drops back into the
   character roster. */

import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { droppedQuotesJsonPath } from '../workspace/paths.js';

/** Hard cap on stored quote length. Some models emit multi-paragraph
    "quotes" when they fabricate dialogue; storing them verbatim would
    bloat the file and the UI list with little incremental signal.
    2000 chars comfortably exceeds any real quote shape the verifier
    rejects (real quotes top out in the few-hundred range in the
    canonical e2e). When a quote is longer, we slice and set
    `truncated: true` so the reader knows the text was cut. */
export const MAX_QUOTE_CHARS = 2000;

/** Why the verifier dropped a quote. Enumerated from the single
    conditional in server/src/routes/analysis.ts
    verifyEvidenceAgainstSource:

      const norm = normaliseForMatch(e.quote);
      if (norm.length > 0 && normalisedSource.includes(norm)) { ...keep }
      else { ...drop }

    Two logical branches collapse into the else:
    - `empty_after_normalisation`: norm.length === 0
    - `not_in_source`:             norm not a substring of the source */
export type DropReason =
  | 'not_in_source'
  | 'empty_after_normalisation';

export interface DroppedQuoteEntry {
  characterId: string;
  characterName: string;
  /** Stored quote text. Capped at MAX_QUOTE_CHARS — see `truncated`. */
  quote: string;
  truncated: boolean;
  reason: DropReason;
  /** Verbatim copy of the optional `note` field from the model's
      evidence entry (handoff/schemas.ts evidenceSchema), kept so the
      user can see the model's stated rationale for the rejected
      quote. */
  note?: string;
}

/** One verify-pass summary. Multiple batches accumulate across re-runs
    (model switch, retry, un-exclude), so the file is append-only. */
export interface DroppedQuotesBatch {
  /** ISO timestamp when the verify pass completed. */
  recordedAt: string;
  /** Which route ran this pass — useful when correlating with the
      analysing-view log. */
  route: 'analysis-stream' | 'analysis-chapters';
  /** Pre-truncation totals from verifyEvidenceAgainstSource's return. */
  totalDropped: number;
  affectedCharacters: number;
  entries: DroppedQuoteEntry[];
}

export interface DroppedQuotesFile {
  manuscriptId: string;
  batches: DroppedQuotesBatch[];
}

/** Slice the quote at MAX_QUOTE_CHARS. Pure — no side effects, safe to
    call in tight loops. Returns `truncated: false` for quotes at or
    below the cap so the UI doesn't need to render an indicator. */
export function truncateQuote(quote: string): { text: string; truncated: boolean } {
  if (quote.length <= MAX_QUOTE_CHARS) return { text: quote, truncated: false };
  return { text: quote.slice(0, MAX_QUOTE_CHARS), truncated: true };
}

/** Immutably append a batch to the envelope. Returns the new envelope;
    callers must persist via saveDroppedQuotes. */
export function appendBatch(
  file: DroppedQuotesFile,
  batch: DroppedQuotesBatch,
): DroppedQuotesFile {
  return { ...file, batches: [...file.batches, batch] };
}

/** Load the ledger from a book's .audiobook/ folder. Returns an empty
    envelope (no batches) when the file doesn't exist yet — first-run
    behaviour. */
export async function loadDroppedQuotes(
  bookDir: string,
  manuscriptId: string,
): Promise<DroppedQuotesFile> {
  const existing = await readJson<DroppedQuotesFile>(droppedQuotesJsonPath(bookDir));
  if (existing && Array.isArray(existing.batches)) return existing;
  return { manuscriptId, batches: [] };
}

/** Persist the envelope atomically. Same OneDrive-EPERM retry contract
    as every other .audiobook/*.json write — see state-io.ts. */
export async function saveDroppedQuotes(
  bookDir: string,
  file: DroppedQuotesFile,
): Promise<void> {
  await writeJsonAtomic(droppedQuotesJsonPath(bookDir), file);
}
