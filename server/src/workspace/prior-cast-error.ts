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

/* #4031 R2-M2 — the same refusal found MID-RUN (a plan snapshot or the terminal
   persist re-read a damaged file). "Before changing anything" would be untrue there:
   an earlier snapshot may have written cast.json, and the persist's state.json write
   still lands. Only the damaged file itself is guaranteed untouched. */
export const PRIOR_CAST_CORRUPT_MID_RUN_MESSAGE =
  "This book's cast file was damaged while the analysis ran, so the analysis stopped and left that file as it was. Re-parse the book or restore its cast from a backup, then analyse again.";
export const PRIOR_CAST_CORRUPT_MID_RUN_REMEDIATION =
  'Re-parse the book, or restore its cast from a backup, then run the analysis again.';

export class PriorCastUnreadableError extends Error {
  readonly reason: PriorCastUnreadableReason;
  /** Found by a mid-run re-read (only ever with `corrupt`), not at the run start. */
  readonly midRun: boolean;
  constructor(reason: PriorCastUnreadableReason, opts: { midRun?: boolean } = {}) {
    const midRun = opts.midRun === true && reason === 'corrupt';
    super(
      midRun
        ? PRIOR_CAST_CORRUPT_MID_RUN_MESSAGE
        : reason === 'corrupt'
          ? PRIOR_CAST_CORRUPT_MESSAGE
          : PRIOR_CAST_UNREADABLE_MESSAGE,
    );
    this.name = 'PriorCastUnreadableError';
    this.reason = reason;
    this.midRun = midRun;
  }
}
