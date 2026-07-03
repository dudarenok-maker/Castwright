import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { resolveCopyPlan, DOCS_TO_PUBLISH } from '../sync-docs-to-public.mjs';

test('resolveCopyPlan: maps each doc to its docs/ source and public/docs/ dest', () => {
  const plan = resolveCopyPlan('/repo');
  assert.equal(plan.length, DOCS_TO_PUBLISH.length);
  for (const { name, src, dest } of plan) {
    assert.equal(src, join('/repo', 'docs', name));
    assert.equal(dest, join('/repo', 'public', 'docs', name));
  }
});

test('resolveCopyPlan: local-llm.md is published (issue #1223 — the two dead Advanced Configuration links)', () => {
  const plan = resolveCopyPlan('/repo');
  const entry = plan.find((p) => p.name === 'local-llm.md');
  assert.ok(entry, 'local-llm.md must be in the copy plan');
  assert.ok(entry.dest.endsWith(`public${sep}docs${sep}local-llm.md`));
});

test('resolveCopyPlan: an empty doc list yields an empty plan', () => {
  assert.deepEqual(resolveCopyPlan('/repo', []), []);
});
