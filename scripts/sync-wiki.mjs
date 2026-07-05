// Mirrors docs/wiki/* into the separate Castwright.wiki.git repo. GitHub
// wikis have no PR review/CI/branch protection, so the source of truth
// lives here and this script is the one-way publish step.
//
//   npm run wiki:sync
//
// Run manually after a merge to main touches docs/wiki/**. Refuses to push a
// sync that would delete more than DELETE_THRESHOLD pages — re-run with
// `-- --allow-deletes` to confirm an intentional bulk removal (#1343).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from './lib/run-command.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WIKI_REMOTE = 'https://github.com/dudarenok-maker/Castwright.wiki.git';

// #1343 — refuse an unattended mass-deletion. copyWikiTree mirrors by wiping
// every pre-existing dest entry, so a page removed from docs/wiki/ (correctly,
// or by a bug in a generator script) is otherwise silently and permanently
// gone from the live wiki on the next sync — GitHub wikis have no PR review/CI
// of their own to catch it first.
export const DELETE_THRESHOLD = 3;

function listWikiFiles(dir) {
  const out = new Set();
  if (!existsSync(dir)) return out;
  const walk = (current, rel) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath, entryRel);
      else out.add(entryRel);
    }
  };
  walk(dir, '');
  return out;
}

// Diffs the incoming docs/wiki/ tree against the current wiki clone BEFORE
// copyWikiTree mutates anything, so the caller can gate the push on it.
export function diffWikiTree(srcDir, destDir) {
  const srcFiles = listWikiFiles(srcDir);
  const destFiles = listWikiFiles(destDir);
  const added = [...srcFiles].filter((f) => !destFiles.has(f)).sort();
  const removed = [...destFiles].filter((f) => !srcFiles.has(f)).sort();
  const changed = [...srcFiles]
    .filter((f) => destFiles.has(f))
    .filter(
      (f) =>
        !readFileSync(path.join(srcDir, f)).equals(readFileSync(path.join(destDir, f))),
    )
    .sort();
  return { added, removed, changed };
}

// True when the sync should be refused pending an explicit --allow-deletes.
export function exceedsDeleteThreshold(removedCount, allowDeletes) {
  return removedCount > DELETE_THRESHOLD && !allowDeletes;
}

export function copyWikiTree(srcDir, destDir) {
  if (!existsSync(srcDir)) {
    throw new Error(`sync-wiki: source directory not found: ${srcDir}`);
  }
  // Mirror, not overlay: clear any pre-existing dest entries (e.g. from a
  // freshly-cloned wiki repo) other than .git, so a page/image deleted from
  // srcDir actually disappears from destDir instead of lingering forever.
  if (existsSync(destDir)) {
    for (const entry of readdirSync(destDir)) {
      if (entry === '.git') continue;
      rmSync(path.join(destDir, entry), { recursive: true, force: true });
    }
  }
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.git',
  });
}

export function buildCommitMessage(sourceSha) {
  return `sync wiki from Castwright@${sourceSha}`;
}

function run(cmd, args, cwd) {
  return runCommand('sync-wiki', cmd, args, { cwd });
}

function getSourceSha() {
  return run('git', ['rev-parse', '--short', 'HEAD'], REPO_ROOT).trim();
}

// A GitHub wiki's git repo does not exist until at least one page exists —
// enabling has_wiki alone doesn't create it, so clone fails on a
// never-touched wiki and we bootstrap it instead.
function cloneOrInitWikiRepo(cacheDir) {
  rmSync(cacheDir, { recursive: true, force: true });
  const clone = spawnSync('git', ['clone', WIKI_REMOTE, cacheDir], { encoding: 'utf8' });
  if (clone.status === 0) return { fresh: false };

  mkdirSync(cacheDir, { recursive: true });
  run('git', ['init'], cacheDir);
  run('git', ['remote', 'add', 'origin', WIKI_REMOTE], cacheDir);
  return { fresh: true };
}

async function main() {
  const cacheDir = path.join(REPO_ROOT, '.wiki-sync-cache');
  const srcDir = path.join(REPO_ROOT, 'docs', 'wiki');
  const allowDeletes = process.argv.includes('--allow-deletes');

  const { fresh } = cloneOrInitWikiRepo(cacheDir);

  const { added, removed, changed } = diffWikiTree(srcDir, cacheDir);
  process.stdout.write(
    `sync-wiki: ${added.length} added, ${changed.length} changed, ${removed.length} removed\n`,
  );
  if (exceedsDeleteThreshold(removed.length, allowDeletes)) {
    throw new Error(
      [
        `sync-wiki: refusing to push — this sync would delete ${removed.length} page(s):`,
        ...removed.map((f) => `  - ${f}`),
        'Re-run with --allow-deletes to confirm.',
      ].join('\n'),
    );
  }

  copyWikiTree(srcDir, cacheDir);

  run('git', ['add', '-A'], cacheDir);
  const sha = getSourceSha();
  run('git', ['commit', '-m', buildCommitMessage(sha), '--allow-empty'], cacheDir);
  run('git', fresh ? ['push', '-u', 'origin', 'HEAD:master'] : ['push'], cacheDir);

  process.stdout.write(`sync-wiki: pushed docs/wiki -> ${WIKI_REMOTE}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
