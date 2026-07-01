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
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
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
