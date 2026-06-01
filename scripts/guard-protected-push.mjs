// Protected-branch guard for .husky/pre-push.
//
// Rejects two dangerous pushes to a protected branch (main):
//   - deletion        (`git push origin :main` / `--delete`)
//   - force-push      (non-fast-forward `git push --force`/`--force-with-lease`)
//
// This is a LOCAL approximation of GitHub branch protection, which is gated
// behind GitHub Pro on this private repo (see
// docs/features/163-protected-push-guard.md). It guards only this checkout and
// is intentionally bypassable with `git push --no-verify` for the rare case
// where a force-push/deletion to main is genuinely intended.
//
// git pipes one line per ref being pushed to the hook's stdin:
//   "<localRef> <localSha> <remoteRef> <remoteSha>"
// A zero sha (all '0') means the ref is being created (remoteSha) or deleted
// (localSha). See `man githooks` ("pre-push").

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const PROTECTED_REFS = ['refs/heads/main'];
export const ZERO = '0'.repeat(40);

// A sha is "null" when it's all zeros — robust to sha1 (40) and sha256 (64).
function isZeroSha(sha) {
  return /^0+$/.test(sha);
}

// Decide whether a push should be blocked.
//   stdinText   — the raw pre-push stdin (one ref per line).
//   isAncestor  — (ancestorSha, descendantSha) => boolean. A push is a
//                 fast-forward when the remote sha is an ancestor of the local
//                 sha; otherwise it's a non-fast-forward (force) push.
// Returns { blocked, reason }. Injecting isAncestor keeps this unit-testable
// without a real git repo.
export function evaluatePush(stdinText, { isAncestor }) {
  const lines = String(stdinText).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [, localSha, remoteRef, remoteSha] = trimmed.split(/\s+/);
    if (!PROTECTED_REFS.includes(remoteRef)) continue;

    if (isZeroSha(localSha)) {
      return {
        blocked: true,
        reason: `Refusing to DELETE protected branch '${remoteRef}'.`,
      };
    }
    // remoteSha all-zero => the branch is being created, not force-pushed.
    if (!isZeroSha(remoteSha) && !isAncestor(remoteSha, localSha)) {
      return {
        blocked: true,
        reason: `Refusing to FORCE-PUSH (non-fast-forward) to protected branch '${remoteRef}'.`,
      };
    }
  }
  return { blocked: false };
}

export function helpMessage(reason) {
  return [
    `pre-push blocked: ${reason}`,
    ``,
    `'main' is a protected branch. Force-pushes and deletions are refused`,
    `locally to mirror GitHub branch protection (which this private repo's`,
    `plan can't enable server-side — see docs/features/163-protected-push-guard.md).`,
    ``,
    `If you genuinely intend this, bypass the guard with:`,
    `  git push --no-verify ...`,
  ].join('\n');
}

// CLI mode: `node scripts/guard-protected-push.mjs <remote> <url>` with the
// ref list on stdin. Detect via argv[1] so `import` from tests stays inert.
const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/guard-protected-push.mjs');

if (invokedAsCli) {
  // git can't resolve remoteSha when it isn't fetched locally; treat an
  // unverifiable ancestry as "cannot prove non-fast-forward" => allow, so
  // ordinary pushes are never falsely blocked.
  const isAncestor = (ancestor, descendant) => {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (r.status === 0) return true; // ancestor → fast-forward
    if (r.status === 1) return false; // not an ancestor → non-fast-forward
    return true; // exit >1 or spawn error → can't verify → don't block
  };

  let stdinText = '';
  try {
    stdinText = readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch {
    stdinText = '';
  }
  const result = evaluatePush(stdinText, { isAncestor });
  if (result.blocked) {
    console.error(helpMessage(result.reason));
    process.exit(1);
  }
  process.exit(0);
}
