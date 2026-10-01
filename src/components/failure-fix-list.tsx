/* #3084 F7 — the ONE renderer of a structured "How to fix" list.

   Two surfaces show the same list and must not drift: the persistent
   <ReasoningOverflowToast> (survives navigation) and the run-level error panel
   in src/views/analysing.tsx. Both render <FailureFixList fixes={…} /> rather
   than each resolving links itself, so the three-way rule below is defined
   once:

     - a `wikiPage` entry  → an outbound wiki link (isWikiPage + wikiUrl), or
       plain text when this build does not publish that page name;
     - a `settingKey` entry → an in-app Advanced Settings deep link (fixHref);
     - a label-only entry  → plain text.

   No entry ever carries both `wikiPage` and `settingKey` (the server's
   `reasoningOverflowFixes` builds them that way, and
   server/src/routes/failure-taxonomy-fixes.test.ts guards it), so the order of
   the checks below is a read-order choice, not a precedence rule. */

import { isWikiPage } from '../lib/wiki-links';
import { fixHref } from '../lib/failure-fixes';
import { WikiLink } from './wiki-link';
import type { AnalysisFailureFix } from '../lib/api';

export function FailureFixList({
  fixes,
  className = '',
}: {
  fixes: AnalysisFailureFix[];
  className?: string;
}) {
  if (fixes.length === 0) return null;
  return (
    <ul className={className}>
      {fixes.map((fix) => {
        const href = fixHref(fix);
        /* `isWikiPage` narrows the wire's plain `string` to a page this client
           actually publishes — an unknown name falls through to the plain-text
           branch below instead of rendering a broken URL. */
        const page = fix.wikiPage && isWikiPage(fix.wikiPage) ? fix.wikiPage : null;
        return (
          <li key={fix.label} className="text-sm leading-snug">
            {page ? (
              <WikiLink
                page={page}
                label={fix.label}
                className="underline font-semibold text-magenta hover:text-magenta/80"
              />
            ) : href ? (
              <a
                href={href}
                className="underline font-semibold text-magenta hover:text-magenta/80"
              >
                {fix.label}
              </a>
            ) : (
              <span>{fix.label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
