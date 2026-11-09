/* The run-start refusal for a cast.json that cannot serve as the prior cast
   (#4031). A leaf module on purpose: both `analysis-cast-io.ts` (which throws it)
   and `routes/failure-taxonomy.ts` (which classifies it) import it, and neither
   may import the other.

   Two reasons, because the user's way out differs:
   - `unreadable`: the file could not be read right now (EBUSY/EPERM, an AV scan,
     a sync client) - transient, so a retry is the honest advice.
   - `corrupt`: it was read but is truncated, is not JSON, or has the wrong shape
     (no `characters` array) - a retry can never fix it, so the copy promises none.
   Both messages are fixed and path-free: they reach a client over SSE. */

export type PriorCastUnreadableReason = 'unreadable' | 'corrupt';

export const PRIOR_CAST_UNREADABLE_MESSAGE =
  'The cast could not be read right now, so the re-analysis was stopped before changing anything. Try again.';
export const PRIOR_CAST_CORRUPT_MESSAGE =
  "This book's cast file is damaged, so the re-analysis was stopped before changing anything. Re-parse the book or restore its cast from a backup, then analyse again.";

export const PRIOR_CAST_UNREADABLE_REMEDIATION =
  "Wait a few seconds (something else may have the book's cast file open), then run the analysis again. Nothing was changed.";
export const PRIOR_CAST_CORRUPT_REMEDIATION =
  'Re-parse the book, or restore its cast from a backup, then run the analysis again. Nothing was changed.';

export class PriorCastUnreadableError extends Error {
  readonly reason: PriorCastUnreadableReason;
  constructor(reason: PriorCastUnreadableReason) {
    super(reason === 'corrupt' ? PRIOR_CAST_CORRUPT_MESSAGE : PRIOR_CAST_UNREADABLE_MESSAGE);
    this.name = 'PriorCastUnreadableError';
    this.reason = reason;
  }
}
