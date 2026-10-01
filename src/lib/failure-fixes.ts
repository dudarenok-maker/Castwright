/* #3084 F7 — the ONE place a structured `AnalysisFailureFix`'s `settingKey`
   becomes a link. Both renderers of a fix list (the run-level "How to fix"
   block in src/views/analysing.tsx and the persistent
   <ReasoningOverflowToast>) call this, so the deep-link scheme has a single
   definition and neither renderer knows how a focus URL is spelled.

   The URL is built through `stageToHash` rather than concatenated here on
   purpose: the `?focus=` query name and its percent-encoding live in the
   router (the one home for every stage URL — see its `'advanced'` case), and
   building it here would let the two drift. */

import type { AnalysisFailureFix } from './api';
import { stageToHash } from './router';

/* `null` means "this fix is not a link" — a label-only fix (e.g. "Switch to a
   different analyzer model", F13) renders as plain text. A `wikiPage` fix is
   likewise not this function's business: the renderer resolves it with
   `isWikiPage` + `wikiUrl` (src/lib/wiki-links.ts), since a wiki page and an
   Advanced Settings knob are different destinations. No fix ever carries both.

   Wave-stable by design: wave 3 (task 3d) adds an `endpointField` branch and
   wave 5 (task 5a) a `reasoningSetting` branch to this same function, so both
   renderers keep calling `fixHref(fix)` unchanged. */
export function fixHref(fix: AnalysisFailureFix): string | null {
  if (!fix.settingKey) return null;
  return stageToHash({ kind: 'advanced', focusKey: fix.settingKey });
}
