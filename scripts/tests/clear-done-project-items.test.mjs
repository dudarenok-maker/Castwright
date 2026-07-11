// Unit coverage for the pure isArchivable predicate in clear-done-project-items.mjs.
// No `gh`, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isArchivable, buildArchiveMutationArgs } from '../clear-done-project-items.mjs';

test('isArchivable excludes a moscow:wont issue even when its Status is Done', () => {
  const node = {
    status: { name: 'Done' },
    content: { number: 437, title: 'ops-5', labels: { nodes: [{ name: 'moscow:wont' }, { name: 'type:feature' }] } },
  };
  assert.equal(isArchivable(node), false);
});

test('isArchivable includes a plain Done item with no moscow:wont label', () => {
  const node = {
    status: { name: 'Done' },
    content: { number: 973, title: 'fs-51', labels: { nodes: [{ name: 'moscow:must' }, { name: 'type:feature' }] } },
  };
  assert.equal(isArchivable(node), true);
});

test('isArchivable excludes a non-Done item', () => {
  const node = {
    status: { name: 'Backlog' },
    content: { number: 1, title: 'x', labels: { nodes: [] } },
  };
  assert.equal(isArchivable(node), false);
});

test('isArchivable excludes a node with no content (e.g. a draft item)', () => {
  const node = { status: { name: 'Done' }, content: null };
  assert.equal(isArchivable(node), false);
});

// Regression for #1503: `gh project item-archive --owner <login>` fails in
// CI with "unknown owner type" because the ADD_TO_PROJECT_PAT (project+repo
// scopes only) can't satisfy gh's internal owner-type resolution. The fix
// archives via a raw `archiveProjectV2Item` GraphQL mutation instead, which
// needs only the project ID — never an owner login.
test('buildArchiveMutationArgs never invokes the owner-resolving CLI form', () => {
  const args = buildArchiveMutationArgs('PVT_kwHOEOX6_c4Bcf9a', 'PVTI_lAHOEOX6_c4Bcf9azgySYBo');
  assert.ok(!args.includes('--owner'), 'must not pass --owner (triggers gh CLI owner-type resolution)');
  assert.ok(!args.includes('item-archive'), 'must not use the `gh project item-archive` subcommand');
});

test('buildArchiveMutationArgs issues a raw archiveProjectV2Item mutation with the project + item IDs', () => {
  const args = buildArchiveMutationArgs('PVT_kwHOEOX6_c4Bcf9a', 'PVTI_lAHOEOX6_c4Bcf9azgySYBo');
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  const queryArg = args.find((a) => a.startsWith('query='));
  assert.ok(queryArg?.includes('archiveProjectV2Item'));
  assert.ok(args.includes('projectId=PVT_kwHOEOX6_c4Bcf9a'));
  assert.ok(args.includes('itemId=PVTI_lAHOEOX6_c4Bcf9azgySYBo'));
});
