import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGuardVerdict, listKnownCheckoutRoots, PRIMARY_CHECKOUT_ROOT } from '../hooks/guard-worktree-write.mjs';

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

// === cwd as a subdirectory, not a worktree root (Castwright#3261 review pass 3, C7) ===
// A real dispatched agent's cwd for a given tool call is not always the
// worktree ROOT. Comparing the containment check against raw cwd (rather
// than the known root cwd resolves to) denied a legitimate write from any
// tool call issued from a subdirectory — invisible to every test above,
// which all set cwd to a root already.

test('Write to a sibling file, issued while cwd is a SUBDIRECTORY of the assigned worktree, is allowed', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    toolInput: { file_path: `${WORKTREE}\\CLAUDE.md`, content: 'x' },
    cwd: `${WORKTREE}\\src`,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, false);
});

test('Write to a foreign root is still denied when cwd is a subdirectory of the assigned worktree', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md`, content: 'x' },
    cwd: `${WORKTREE}\\src`,
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

// === NotebookEdit (Castwright#3261 review pass 1, C3) ======================

test('NotebookEdit to a sibling worktree is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'NotebookEdit',
    toolInput: { notebook_path: `${SIBLING_WORKTREE}\\notebooks\\analysis.ipynb`, new_source: 'x' },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /outside the assigned worktree/);
});

test('NotebookEdit inside the assigned worktree is allowed', () => {
  const verdict = decideGuardVerdict({
    toolName: 'NotebookEdit',
    toolInput: { notebook_path: `${WORKTREE}\\notebooks\\analysis.ipynb`, new_source: 'x' },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, false);
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

// === Bash path-spelling coverage (Castwright#3261 review pass 1, C2) =======
// The prior version only matched the literal backslash spelling. Git Bash
// (this repo's own primary Bash tool, per CLAUDE.md) idiomatically emits
// forward-slash and `/c/...`-mount forms; WSL uses `/mnt/c/...`. All four
// must be caught — a command referencing the foreign root by ANY of them is
// exactly as dangerous as the backslash form.

test('Bash command referencing a foreign root via forward slashes is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `cat "C:/Claude/Projects/Audiobook-Generator/RELEASE_NOTES.md"` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

test('Bash command referencing a foreign root via the Git Bash /c/ mount form is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `git -C /c/Claude/Projects/Audiobook-Generator status` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

test('Bash command referencing a foreign root via the WSL /mnt/c/ form is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `cat /mnt/c/Claude/Projects/Audiobook-Generator/RELEASE_NOTES.md` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

// === Bash path-spelling coverage (Castwright#3261 review pass 2, C5) =======
// tool_input.command is the RAW string before the shell's own escape
// processing runs, so a command that resolves to a real Windows path at
// execution time can still arrive here doubled-backslash (the correct Git
// Bash spelling of a literal `\`) or with `/` and `\` mixed within one path.
// Pass 1's fix only caught the single-backslash and single-style forms.

test('Bash command referencing a foreign root via a doubled (Git-Bash-escaped) backslash is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `cat "C:\\\\Claude\\\\Projects\\\\Audiobook-Generator\\\\RELEASE_NOTES.md"` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

test('Bash command referencing a foreign root via mixed forward/back slashes is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `cat C:\\Claude/Projects\\Audiobook-Generator/RELEASE_NOTES.md` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

// === Bash path-boundary coverage (Castwright#3261 review pass 2, C6) =======
// A root that is a literal string prefix of a sibling worktree's own name
// (a shape wt-new.mjs actively mints, e.g. wt-3243 / wt-3243-followup) must
// not deny a command that only ever references the agent's OWN tree.

test('Bash command referencing only the agent\'s own worktree is allowed, even when a sibling root is its name prefix', () => {
  const shortSibling = 'C:\\Claude\\Projects\\wt-3243';
  const ownWorktree = 'C:\\Claude\\Projects\\wt-3243-followup';
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `ls "${ownWorktree}\\src"` },
    cwd: ownWorktree,
    knownRoots: [PRIMARY_CHECKOUT_ROOT, shortSibling, ownWorktree],
  });
  assert.equal(verdict.deny, false);
});

test('Bash command referencing a sibling root that is a name-prefix of a longer one is still denied on its own', () => {
  const shortSibling = 'C:\\Claude\\Projects\\wt-3243';
  const longerSibling = 'C:\\Claude\\Projects\\wt-3243-followup';
  const verdict = decideGuardVerdict({
    toolName: 'Bash',
    toolInput: { command: `ls "${shortSibling}\\src"` },
    cwd: longerSibling,
    knownRoots: [PRIMARY_CHECKOUT_ROOT, shortSibling, longerSibling],
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

// === PowerShell (Castwright#3261 review pass 1, C3) ========================

test('PowerShell command referencing a foreign checkout root is denied', () => {
  const verdict = decideGuardVerdict({
    toolName: 'PowerShell',
    toolInput: { command: `Get-Content "${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md"` },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /foreign checkout root/);
});

test('PowerShell command with no foreign path is allowed', () => {
  const verdict = decideGuardVerdict({
    toolName: 'PowerShell',
    toolInput: { command: 'Get-ChildItem' },
    cwd: WORKTREE,
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, false);
});

// === listKnownCheckoutRoots (Castwright#3261 review pass 1, C4) ============
// Sourced from `git worktree list`, not a `wt-*`/PROJECTS_ROOT naming
// convention — real worktrees in this repo violate both (a `scratch-*`
// prefix, or a tree under the OS temp dir entirely), and the prior
// directory-scan approach silently missed them.

test('listKnownCheckoutRoots always includes the primary checkout root', () => {
  const roots = listKnownCheckoutRoots();
  assert.ok(roots.includes(PRIMARY_CHECKOUT_ROOT));
});

// Fixture porcelain output modeled on this repo's own real `git worktree
// list` shape (see the primary checkout's actual output): a name that does
// not start with `wt-`, and a tree that lives entirely outside any single
// hardcoded parent directory. A fixture, not live system state — worktrees
// come and go as this repo's own workflow tears them down.
const FAKE_PORCELAIN = [
  `worktree ${PRIMARY_CHECKOUT_ROOT}`,
  'HEAD 0000000000000000000000000000000000000000',
  'branch refs/heads/main',
  '',
  'worktree C:/Claude/Projects/scratch-3076-rebase',
  'HEAD 0000000000000000000000000000000000000000',
  'detached',
  '',
  'worktree C:/Users/dudar/AppData/Local/Temp/open-engine-ringer/oe-heartbeat/wt-3238',
  'HEAD 0000000000000000000000000000000000000000',
  'branch refs/heads/fix/scripts-3238-collect-process-snapshot-retry',
  '',
].join('\n');

test('listKnownCheckoutRoots includes a worktree whose name does not start with wt- (git is the source of truth, not a name filter)', () => {
  const roots = listKnownCheckoutRoots({ spawn: () => ({ status: 0, stdout: FAKE_PORCELAIN }) });
  assert.ok(roots.some((r) => /scratch-3076-rebase/i.test(r)));
});

test('listKnownCheckoutRoots includes a worktree living outside any single hardcoded parent directory', () => {
  const roots = listKnownCheckoutRoots({ spawn: () => ({ status: 0, stdout: FAKE_PORCELAIN }) });
  assert.ok(roots.some((r) => /wt-3238/i.test(r) && /open-engine-ringer/i.test(r)));
});

test('listKnownCheckoutRoots falls back to just the primary root when git fails', () => {
  const roots = listKnownCheckoutRoots({ spawn: () => ({ error: new Error('git not found') }) });
  assert.deepEqual(roots, [PRIMARY_CHECKOUT_ROOT]);
});

test('listKnownCheckoutRoots falls back to just the primary root on a non-zero git exit', () => {
  const roots = listKnownCheckoutRoots({ spawn: () => ({ status: 1, stdout: '' }) });
  assert.deepEqual(roots, [PRIMARY_CHECKOUT_ROOT]);
});

// === transcriptPath H2 extraction fallback (Castwright#3355) ===============
// #3263: `cwd` alone is wrong whenever a dispatched agent's process `cwd`
// doesn't match the tree it was actually briefed at. H2 (the first absolute
// path in the most recent sdk/user-sourced transcript turn) is layered as a
// PREFERENCE over cwd, not a replacement — see decideGuardVerdict's doc
// comment. These tests exercise both directions of that fail-open contract.

/** Writes a minimal single-turn JSONL fixture transcript whose one sdk-
 *  sourced turn names `assignedPath`, mirroring the real brief shape
 *  recorded in docs/ops/3263-fix-agent-dispatch-transcript-findings.md
 *  ("You are briefed to work at the existing worktree <path> (this worktree
 *  already exists...)"). Caller is responsible for cleaning up `dir`. */
function makeFixtureTranscript(assignedPath) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-worktree-write-h2-'));
  const file = join(dir, 'transcript.jsonl');
  const turn = {
    type: 'user',
    promptSource: 'sdk',
    turnOrigin: 'sdk',
    isSidechain: false,
    message: {
      role: 'user',
      content: `You are briefed to work at the existing worktree ${assignedPath} (this worktree already exists and is checked out).`,
    },
  };
  writeFileSync(file, `${JSON.stringify(turn)}\n`, 'utf8');
  return { dir, file };
}

test('a Write is resolved via transcriptPath H2 extraction to an ALLOW when cwd reports the WRONG root (the exact #3263 failure shape)', () => {
  const { dir, file } = makeFixtureTranscript(`${WORKTREE}\\src\\module.mjs`);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      // cwd reports the PRIMARY checkout — today's cwd-only logic would deny
      // this write to WORKTREE outright, reproducing #3263's documented
      // production failure.
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same cwd-wrong-root Write is still denied without a transcriptPath (baseline for the test above)', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    cwd: PRIMARY_CHECKOUT_ROOT,
    toolInput: { file_path: `${WORKTREE}\\src\\module.mjs`, content: 'x' },
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /outside the assigned worktree/);
});

test('a transcriptPath pointing at a nonexistent file fails open to the cwd-derived root, identical to omitting transcriptPath', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md`, content: 'x' },
    cwd: WORKTREE,
    transcriptPath: 'C:\\does\\not\\exist\\transcript.jsonl',
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /outside the assigned worktree/);
});
