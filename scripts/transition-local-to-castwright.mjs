#!/usr/bin/env node
/* DEV-ONLY one-time transition: rename this machine's existing data dirs to the
   Castwright names so our real books + settings carry over after the rename.
   NOT shipped, NOT wired into the app — alpha users get fresh dirs.
   Usage: node scripts/transition-local-to-castwright.mjs [--apply]  (dry-run default). */
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAIRS = [
  { oldRel: '../audiobook-workspace', newRel: '../castwright-workspace', base: 'repo' },
  { old: '.audiobook-generator', new: '.castwright', base: 'home' },
];

/** Pure: which moves are needed. Each entry { from, to } is an absolute pair. */
export function planTransition({ home, repoRoot, exists }) {
  const out = [];
  for (const p of PAIRS) {
    const from = p.base === 'home' ? join(home, p.old) : join(repoRoot, p.oldRel);
    const to = p.base === 'home' ? join(home, p.new) : join(repoRoot, p.newRel);
    if (exists(from) && !exists(to)) out.push({ from, to });
  }
  return out;
}

function main() {
  const apply = process.argv.includes('--apply');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = planTransition({ home: homedir(), repoRoot, exists: existsSync });
  if (plan.length === 0) {
    console.log('[transition] nothing to do (old dirs missing or new dirs already present).');
    return;
  }
  for (const { from, to } of plan) {
    if (apply) {
      renameSync(from, to);
      console.log(`[transition] moved ${from} -> ${to}`);
    } else {
      console.log(`[transition] would move ${from} -> ${to}  (run with --apply)`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('transition-local-to-castwright.mjs')) {
  main();
}
