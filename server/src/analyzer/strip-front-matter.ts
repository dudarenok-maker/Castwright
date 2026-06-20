/* Layer A (#938) — strip title-page byline + e-library boilerplate from a chapter
   body before the analyzer sees it, so the byline author never reaches stage-1/2.
   Pure; applied in-memory to the analysis copy of the body (never persisted).

   Two removal classes:
     - Always-safe global patterns (reader-tool headers, copyright/distribution
       notices, bare URLs) — ordinary prose never contains these, so drop anywhere.
     - Leading-region byline/title echo — a standalone line equal (normalized) to
       the book author or title, removed only before substantial narrative prose
       begins, so a story that *mentions* the author mid-prose is untouched. */
import { normaliseNameKey } from '../util/safe-id.js';

const GLOBAL_BOILERPLATE: RegExp[] = [
  /_###ICE#BOOK#READER/i, // reader-tool header marker (whole line is the header)
  /^\s*(AUTHOR|TITLE|CODEPAGE)\s*:/i, // reader header fields on their own line
  /коммерческое использование/i, // e-library usage notice
  /одобрен к распространению/i, // e-library distribution notice
  /^\s*\((С|C)\)\s/i, // "(С) <author>" copyright line
  /^\s*https?:\/\/\S+\s*$/i, // bare URL line
];

function isGlobalBoilerplate(line: string): boolean {
  return GLOBAL_BOILERPLATE.some((re) => re.test(line));
}

/* A line that reads as narrative prose: reasonably long, contains sentence
   punctuation AND a lowercase letter. All-caps headings ("ПРОЛОГ", "ИСТОРИЯ
   ПЕРВАЯ") and bare bylines are short / have no lowercase → not narrative. */
function isNarrativeLine(line: string): boolean {
  if (line.length < 60) return false;
  return /[.!?…]/.test(line) && /\p{Ll}/u.test(line);
}

export function stripFrontMatterBoilerplate(
  body: string,
  opts: { author?: string; title?: string } = {},
): string {
  const authorKey = normaliseNameKey(opts.author);
  const titleKey = normaliseNameKey(opts.title);
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inFrontMatter = true;
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Global boilerplate: drop anywhere, without ending the front-matter region.
    if (trimmed && isGlobalBoilerplate(trimmed)) {
      changed = true;
      continue;
    }

    if (inFrontMatter && trimmed) {
      const key = normaliseNameKey(trimmed);
      if (key && (key === authorKey || key === titleKey)) {
        changed = true;
        continue; // standalone byline / title echo
      }
      if (isNarrativeLine(trimmed)) inFrontMatter = false;
    }

    out.push(line);
  }

  return changed ? out.join('\n') : body;
}
