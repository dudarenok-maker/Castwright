#!/usr/bin/env node
// List active git worktrees + the port assignments each has in its
// .env.local. Companion to scripts/wt-new.mjs — answers "which worktrees
// do I have open and which ports is each on?" without grepping by hand.
//
// Usage: node scripts/wt-list.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT_VARS = ['VITE_PORT', 'PORT', 'LOCAL_TTS_PORT', 'PLAYWRIGHT_PORT'];

function gitOrThrow(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
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

function readPortsFor(worktreePath) {
  const envPath = join(worktreePath, '.env.local');
  if (!existsSync(envPath)) return null;
  try {
    return parseEnvLocal(readFileSync(envPath, 'utf8'));
  } catch {
    return null;
  }
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

export function main() {
  const porcelain = gitOrThrow(['worktree', 'list', '--porcelain']);
  const trees = parseWorktreePorcelain(porcelain);
  if (trees.length === 0) {
    process.stdout.write('No worktrees found.\n');
    return 0;
  }
  const rows = trees.map((tree, slot) => {
    const ports = readPortsFor(tree.path) ?? {};
    return [
      slot,
      tree.path,
      tree.branch ?? '(unknown)',
      ports.VITE_PORT ?? '(default)',
      ports.PORT ?? '(default)',
      ports.LOCAL_TTS_PORT ?? '(default)',
      ports.PLAYWRIGHT_PORT ?? '(default)',
    ];
  });
  process.stdout.write(formatTable(rows) + '\n');
  return 0;
}

const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/wt-list.mjs');

if (invokedAsCli) {
  process.exit(main());
}
