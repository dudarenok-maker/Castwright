import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideGuardVerdict,
  listKnownCheckoutRoots,
  PRIMARY_CHECKOUT_ROOT,
  PROJECTS_ROOT,
} from '../hooks/guard-worktree-write.mjs';

const WORKTREE = 'C:\\Claude\\Projects\\wt-3044-worktree-write-guard';
const SIBLING_WORKTREE = 'C:\\Claude\\Projects\\wt-2997-commit-gate';
const KNOWN_ROOTS = [PRIMARY_CHECKOUT_ROOT, WORKTREE, SIBLING_WORKTREE];

// === Write ================================================================

test('Write inside the assigned worktree is allowed', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    toolInput: { file_path: `${WORKTREE}\\scripts\\hooks\\new-file.mjs`, content: 'x' },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, false);
});

test('Write to the primary checkout is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md`, content: 'x' },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /outside the assigned worktree/);
});

// === Edit ==================================================================

test('Edit to a sibling wt-* worktree is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Edit',
    toolInput: {
      file_path: `${SIBLING_WORKTREE}\\scripts\\hooks\\pre-commit-lint.mjs`,
      old_string: 'a',
      new_string: 'b',
    },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /outside the assigned worktree/);
});

// === Bash ==================================================================

test('Bash command referencing a foreign checkout root is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `type "${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md"` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

test('Bash command with no foreign path is allowed', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: 'wc -l CLAUDE.md' },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, false);
});

// === listKnownCheckoutRoots ================================================

test('listKnownCheckoutRoots always includes the primary checkout root', () => {
  const roots = listKnownCheckoutRoots(PROJECTS_ROOT);
  assert.ok(roots.includes(PRIMARY_CHECKOUT_ROOT));
});

test('listKnownCheckoutRoots falls back to just the primary root when the projects dir cannot be read', () => {
  const roots = listKnownCheckoutRoots('C:\\Claude\\Projects\\__does_not_exist__');
  assert.deepEqual(roots, [PRIMARY_CHECKOUT_ROOT]);
});
