#!/usr/bin/env node
// Rewrite `docs/features/<NN>-slug.md` pointers in the non-doc tree so each
// points at wherever the plan file ACTUALLY lives — top-level
// `docs/features/` (active/deferred plans) or `docs/features/archive/`
// (shipped plans). Fallout from the plan-archiving sweeps that move shipped
// plans into archive/ but leave plain-text "Pairs with …" pointers in code
// comments, openapi.yaml descriptions, and skills/*.md untouched (editing
// them in the archive PR would have broken the doc-only CI fast-path and
// coupled unrelated scope). Backlog item ops-6.
//
// Matching is by FULL filename (number + slug), NOT number alone: plan
// numbers 118 / 127 / 137 each exist in BOTH dirs with different slugs, so a
// number-only rule would mis-route them.
//
// Usage:
//   node scripts/fix-archived-plan-pointers.mjs           # dry-run (default)
//   node scripts/fix-archived-plan-pointers.mjs --apply   # write changes
//
// Env overrides (mostly for tests):
//   REPO_ROOT   — repo root to scan (default: process.cwd())
//
// What it does NOT touch:
//   - docs/** (the archive PR already fixed rendered markdown links there)
//   - src/lib/api-types.ts (auto-generated from openapi.yaml — fix the YAML
//     and re-run `npm run openapi:types` instead)
//   - pointers whose target file exists in NEITHER dir: left as-is and
//     reported as "unresolved" so a human can fix the broken reference
//     (wrong slug / number / placeholder) explicitly.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = process.env.REPO_ROOT ? process.env.REPO_ROOT : process.cwd();
const APPLY = process.argv.includes('--apply');

/* The non-doc scope ops-6 owns. Mirrors the acceptance grep:
   git grep "docs/features/" -- '*.ts' '*.tsx' '*.mjs' openapi.yaml skills
   plus *.js for completeness. api-types.ts is excluded (generated). */
const PATHSPECS = ['*.ts', '*.tsx', '*.mjs', '*.js', 'openapi.yaml', 'skills/**'];
const EXCLUDE = new Set(['src/lib/api-types.ts']);

/* Pre-existing BROKEN pointers (wrong number/slug, target in neither dir) that
   the archive sweep did NOT create but which would still fail ops-6's
   acceptance grep. Each maps the exact bad pointer to the real plan file,
   identified by its slug. Kept explicit (not existence-derived) because the
   bad filename doesn't exist anywhere to look up. The
   `06-manuscript-parsing.md` refs in server/src/parsers/*.test.ts are
   deliberately NOT here — pdf/text/audio-tag parsers have no single right
   target, so they're fixed per-file by hand and flagged in the PR. */
const ALIAS_FIXES = {
  'docs/features/14a-model-control-pill.md': 'docs/features/archive/30-global-model-control.md',
  'docs/features/60-real-binary-parser-fixtures.md':
    'docs/features/archive/66-real-binary-parser-fixtures.md',
  'docs/features/60-voice-preview-while-editing.md':
    'docs/features/archive/64-voice-preview-while-editing.md',
  'docs/features/archive/67-streaming-link-tile.md':
    'docs/features/archive/68-streaming-link-tile.md',
  'docs/features/41-dark-mode.md': 'docs/features/archive/42-dark-mode.md',
  'docs/features/24-voice-library.md': 'docs/features/archive/22-voice-library.md',
  'docs/features/22-book-library.md': 'docs/features/archive/21-book-library.md',
  'docs/features/23-book-state-persistence.md':
    'docs/features/archive/27-book-state-persistence.md',
  'docs/features/12-revisions-pipeline.md': 'docs/features/archive/20-revisions-and-drift.md',
};

/* Matches docs/features/<optional archive/>/<num><slug>.md.
   `<num>` is a leading digit so we don't grab the `docs/features/TEMPLATE.md`
   etc.; slug is the rest up to `.md`. Captured groups:
     1 = "archive/" or undefined
     2 = "<NN>-slug.md" (the bare filename) */
const POINTER_RE = /docs\/features\/(archive\/)?(\d[0-9a-z]*-[0-9a-z-]+\.md)/g;

function tracked(spec) {
  try {
    const out = execFileSync('git', ['ls-files', '--', spec], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function locate(filename) {
  const inArchive = existsSync(join(REPO_ROOT, 'docs/features/archive', filename));
  const inTop = existsSync(join(REPO_ROOT, 'docs/features', filename));
  if (inArchive && !inTop) return 'archive';
  if (inTop && !inArchive) return 'top';
  if (inArchive && inTop) return 'both'; // same slug in both dirs — leave the existing form
  return 'missing';
}

const files = [...new Set(PATHSPECS.flatMap(tracked))].filter((f) => !EXCLUDE.has(f)).sort();

let changedFiles = 0;
let changedPointers = 0;
const unresolved = [];

for (const rel of files) {
  const abs = join(REPO_ROOT, rel);
  const before = readFileSync(abs, 'utf8');
  let fileTouched = false;

  const after = before.replace(POINTER_RE, (match, _archivePrefix, filename) => {
    const alias = ALIAS_FIXES[match];
    if (alias) {
      if (match === alias) return match;
      fileTouched = true;
      changedPointers += 1;
      return alias;
    }
    const where = locate(filename);
    if (where === 'missing') {
      unresolved.push({ rel, match, filename });
      return match;
    }
    if (where === 'both') return match; // ambiguous by design — don't rewrite
    const want = where === 'archive' ? `docs/features/archive/${filename}` : `docs/features/${filename}`;
    if (match === want) return match;
    fileTouched = true;
    changedPointers += 1;
    return want;
  });

  if (fileTouched) {
    changedFiles += 1;
    if (APPLY) writeFileSync(abs, after, 'utf8');
    const verb = APPLY ? 'fixed' : 'would fix';
    console.log(`${verb}: ${rel}`);
  }
}

console.log(
  `\n${APPLY ? 'Applied' : 'Dry-run'}: ${changedPointers} pointer(s) across ${changedFiles} file(s).`,
);
if (unresolved.length) {
  console.log(
    `\n${unresolved.length} unresolved pointer(s) (target in NEITHER dir — fix by hand):`,
  );
  for (const u of unresolved) console.log(`  ${u.rel}: ${u.match}`);
}
if (!APPLY && changedPointers > 0) {
  console.log('\nRe-run with --apply to write these changes.');
}
