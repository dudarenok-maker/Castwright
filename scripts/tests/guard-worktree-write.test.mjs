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

// === transcriptPath assignment signal (Castwright#3263) ===================
// `cwd` alone is wrong whenever a dispatched agent's process `cwd` doesn't
// match the tree it was actually briefed at — measured at 626 of 715 real
// subagent transcripts (docs/ops/3263-transcript-signal-measurement.md), so
// this is the dominant shape, not an edge case. The transcript scan is
// therefore PREFERRED over cwd, failing open to cwd when it finds nothing.
//
// The fixtures below deliberately reproduce the two properties of a REAL
// transcript that the first cut of this feature (#3355) got wrong, and that
// its single-turn fixture could not express:
//   1. the brief LEADS with the prohibition, so the first absolute path in
//      it is the primary checkout — the one root that is never an assignment;
//   2. there are LATER prompt turns (skill preambles, notifications) whose
//      own first path is also under the primary.
// A fixture without both cannot fail on the shape that broke in production.

/** The verbatim opening of this repo's real fix-agent brief, as recorded in
 *  the measured corpus — prohibition first, assignment second. `wt-*` is a
 *  literal glob in the real text and stays one here: it resolves under no
 *  known root, so it exercises the "keep scanning" rule too. */
function fixAgentBriefTurn(assignedWorktree) {
  return {
    type: 'user',
    promptSource: 'sdk',
    turnOrigin: 'sdk',
    isSidechain: false,
    message: {
      role: 'user',
      content:
        'One finding, one fix, one paired regression test. Repo: `dudarenok-maker/Castwright`, ' +
        `primary checkout \`${PRIMARY_CHECKOUT_ROOT}\` — do NOT edit files in the primary ` +
        'checkout and do NOT touch any other `C:\\Claude\\Projects\\wt-*` worktree. ' +
        `Worktree: \`${assignedWorktree}\` (already checked out).`,
    },
  };
}

/** A later prompt-bearing turn whose first absolute path is under the primary
 *  checkout — a skill preamble, the shape that won the newest-first scan in
 *  222 of 456 real transcripts under #3355's implementation. */
const SKILL_PREAMBLE_TURN = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Base directory for this skill: ${PRIMARY_CHECKOUT_ROOT}\\.claude\\skills\\pr-review-gate\n# PR review gate\nThe mandated mechanism for CLAUDE.md's before-shipping step 10.`,
      },
    ],
  },
};

/** Writes a JSONL transcript from the given turn objects. Caller cleans up. */
function writeTranscript(turns) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-worktree-write-transcript-'));
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, turns.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');
  return { dir, file };
}

/** The realistic dispatch: prohibition-first brief, then a later
 *  primary-rooted turn, with `cwd` reporting the primary checkout — i.e.
 *  every property of the 626-transcript dominant shape at once. */
function realisticDispatch() {
  return writeTranscript([fixAgentBriefTurn(WORKTREE), SKILL_PREAMBLE_TURN]);
}

test('a legitimate write to the assigned worktree is ALLOWED on a realistic multi-turn, prohibition-first brief with cwd pointing at the primary (the #3263 shape)', () => {
  const { dir, file } = realisticDispatch();
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
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

test('the #3044 stray edit into the primary checkout is DENIED on that same realistic transcript', () => {
  // #3355 shipped a version that ALLOWED this: its scan returned the first
  // path in the newest turn, which on this shape is under the primary, so
  // the primary became the "assigned" root. This is that regression.
  const { dir, file } = realisticDispatch();
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\server\\src\\analyzer\\errors.ts`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, /outside the assigned worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Bash command committing in the primary checkout is DENIED on that same realistic transcript', () => {
  // The extracted root also becomes `ownRoot` for shell detection, so the
  // primary must become FOREIGN here even though `cwd` sits in it.
  const { dir, file } = realisticDispatch();
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Bash',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { command: `git -C ${PRIMARY_CHECKOUT_ROOT} commit -am wip` },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, /foreign checkout root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Bash command inside the extracted worktree is ALLOWED even though cwd reports the primary', () => {
  const { dir, file } = realisticDispatch();
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Bash',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { command: `git -C ${WORKTREE} status --porcelain` },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PowerShell command referencing a sibling worktree is still DENIED when the assigned root came from the transcript', () => {
  const { dir, file } = realisticDispatch();
  try {
    const verdict = decideGuardVerdict({
      toolName: 'PowerShell',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { command: `Remove-Item -Recurse ${SIBLING_WORKTREE}\\node_modules` },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, /foreign checkout root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- polarity: the primary checkout is never an assignment ----------------

test('a transcript whose only absolute paths are under the primary checkout yields NO pick and falls open to cwd', () => {
  const { dir, file } = writeTranscript([SKILL_PREAMBLE_TURN]);
  try {
    const withTranscript = decideGuardVerdict({
      toolName: 'Write',
      cwd: WORKTREE,
      toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    const without = decideGuardVerdict({
      toolName: 'Write',
      cwd: WORKTREE,
      toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md`, content: 'x' },
      knownRoots: KNOWN_ROOTS,
    });
    // Byte-identical to the no-signal verdict — that is the fail-open contract.
    assert.deepEqual(withTranscript, without);
    assert.equal(withTranscript.deny, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a primary-rooted path in the NEWEST turn does not stop the scan reaching the assigned root in an earlier one', () => {
  // Distinguishes "skip the primary and keep scanning" (rule 2) from the
  // weaker "discard a primary pick", which would return null here and leave
  // the legitimate write denied.
  const { dir, file } = realisticDispatch();
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${WORKTREE}\\docs\\note.md`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fail-open branches, one test each ------------------------------------

test('the same cwd-wrong-root Write is denied without a transcriptPath (the pre-#3263 baseline)', () => {
  const verdict = decideGuardVerdict({
    toolName: 'Write',
    cwd: PRIMARY_CHECKOUT_ROOT,
    toolInput: { file_path: `${WORKTREE}\\src\\module.mjs`, content: 'x' },
    knownRoots: KNOWN_ROOTS,
  });
  assert.equal(verdict.deny, true);
  assert.match(verdict.reason, /outside the assigned worktree/);
});

test('a transcriptPath pointing at a nonexistent file fails open to the cwd-derived root', () => {
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

test('a wholly malformed transcript fails open to the cwd-derived root rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-worktree-write-transcript-'));
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, `not json at all\n{"type":"user",\n]]}{\n`, 'utf8');
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: WORKTREE,
      toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\RELEASE_NOTES.md`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, /outside the assigned worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed line does not discard the valid turns around it', () => {
  const { dir: d0 } = writeTranscript([]);
  rmSync(d0, { recursive: true, force: true });
  const dir = mkdtempSync(join(tmpdir(), 'guard-worktree-write-transcript-'));
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, `${JSON.stringify(fixAgentBriefTurn(WORKTREE))}\n{ broken\n`, 'utf8');
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
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

test('an extracted path that resolves under NO known root is ignored, not trusted', () => {
  // The security-weightiest fail-open branch: an unknown root must never
  // become the assigned root, or the guard would stop protecting anything.
  const { dir, file } = writeTranscript([fixAgentBriefTurn('C:\\Somewhere\\Else\\not-a-worktree')]);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: WORKTREE,
      toolInput: { file_path: 'C:\\Somewhere\\Else\\not-a-worktree\\x.ts', content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, /outside the assigned worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn with no prompt text at all is skipped rather than ending the scan', () => {
  const emptyTurn = { type: 'user', promptSource: 'sdk', message: { role: 'user', content: '' } };
  const systemTurn = { type: 'user', promptSource: 'system', message: { role: 'user', content: `see ${SIBLING_WORKTREE}\\a.ts` } };
  const { dir, file } = writeTranscript([fixAgentBriefTurn(WORKTREE), emptyTurn, systemTurn]);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
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

// --- the accepted residual risk, locked in so it stays visible ------------

test('KNOWN LIMIT: a confident pick of the WRONG known worktree inverts the guard (measured 0.9%, accepted)', () => {
  // Not a bug report — this is the residual risk the doc comment names,
  // asserted so that anyone who later closes it sees this test go red and
  // knows to update the contract rather than discovering the change by
  // accident. Fail-open covers "found nothing", never "found the wrong
  // known root".
  const { dir, file } = writeTranscript([fixAgentBriefTurn(SIBLING_WORKTREE)]);
  try {
    const legitimate = decideGuardVerdict({
      toolName: 'Write',
      cwd: WORKTREE,
      toolInput: { file_path: `${WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(legitimate.deny, true, 'a write to the truly-assigned tree is wrongly denied');
    const foreign = decideGuardVerdict({
      toolName: 'Write',
      cwd: WORKTREE,
      toolInput: { file_path: `${SIBLING_WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(foreign.deny, false, 'a write to the mis-extracted tree is wrongly allowed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- whose text counts as authoritative (PR #3358 review pass 2, N3) ------
// These two filters decide which parts of a transcript may name the assigned
// root. Both were mutable without turning the suite red, which meant the
// contract "only the operator's own prompt turns are authoritative" was
// unasserted — and an agent can put an arbitrary path into a tool result or
// into its own assistant text, so widening either would let the guarded
// process choose the root that guards it.

test('text the AGENT produced cannot name the assigned root — assistant turns are ignored', () => {
  const assistantTurn = {
    type: 'assistant',
    promptSource: 'sdk',
    message: { role: 'assistant', content: `I will work in ${SIBLING_WORKTREE} instead.` },
  };
  const { dir, file } = writeTranscript([fixAgentBriefTurn(WORKTREE), assistantTurn]);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${SIBLING_WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, new RegExp(WORKTREE.replace(/\\/g, '\\\\')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text inside a tool_result block cannot name the assigned root — only text blocks count', () => {
  const toolResultTurn = {
    type: 'user',
    promptSource: 'sdk',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: `cd ${SIBLING_WORKTREE} && ls` }],
    },
  };
  const { dir, file } = writeTranscript([fixAgentBriefTurn(WORKTREE), toolResultTurn]);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${SIBLING_WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, true);
    assert.match(verdict.reason, new RegExp(WORKTREE.replace(/\\/g, '\\\\')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scan runs NEWEST turn first — a re-assignment supersedes the original brief', () => {
  // Pins the direction. It is a real choice, not an accident: the measurement
  // scores newest-first at 99.1% and first-turn-anchored at 98.9%, and
  // newest-first is what makes a mid-session re-assignment take effect.
  const reassignment = {
    type: 'user',
    promptSource: 'sdk',
    message: { role: 'user', content: `Change of plan — work in ${SIBLING_WORKTREE} from here on.` },
  };
  const { dir, file } = writeTranscript([fixAgentBriefTurn(WORKTREE), reassignment]);
  try {
    const toNewest = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${SIBLING_WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(toNewest.deny, false);
    const toOriginal = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(toOriginal.deny, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON-escape debris is skipped even when its HEAD resolves to a known root — #3340s predicate still discriminates', () => {
  // A candidate like `…\wt-2997-commit-gate\nC:\…\wt-3044-…` is one regex
  // match: a literal backslash-n glues two paths together. Its head resolves
  // cleanly under SIBLING_WORKTREE, so the knownRoots membership check alone
  // would accept it and return the WRONG root. #3340's escape-debris
  // predicate is what rejects it, letting the scan reach the real assignment.
  //
  // This is the shape the first version of this test missed: it used debris
  // whose head matched no known root, so membership rejected it anyway and
  // gutting the predicate left the suite green (PR #3358 review pass 2, N3).
  const debrisTurn = {
    type: 'user',
    promptSource: 'sdk',
    message: {
      role: 'user',
      content: `log tail: ${SIBLING_WORKTREE}\\n\\n${WORKTREE}\\src\\module.mjs`,
    },
  };
  const { dir, file } = writeTranscript([fixAgentBriefTurn(WORKTREE), debrisTurn]);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
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

test('a brief that assigns the PRIMARY checkout and names no other root is handled correctly', () => {
  // The real primary-assigned brief shape (1 of ~1,594 measured transcripts),
  // verbatim from the corpus. The scan finds no non-primary candidate, returns
  // null, and `cwd` — also the primary — stands, so the write is allowed.
  const turn = {
    type: 'user',
    promptSource: 'sdk',
    message: {
      role: 'user',
      content:
        `Repo: ${PRIMARY_CHECKOUT_ROOT} (Castwright). Fix two correctness findings from the PR ` +
        `review gate. This branch is currently checked out in the primary checkout at ` +
        `${PRIMARY_CHECKOUT_ROOT} — work there directly (it's a small single-file docs-comment ` +
        `PR, not worth a worktree), commit, and push.`,
    },
  };
  const { dir, file } = writeTranscript([turn]);
  try {
    const verdict = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\scripts\\verify-cache.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(verdict.deny, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('KNOWN LIMIT: a PRIMARY-assigned brief that also mentions a live worktree inverts the guard (0 observed, accepted)', () => {
  // The second residual-risk shape, and the only one that is a REGRESSION
  // against pre-#3263 `cwd` behaviour rather than a failure to improve on it:
  // rule 1 skips the real assignment and the scan takes the incidental tree.
  // Zero occurrences in ~1,594 real transcripts, but reachable. Asserted so
  // that closing it is deliberate. See PRIMARY_CHECKOUT_ROOT's declaration.
  const turn = {
    type: 'user',
    promptSource: 'sdk',
    message: {
      role: 'user',
      content:
        `This branch is checked out in the primary checkout at ${PRIMARY_CHECKOUT_ROOT} — work ` +
        `there directly, not worth a worktree. (For context, the related change landed in ` +
        `${SIBLING_WORKTREE} last week.)`,
    },
  };
  const { dir, file } = writeTranscript([turn]);
  try {
    const legitimate = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${PRIMARY_CHECKOUT_ROOT}\\scripts\\verify-cache.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(legitimate.deny, true, 'the truly-assigned primary checkout is wrongly denied');
    const foreign = decideGuardVerdict({
      toolName: 'Write',
      cwd: PRIMARY_CHECKOUT_ROOT,
      toolInput: { file_path: `${SIBLING_WORKTREE}\\src\\module.mjs`, content: 'x' },
      transcriptPath: file,
      knownRoots: KNOWN_ROOTS,
    });
    assert.equal(foreign.deny, false, 'the incidentally-mentioned tree is wrongly allowed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
