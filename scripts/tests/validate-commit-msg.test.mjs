// Tests for the commit-msg validator.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommitSubject, extractSubject, TYPES, SCOPES } from '../validate-commit-msg.mjs';

const accepted = [
  'feat(frontend): add voice library compare entry',
  'fix(server): retry batch on 429',
  'refactor(sidecar): split synth pipeline',
  'feat(app): scaffold the Flutter companion app',
  'perf(server): cache analyzer prompts',
  'test(e2e): cover sticky generation across navigation',
  'docs(docs): add plan 38',
  'build(deps): bump vitest to 2.1.9',
  'ci(ci): pin Node 20.6 in workflow',
  'chore: bump version',
  'chore(deps): bump openapi-typescript',
  'chore(frontend): tidy imports',
  'feat(frontend,openapi): align ChapterSummary field',
  'fix(server,sidecar,frontend): unify error envelope',
  'feat(server)!: drop legacy field',
  'chore(deps)!: remove unused package',
  'Merge branch main into feat/server-foo',
  'Revert "feat(frontend): bad thing"',
  'fixup! feat(frontend): something',
  'squash! fix(server): something',
];

const rejected = [
  '',
  'feat: missing scope',
  'Fix: wrong case type',
  'feat(unknown): unknown scope',
  'feat(frontend) no colon space',
  'feat(frontend):no space after colon',
  'feat(frontend): ',
  'wip: not a known type',
  'feat(frontend,unknown): one bad scope',
  'feat(): empty scope',
  'feat frontend: missing parens',
  'plan 38 implement the thing',
  'fix:',
];

for (const subject of accepted) {
  test(`accepts: ${subject}`, () => {
    const result = validateCommitSubject(subject);
    assert.equal(
      result.ok,
      true,
      `expected ok=true for "${subject}", got ${JSON.stringify(result)}`,
    );
  });
}

for (const subject of rejected) {
  test(`rejects: ${JSON.stringify(subject)}`, () => {
    const result = validateCommitSubject(subject);
    assert.equal(
      result.ok,
      false,
      `expected ok=false for "${subject}", got ${JSON.stringify(result)}`,
    );
  });
}

test('rejects subjects over the length cap', () => {
  const subject = `feat(frontend): ${'x'.repeat(200)}`;
  const result = validateCommitSubject(subject);
  assert.equal(result.ok, false);
});

test('every documented type is acceptable in a typed commit', () => {
  for (const type of TYPES) {
    const result = validateCommitSubject(`${type}(frontend): does a thing`);
    assert.equal(result.ok, true, `expected ${type}(frontend) to be accepted`);
  }
});

test('every documented scope is acceptable', () => {
  for (const scope of SCOPES) {
    const result = validateCommitSubject(`feat(${scope}): does a thing`);
    assert.equal(result.ok, true, `expected scope ${scope} to be accepted`);
  }
});

test('extractSubject skips blank lines and # comments', () => {
  const content = [
    '# please write a subject',
    '',
    '',
    'feat(frontend): real subject',
    '',
    'body line',
  ].join('\n');
  assert.equal(extractSubject(content), 'feat(frontend): real subject');
});

test('extractSubject handles CRLF line endings', () => {
  const content = '# comment\r\n\r\nfeat(server): crlf safe\r\n';
  assert.equal(extractSubject(content), 'feat(server): crlf safe');
});

test('extractSubject returns empty string when no real subject present', () => {
  assert.equal(extractSubject('# just a comment\n#another'), '');
  assert.equal(extractSubject(''), '');
});
