#!/usr/bin/env node
/**
 * Copy docs referenced by in-app links into `public/docs/` before every
 * build (issue #1223).
 *
 * `docs/` isn't part of the shipped `dist/` bundle — only `public/` is — so
 * a plain `<a href="/docs/local-llm.md">` (Advanced Configuration's CUDA
 * env-shadow banner and read-only analyzer-device row) resolves fine against
 * the Vite dev server (which serves the whole repo) but 404s once built.
 * Runs as `prebuild` so `npm run build` always ships a fresh copy; the
 * `public/docs/` output is git-ignored (docs/local-llm.md is already
 * tracked — this script is the only source of truth for the copy, so
 * committing it too would just be a second place for it to go stale).
 *
 * Add a path to DOCS_TO_PUBLISH below for any future in-app link that
 * points at a file under `docs/`.
 */

import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const DOCS_TO_PUBLISH = ['local-llm.md'];

// ---- pure helpers (unit-tested) ------------------------------------------

/** src/dest path pairs for every doc that gets mirrored into public/docs/. */
export function resolveCopyPlan(repoRoot, docs = DOCS_TO_PUBLISH) {
  return docs.map((name) => ({
    name,
    src: join(repoRoot, 'docs', name),
    dest: join(repoRoot, 'public', 'docs', name),
  }));
}

// ---- side-effecting steps -------------------------------------------------

async function main() {
  for (const { name, src, dest } of resolveCopyPlan(REPO_ROOT)) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    console.log(`[sync-docs-to-public] docs/${name} -> public/docs/${name}`);
  }
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
