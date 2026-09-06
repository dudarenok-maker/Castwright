#!/usr/bin/env node
// List active git worktrees + the slot each claims and the ports it is bound
// to, read from its generated .env.local AND server/.env. Companion to
// scripts/wt-new.mjs — answers "which worktrees do I have open and which
// ports is each on?" without grepping by hand.
//
// Usage: node scripts/wt-list.mjs

import { spawnSync } from 'node:child_process';
import { scrubGitEnv } from './git-env.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { isPrimaryCheckout, readClaimFiles, readSlotClaims } from './lib/worktree-slot.mjs';

const PORT_VARS = ['VITE_PORT', 'PORT', 'LOCAL_TTS_PORT', 'PLAYWRIGHT_PORT'];

function gitOrThrow(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, env: scrubGitEnv() });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function parseWorktreePorcelain(text) {
  const trees = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) trees.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('branch ')) {
      // `branch refs/heads/<name>` — strip the prefix.
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line === 'detached' && current) {
      current.branch = '(detached)';
    }
  }
  if (current) trees.push(current);
  return trees;
}

export function parseEnvLocal(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

// Port settings for one worktree, read from EVERY generated env file the slot
// scan reads (scripts/lib/worktree-slot.mjs's SLOT_CLAIM_FILES) rather than
// from `.env.local` alone.
//
// #3052, one column over from the slot column: `.env.local`'s own generated
// header says "safe to delete", and it is — for Vite. But `server/.env`
// survives that deletion still pinning the PORT and LOCAL_TTS_PORT the server
// and sidecar actually bind, so reading only `.env.local` printed
// `PORT=(default) LOCAL_TTS_PORT=(default)` for a tree bound to 8120/9040 —
// the two columns a slot-collision diagnosis turns on, reported as free.
//
// Merged in SLOT_CLAIM_FILES order, so `server/.env` wins on the keys both
// carry: where the two disagree, the server-side file is the one the process
// that binds the port reads.
function readPortsFor(worktreePath) {
  const files = readClaimFiles(worktreePath);
  if (files.length === 0) return null;
  const merged = {};
  for (const file of files) {
    if (file.content === null) continue;
    Object.assign(merged, parseEnvLocal(file.content));
  }
  return merged;
}

function formatTable(rows) {
  const header = ['slot', 'path', 'branch', ...PORT_VARS];
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    all.reduce((max, row) => Math.max(max, String(row[col] ?? '').length), 0),
  );
  const fmt = (row) =>
    row.map((cell, col) => String(cell ?? '').padEnd(widths[col])).join('  ');
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

// One table row per worktree. The `slot` column reports the slot the tree
// actually CLAIMS — read from its generated env files through the same
// helper scripts/wt-new.mjs allocates against — not the tree's position in
// `git worktree list`.
//
// #3052: it used to be the enumeration index, which is the very "slot ==
// position in the worktree list" premise wt-new.mjs stopped using. That made
// this table report N distinct slots over a fleet where three trees shared
// PORT=8250 — the tool a maintainer reaches for to diagnose a slot collision
// denied the collision existed. A tree claiming two different slots (its
// .env.local and server/.env disagreeing, e.g. one hand-edited) prints both,
// joined by "/", rather than silently picking one.
//
// The primary checkout claims nothing (wt-new.mjs never writes into it) but is
// slot 0 by definition — it runs the stock 5173/8080/9000 ports — so it prints
// `0`, not `(none)`. `(none)` there was a regression introduced alongside the
// claim-based slot column: it read as "unknown", when slot 0 is the one slot
// on the fleet that is certain.
export function buildRows(trees) {
  return trees.map((tree) => {
    const ports = readPortsFor(tree.path) ?? {};
    const { slots } = readSlotClaims(tree.path);
    const primaryFallback = isPrimaryCheckout(tree.path) ? '0' : '(none)';
    return [
      slots.length > 0 ? slots.join('/') : primaryFallback,
      tree.path,
      tree.branch ?? '(unknown)',
      ports.VITE_PORT ?? '(default)',
      ports.PORT ?? '(default)',
      ports.LOCAL_TTS_PORT ?? '(default)',
      ports.PLAYWRIGHT_PORT ?? '(default)',
    ];
  });
}

export function main() {
  const porcelain = gitOrThrow(['worktree', 'list', '--porcelain']);
  const trees = parseWorktreePorcelain(porcelain);
  if (trees.length === 0) {
    process.stdout.write('No worktrees found.\n');
    return 0;
  }
  process.stdout.write(formatTable(buildRows(trees)) + '\n');
  return 0;
}

// process.exit() truncates pending async stdout writes on POSIX pipes
// (synchronous on Windows, ASYNCHRONOUS on Linux/macOS) — see the comment by
// scripts/lib/is-main-module.mjs's own isDirectlyInvoked for why the
// process.exit(main()) shape is unsafe for anything but provably-tiny
// output. main()'s table can run to one row per worktree, so it doesn't
// qualify; setting exitCode and letting the process exit naturally once the
// event loop drains (main() is fully synchronous — no open handle survives
// its return) avoids the truncation instead.
if (isDirectlyInvoked(import.meta.url)) {
  process.exitCode = main();
}
