/* #1836 / plan 276 — the editable clone-transcript textarea, extracted out of
   `clone-capture-panel.tsx` (the clone wizard) so plan 276's
   `clone-readiness-gate.tsx` "Add transcript" CTA (Decision 1/6) can reuse the
   exact same cap-enforcement UI instead of a second copy. See
   `clone-capture-panel.tsx`'s own doc comment for why this is deliberately
   NOT a native `maxLength` attribute: the browser would silently drop the
   tail of a long paste, which is the exact silent-discard bug #1836 fixed.
   The route (and the mock) still enforce the same cap for non-UI callers. */

import { MAX_CLONE_TRANSCRIPT_CHARS } from '../../lib/clone-transcript-limit';

export function TranscriptField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const tooLong = value.length > MAX_CLONE_TRANSCRIPT_CHARS;
  return (
    <label>
      Transcript
      <textarea aria-label="transcript" value={value} onChange={(e) => onChange(e.target.value)} />
      {tooLong && (
        <p className="text-magenta text-xs">
          That transcript is too long — {value.length.toLocaleString()} characters, and the limit
          is {MAX_CLONE_TRANSCRIPT_CHARS.toLocaleString()}. Trim it to continue.
        </p>
      )}
    </label>
  );
}
