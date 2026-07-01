import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDocsOnlyFile, isDocsOnlyDiff, evaluateDocsOnlyPush } from '../is-docs-only-push.mjs';

const ZERO = '0'.repeat(40);
const line = (localSha, remoteSha = ZERO, remoteRef = 'refs/heads/feature') =>
  `refs/heads/feature ${localSha} ${remoteRef} ${remoteSha}`;

test('isDocsOnlyFile matches docs/**, root *.md, and .github/*.md', () => {
  assert.equal(isDocsOnlyFile('docs/features/1-foo.md'), true);
  assert.equal(isDocsOnlyFile('docs/superpowers/specs/x.md'), true);
  assert.equal(isDocsOnlyFile('CLAUDE.md'), true);
  assert.equal(isDocsOnlyFile('README.md'), true);
  assert.equal(isDocsOnlyFile('.github/pull_request_template.md'), true);
});

test('isDocsOnlyFile rejects nested .github and non-doc paths', () => {
  assert.equal(isDocsOnlyFile('.github/workflows/verify.yml'), false);
  assert.equal(isDocsOnlyFile('.github/ISSUE_TEMPLATE/bug.md'), false); // not a direct child
  assert.equal(isDocsOnlyFile('src/App.tsx'), false);
  assert.equal(isDocsOnlyFile('server/src/index.ts'), false);
});

test('isDocsOnlyDiff requires at least one file and all matching', () => {
  assert.equal(isDocsOnlyDiff([]), false);
  assert.equal(isDocsOnlyDiff(['CLAUDE.md', 'docs/features/1-foo.md']), true);
  assert.equal(isDocsOnlyDiff(['CLAUDE.md', 'src/App.tsx']), false);
});

test('a push touching only docs is docs-only', () => {
  const r = evaluateDocsOnlyPush(line('aaa'), {
    listChangedFiles: () => ['CLAUDE.md', 'docs/features/1-foo.md'],
  });
  assert.equal(r.docsOnly, true);
});

test('a push touching any non-doc file is not docs-only', () => {
  const r = evaluateDocsOnlyPush(line('aaa'), {
    listChangedFiles: () => ['CLAUDE.md', 'src/App.tsx'],
  });
  assert.equal(r.docsOnly, false);
});

test('uncertainty (listChangedFiles returns null) never skips verify', () => {
  const r = evaluateDocsOnlyPush(line('aaa'), {
    listChangedFiles: () => null,
  });
  assert.equal(r.docsOnly, false);
});

test('a deletion (zero local sha) contributes nothing and is not docs-only', () => {
  let called = false;
  const r = evaluateDocsOnlyPush(line(ZERO), {
    listChangedFiles: () => {
      called = true;
      return ['CLAUDE.md'];
    },
  });
  assert.equal(called, false);
  assert.equal(r.docsOnly, false);
});

test('multiple refs are unioned — one non-doc file anywhere blocks the skip', () => {
  const stdin = `${line('aaa', ZERO, 'refs/heads/a')}\n${line('bbb', ZERO, 'refs/heads/b')}`;
  const files = { aaa: ['CLAUDE.md'], bbb: ['src/App.tsx'] };
  const r = evaluateDocsOnlyPush(stdin, {
    listChangedFiles: (_remoteSha, localSha) => files[localSha],
  });
  assert.equal(r.docsOnly, false);
});

test('no ref lines at all is not docs-only (nothing to skip)', () => {
  const r = evaluateDocsOnlyPush('', {
    listChangedFiles: () => {
      throw new Error('should not be called');
    },
  });
  assert.equal(r.docsOnly, false);
});
