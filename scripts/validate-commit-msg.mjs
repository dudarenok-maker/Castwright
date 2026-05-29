// Conventional-Commits subject validator for .husky/commit-msg.
// See CONTRIBUTING.md and docs/features/archive/38-branching-and-commit-convention.md
// for the spec and rationale.

import { readFileSync } from 'node:fs';

export const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci'];
export const CHORE_TYPE = 'chore';
export const SCOPES = [
  'frontend',
  'server',
  'sidecar',
  'scripts',
  'e2e',
  'mocks',
  'openapi',
  'docs',
  'deps',
  'ci',
];

const SCOPE_GROUP = `(?:${SCOPES.join('|')})`;
const SCOPE_LIST = `${SCOPE_GROUP}(?:,${SCOPE_GROUP})*`;

// chore: scope optional. All other typed commits: scope required.
const CHORE_PATTERN = new RegExp(`^${CHORE_TYPE}(?:\\(${SCOPE_LIST}\\))?!?: .+$`);
const TYPED_PATTERN = new RegExp(`^(?:${TYPES.join('|')})\\(${SCOPE_LIST}\\)!?: .+$`);

// Git auto-generates these — never reject them.
const AUTO_GENERATED = /^(?:Merge |Revert |fixup! |squash! )/;

const MAX_SUBJECT_LEN = 100;

export function validateCommitSubject(subject) {
  if (typeof subject !== 'string' || subject.length === 0) {
    return { ok: false, reason: 'empty subject' };
  }
  if (AUTO_GENERATED.test(subject)) {
    return { ok: true, reason: 'auto-generated (merge/revert/fixup/squash)' };
  }
  if (subject.length > MAX_SUBJECT_LEN) {
    return { ok: false, reason: `subject longer than ${MAX_SUBJECT_LEN} chars` };
  }
  if (CHORE_PATTERN.test(subject) || TYPED_PATTERN.test(subject)) {
    return { ok: true };
  }
  return { ok: false, reason: 'subject does not match Conventional Commits convention' };
}

export function helpMessage(subject) {
  return [
    `Commit subject doesn't match the Conventional Commits convention.`,
    ``,
    `Subject:`,
    `  ${subject}`,
    ``,
    `Expected:`,
    `  <type>(<scope>): <subject>            e.g. feat(server): add batch retry`,
    `  <type>(<scope>,<scope>): <subject>    e.g. fix(frontend,openapi): align field name`,
    `  chore: <subject>                      no-scope catch-all`,
    `  chore(<scope>): <subject>             scoped chore (e.g. chore(deps): bump vitest)`,
    ``,
    `Allowed types:  ${[...TYPES, CHORE_TYPE].join(' | ')}`,
    `Allowed scopes: ${SCOPES.join(' | ')}`,
    ``,
    `Append '!' before the colon to mark a breaking change, e.g. feat(server)!: drop legacy field.`,
    `Subjects must be 1-${MAX_SUBJECT_LEN} chars.`,
    `Merge, Revert, fixup! and squash! commits are exempt.`,
    ``,
    `See CONTRIBUTING.md for the full spec.`,
  ].join('\n');
}

// Extract the first non-empty, non-comment line from a commit-msg file.
// Mirrors git's own notion of the subject line.
export function extractSubject(content) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    return line;
  }
  return '';
}

// CLI mode: `node scripts/validate-commit-msg.mjs <commit-msg-file>`
// Detect via argv[1] so that `import` from tests does not trigger CLI behavior.
const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/validate-commit-msg.mjs');

if (invokedAsCli) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: validate-commit-msg.mjs <commit-msg-file>');
    process.exit(2);
  }
  const content = readFileSync(path, 'utf8');
  const subject = extractSubject(content);
  const result = validateCommitSubject(subject);
  if (!result.ok) {
    console.error(helpMessage(subject));
    process.exit(1);
  }
  process.exit(0);
}
