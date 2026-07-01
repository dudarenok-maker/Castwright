// PR-body issue-linkage validator for the pr-issue-link CI check
// (.github/workflows/pr-issue-link.yml). See CONTRIBUTING.md "Issues" and
// docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md
// (Decision 9 / Decision 11) for the spec and rationale.

import { readFileSync } from 'node:fs';

// GitHub's own auto-close keywords are case-insensitive; "Refs" is this
// repo's own convention for a partial/multi-wave delivery (does not
// auto-close on GitHub, but still satisfies this gate's linkage check).
const ISSUE_LINK_PATTERN = /\b(?:closes|refs)\s+#\d+/i;

// A Closes/Refs keyword wrapped in inline code or a fenced code block reads
// as a real link but does NOT actually trigger GitHub's auto-close — strip
// both before testing so this check can't be satisfied by a false positive
// (see docs/superpowers/specs/... memory note: backtick-wrapped Closes #NN
// does not auto-close).

// A fenced code block's delimiter must be alone on its own line (optionally
// indented up to 3 spaces) per CommonMark — a stray ``` embedded mid-line
// (e.g. "Version ``` note.") is NOT a real fence and must not be treated as
// one, or an unrelated stray triple-backtick later in the body can pair with
// it and swallow everything (including a real Closes/Refs reference) across
// paragraph breaks in between. A real fence, unlike an inline span, CAN
// legitimately span blank lines (multi-paragraph code), so this is a
// per-line state machine rather than a per-paragraph split.
function stripFencedBlocks(text) {
  const lines = text.split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    const isFenceLine = /^ {0,3}`{3,}/.test(line);
    if (isFenceLine) {
      inFence = !inFence;
      // A fence is a block boundary even when the source has no blank line
      // on either side of it -- push a paragraph-break marker so the text
      // before and after doesn't coalesce into one paragraph (which would
      // let stripInlineSpans pair a stray backtick across what should be a
      // hard boundary, the same failure mode this fix's own history is
      // built from).
      kept.push('');
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

// Inline code spans cannot cross a blank line (paragraph break) per
// CommonMark, so strip per-paragraph rather than across the whole body —
// otherwise a stray/unpaired backtick in one paragraph can pair with an
// unrelated backtick in a later paragraph and swallow real text (including
// a legitimate Closes/Refs reference) sitting in between. A span can also be
// delimited by a run of 2+ backticks (`` `` ``), not just one, in which case
// its content is anything not containing that same-length run — matched
// generically via a backreference so a double-backtick span isn't
// mis-parsed as two adjacent empty single-backtick spans (which would leak
// its real content through unstripped).
function stripInlineSpans(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, ''))
    .join('\n\n');
}

function stripCodeSpans(text) {
  return stripInlineSpans(stripFencedBlocks(text));
}

export function hasIssueLink(body) {
  if (typeof body !== 'string') return false;
  return ISSUE_LINK_PATTERN.test(stripCodeSpans(body));
}

export function helpMessage() {
  return [
    `PR body doesn't link a GitHub issue.`,
    ``,
    `Expected somewhere in the PR body, written plainly (not inside`,
    `backticks or a code block):`,
    `  Closes #123     (full delivery — auto-closes the issue on merge)`,
    `  Refs #123       (partial / multi-wave delivery — does not auto-close)`,
    ``,
    `See CLAUDE.md "Opening the PR" and CONTRIBUTING.md "Issues" for the`,
    `full convention.`,
  ].join('\n');
}

// CLI mode: `node scripts/validate-pr-issue-link.mjs <pr-body-file>`
const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/validate-pr-issue-link.mjs');

if (invokedAsCli) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: validate-pr-issue-link.mjs <pr-body-file>');
    process.exit(2);
  }
  const body = readFileSync(path, 'utf8');
  if (!hasIssueLink(body)) {
    console.error(helpMessage());
    process.exit(1);
  }
  process.exit(0);
}
