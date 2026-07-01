// Docs-only push detector for .husky/pre-push.
//
// A push whose changed-file set is entirely docs — same test CONTRIBUTING.md's
// "Doc-only PR fast-path" already uses for the CI `paths-ignore` skip: `docs/**`,
// a root-level `*.md`, or a direct `.github/*.md` — has no runtime surface for
// `npm run verify`'s ~15-min battery to exercise. Skipping it locally mirrors
// the CI-side skip instead of always paying the full cost pre-push.
//
// git pipes one line per ref being pushed to the hook's stdin:
//   "<localRef> <localSha> <remoteRef> <remoteSha>"
// A zero localSha means deletion (nothing to check); a zero remoteSha means a
// new ref not yet on the remote, diffed against the merge-base with
// origin/main instead of the usual `remoteSha..localSha` range.
//
// Intentionally conservative: any uncertainty (git error, no merge-base,
// nothing parseable) is NOT docs-only — never skip verify on uncertainty.
//
// Intentionally bypassable with `git push --no-verify` for the rare deliberate
// case, same as every other pre-push guard.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const isZeroSha = (sha) => /^0+$/.test(sha ?? '');

export function isDocsOnlyFile(path) {
  if (path.startsWith('docs/')) return true;
  if (!path.includes('/') && path.endsWith('.md')) return true; // root-level *.md
  if (/^\.github\/[^/]+\.md$/.test(path)) return true; // .github/*.md (direct children)
  return false;
}

export function isDocsOnlyDiff(files) {
  return files.length > 0 && files.every(isDocsOnlyFile);
}

// Pure, unit-testable core. `listChangedFiles(remoteSha, localSha)` returns the
// changed file list for one ref's push, or `null` on any uncertainty — injected
// in tests so this runs without a real repo.
export function evaluateDocsOnlyPush(stdinText, { listChangedFiles }) {
  const allFiles = new Set();
  let sawRef = false;
  for (const line of String(stdinText).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [, localSha, , remoteSha] = trimmed.split(/\s+/);
    if (!localSha || isZeroSha(localSha)) continue; // deletion — nothing to check
    sawRef = true;
    const files = listChangedFiles(remoteSha, localSha);
    if (files === null) return { docsOnly: false }; // uncertain — never skip
    files.forEach((f) => allFiles.add(f));
  }
  if (!sawRef) return { docsOnly: false };
  return { docsOnly: isDocsOnlyDiff([...allFiles]) };
}

// Real git-backed lister for CLI mode. `null` on any git error (never skip on
// uncertainty).
function gitChangedFiles(remoteSha, localSha) {
  let revArg;
  if (remoteSha && !isZeroSha(remoteSha)) {
    revArg = `${remoteSha}..${localSha}`;
  } else {
    const mb = spawnSync('git', ['merge-base', localSha, 'origin/main'], { encoding: 'utf8' });
    if (mb.status !== 0 || !mb.stdout.trim()) return null;
    revArg = `${mb.stdout.trim()}..${localSha}`;
  }
  const res = spawnSync('git', ['diff', '--name-only', revArg], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const invokedAsCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /is-docs-only-push\.mjs$/.test(process.argv[1] ?? '');

if (invokedAsCli) {
  let stdinText = '';
  try {
    stdinText = readFileSync(0, 'utf8');
  } catch {
    stdinText = ''; // no stdin (e.g. invoked manually) — nothing to check
  }
  const { docsOnly } = evaluateDocsOnlyPush(stdinText, { listChangedFiles: gitChangedFiles });
  if (docsOnly) {
    process.stdout.write(
      '[pre-push] docs-only push — skipping npm run verify (see CONTRIBUTING.md "Doc-only PR fast-path")\n',
    );
    process.exit(0);
  }
  process.exit(1);
}
