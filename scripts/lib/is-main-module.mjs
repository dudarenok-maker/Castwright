// Shared direct-execution guard for scripts/*.mjs's dual-purpose
// CLI/module pattern (#2291).
//
// Every script under scripts/ is importable as a module (so its pure
// helpers are unit-testable) AND runnable as a CLI. The CLI half is gated
// on "was this file the one Node was told to run", historically written by
// hand as some form of `import.meta.url === pathToFileURL(process.argv[1]).href`.
//
// That naive form breaks whenever the invocation path crosses a symlink
// (POSIX) or a junction (Windows, the admin-rights-free equivalent — this
// repo junctions aggressively for worktrees). Node's ESM loader realpaths
// the main entry point when deriving import.meta.url; process.argv[1] keeps
// the path exactly as invoked. Measured through a real junction:
//
//   invocation                  process.argv[1]   import.meta.url
//   default                     link path         REAL path
//   --preserve-symlinks-main    link path          link path
//
// So realpathing only ONE side fixes one row and breaks the other; the two
// hrefs collapse to the same value only when BOTH sides are realpathed. Miss
// this and the guard silently evaluates false: main() never runs, and the
// process exits 0 with no output at all — a vacuous green, not a visible
// failure. This bit for real on GitHub's macos-latest runner (tmpdir() under
// /var, itself a symlink to /private/var) and was demonstrated live against
// scripts/ci-scope.mjs (`node <junction>/scripts/ci-scope.mjs --files=...`
// exiting 0 with zero bytes of stdout) — see issue #2291.
//
// Also deliberately uses pathToFileURL rather than string-concatenating
// `file://${path}`: that naive form yields two slashes on Windows
// (file://C:/...) where import.meta.url has three (file:///C:/...), so it
// is ALWAYS false there regardless of the realpath fix above.
//
// realpathSync throws for a path that doesn't exist (or an environment that
// can't resolve it); each side falls back to its unresolved value rather
// than propagating — a guard that throws is worse than one that merely
// misses.
//
// Usage, at the bottom of a dual-purpose script:
//   import { isDirectlyInvoked } from './lib/is-main-module.mjs';
//   if (isDirectlyInvoked(import.meta.url)) {
//     main();
//   }
//
// Do NOT wrap that call as `process.exit(main())` unless main()'s own
// output is provably tiny (a single short line, like ci-scope.mjs's one
// JSON line). process.exit() terminates before Node flushes pending async
// stdout writes — synchronous on Windows but ASYNCHRONOUS on Linux/macOS —
// so a script with more than trivial output silently truncates its own
// tail on a POSIX CI runner while looking perfect on every Windows dev box.
// This is not hypothetical: several scripts under scripts/ were converted
// OFF exactly this pattern for exactly this reason (see the comment by
// scripts/build-release-zip.mjs's CliError/die for a worked example) —
// have main() set process.exitCode itself and simply return/throw instead,
// so the process exits naturally once the event loop drains.
//
// Reach for isDirectlyInvoked() instead of hand-rolling a 23rd copy of the
// comparison.

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

function realpathWithFallback(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isDirectlyInvoked(importMetaUrl) {
  const invokedRaw = process.argv[1];
  if (!invokedRaw) return false;
  const invokedHref = pathToFileURL(realpathWithFallback(invokedRaw)).href;
  const scriptPath = fileURLToPath(importMetaUrl);
  const scriptHref = pathToFileURL(realpathWithFallback(scriptPath)).href;
  return scriptHref === invokedHref;
}
