// Unit coverage for the pure isArchivable predicate in clear-done-project-items.mjs.
// No `gh`, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isArchivable } from '../clear-done-project-items.mjs';

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
