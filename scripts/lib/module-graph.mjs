// Static module-graph helpers for the test:hooks completeness guard.
//
// Specifiers are extracted by PARSING, not by regex over stripped text. Two
// hand-rolled comment-stripping lexers were written for this and both had a
// fail-open: a regex literal could open a phantom comment state that a later
// `*/` closed, swallowing imports with no detectable signal. A parser has no
// such failure mode — comments and string literals are simply not expressions.
//
// acorn is already a transitive dependency (via eslint) and is used here for
// its parser only; no plugin, no walker package.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
};

const isRelative = (v) => typeof v === 'string' && /^\.\.?\//.test(v);

// Returns the relative specifiers this source depends on.
//
// THROWS on unparseable input rather than returning []. An empty result from a
// broken parse is the "absent reads as clean" shape: the guard would report a
// file has no dependencies precisely when it cannot tell.
export function extractRelativeSpecifiers(source) {
  let ast = null;
  let lastErr = null;
  // .mjs/.cjs/.js all appear in the closure; try ESM first, then script.
  for (const sourceType of ['module', 'script']) {
    try {
      ast = acorn.parse(source, { ...PARSE_OPTIONS, sourceType });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!ast) {
    throw new Error(`module-graph: parse failed (${lastErr?.message ?? 'unknown'})`);
  }

  const found = new Set();
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        if (isRelative(node.source?.value)) found.add(node.source.value);
        break;
      case 'CallExpression':
        if (node.callee?.name === 'require' && isRelative(node.arguments?.[0]?.value)) {
          found.add(node.arguments[0].value);
        }
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      visit(node[key]);
    }
  })(ast);
  return [...found];
}

const CANDIDATES = ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.ts'];

// Candidate paths a specifier could denote, WITHOUT touching the filesystem.
// Exported so the stop rule can classify each candidate before any existence
// probe (see walk()).
export function candidatePaths(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  // `join` (not string concatenation) for the `/index.*` suffixes: `base` is
  // an OS-native path (backslash-joined on Windows) and a bare `base + '/index.ts'`
  // would splice a literal forward slash into it, producing a path that's
  // functionally correct for fs calls but fails strict string equality
  // against a `path.join`-built path elsewhere (e.g. in a caller's Set/cache key).
  const paths = CANDIDATES.map((suffix) =>
    suffix.startsWith('/') ? join(base, suffix.slice(1)) : base + suffix,
  );
  // TypeScript convention: `./x.js` in source resolves to `./x.ts` on disk.
  if (specifier.endsWith('.js')) paths.push(`${base.slice(0, -3)}.ts`);
  return paths;
}

// `existsSync` is true for directories too — a bare `''` candidate (the
// literal-match case, tried first) matches a same-named directory before any
// `/index.*` candidate gets a look. Only a regular FILE is an acceptable
// resolution: the caller (the transitive walk) treats this return value as a
// path safe to read, and a directory is not.
function isRegularFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

export function resolveSpecifier(fromFile, specifier) {
  for (const candidate of candidatePaths(fromFile, specifier)) {
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

const toPosix = (p) => p.split(sep).join('/');

// Classify a batch of candidate paths as gitignored or not.
//
// NOTE: check-ignore is INDEX-AWARE, not pure .gitignore pattern matching.
// Measured: a file matching an ignore rule but force-added to the index
// reports exit 1 (NOT ignored); with --no-index it reports 0. This is
// deliberate and must NOT be "fixed" by adding --no-index: a tracked file is
// a real producer and belongs in the closure regardless of what .gitignore
// says about its directory. The server/dist/** conclusion is unaffected —
// those files are never tracked, so they classify as ignored in both a fresh
// clone and a built tree, which is the clone-state independence this rule
// needs. What is NOT true is the simpler story that this is a property of
// .gitignore alone.
//
// BATCHED via --stdin, not one spawn per path: measured 81 individual spawns
// = 3972 ms vs one batch = 60 ms (66x). test:hooks runs in pre-commit via
// verify:fast:scoped, a path documented as sub-5s — per-query spawning would
// roughly double it on every commit touching scripts/**.
//
// Paths are POSIX-normalised first: git normalises backslashes on Windows,
// but on Linux 'server\dist\x.js' is ONE literal filename that matches
// nothing — classified not-ignored, then fail-closed resolution turns it red
// on CI only.
//
// FAILS CLOSED. git check-ignore is three-valued:
//   0   = at least one path ignored
//   1   = none ignored
//   128 = error (e.g. path outside the repository)
// 128, a spawn failure, or git being absent all THROW rather than defaulting
// either way. Defaulting to "ignored" would silently empty the walk wherever
// git is unavailable.
//
// `-c core.quotePath=false` (a GIT-level option, so it must precede the
// subcommand): git's default core.quotePath=true C-quotes non-ASCII bytes in
// printed paths (e.g. 'café' -> '"caf\303\251"'), which would never match the
// plain POSIX string built above, misclassifying a genuinely-ignored
// non-ASCII path as NOT ignored. Direction of failure matters here: that
// reads as "keep walking" rather than "stop early", so it's the safer of the
// two ways this could break — but it's still a real gap this flag closes.
export function classifyIgnored(absPaths, cwd) {
  const result = new Map(absPaths.map((p) => [p, false]));
  if (absPaths.length === 0) return result;

  const posix = absPaths.map((p) => toPosix(relative(cwd, p)));
  const proc = spawnSync('git', ['-c', 'core.quotePath=false', 'check-ignore', '--stdin'], {
    cwd,
    input: posix.join('\n'),
    encoding: 'utf8',
  });

  if (proc.error) {
    throw new Error(`check-ignore: failed to spawn git (${proc.error.message}) — refusing to guess`);
  }
  if (proc.status !== 0 && proc.status !== 1) {
    // Name the paths: check-ignore batches, and on 128 it prints nothing about
    // the good ones — so without this the error identifies neither the
    // offending specifier nor the file that imported it. Fail-closed but
    // undiagnosable is only half a guard.
    throw new Error(
      `check-ignore: git exited ${proc.status} — refusing to guess.\n` +
      `${proc.stderr ?? ''}\nPaths in this batch:\n${posix.join('\n')}`,
    );
  }

  const ignored = new Set(proc.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  for (let i = 0; i < absPaths.length; i += 1) {
    if (ignored.has(posix[i])) result.set(absPaths[i], true);
  }
  return result;
}

// Breadth-first transitive walk over relative import edges.
//
// Ordering matters and is the answer to "classify or resolve first?": path
// JOIN is pure string math; module RESOLUTION is extension-candidate probing
// plus existsSync. They are different operations. Every candidate is
// classified by check-ignore BEFORE any existence probe, so whether a build
// artifact happens to be present on this box cannot change the result —
// server/dist is present locally and absent on a fresh CI clone.
//
// Classification is per-CANDIDATE, not once-then-resolve: a file-specific
// .gitignore pattern could otherwise disagree with what resolution lands on.
//
// KNOWN LIMITS (measured, not fixed):
//   - require() ALIASING (`const req = require; req('./x')`) is a silent
//     false negative — extractRelativeSpecifiers only recognises a literal
//     `require(...)` callee by name, so an aliased call contributes no edge
//     and no error. Confirmed absent from this repo's corpus today.
//   - The 'module' -> 'script' sourceType fallback inside
//     extractRelativeSpecifiers (needed for genuinely sloppy-mode CJS) has no
//     regression coverage of its own from THIS walk — only via the
//     extractor's own direct unit test (module-graph.test.mjs: 'falls back to
//     sourceType "script" for legacy octal literals', M-a #2154 review — a
//     legacy octal literal parses under 'script' and throws under 'module',
//     which is the discriminating fixture an earlier pass claimed didn't
//     exist).
export function walk({ entryFiles, repoRoot }) {
  const seen = new Set();
  const files = new Set();
  const unresolvable = [];
  const unparseable = [];
  let frontier = [...entryFiles];

  while (frontier.length > 0) {
    // Collect every candidate for this BFS level, then classify in ONE batch.
    const edges = [];
    for (const file of frontier) {
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        // KNOWN, ACCEPTED RESIDUAL: a read failure here is reported nowhere
        // (not `files`, not `unresolvable`, not `unparseable`) — a genuine
        // silent skip in a module whose whole contract is "nothing is
        // skipped silently." Judged unreachable in this guard's synchronous,
        // single-process use: `file` was already resolved via THIS function's
        // own `isRegularFile` check (`existsSync` + `statSync().isFile()`,
        // below) at the end of the previous BFS level, when it was pushed
        // onto `next` — not via `resolveSpecifier`, which `walk()` does not
        // call. So reaching this catch requires the file to vanish (or its
        // permissions to change) between that resolution and this read — a
        // TOCTOU race with an external actor, not a condition this guard's
        // own logic can trigger. Not hardened further: that would be
        // speculative error plumbing for a trigger with no reachable path
        // today.
        continue;
      }
      let specifiers;
      try {
        specifiers = extractRelativeSpecifiers(source);
      } catch {
        // A file we successfully RESOLVED but cannot parse — e.g. a .ts file
        // with type annotations, since acorn is a JavaScript parser. This is
        // fail-closed made VISIBLE, not a silent drop: the file already
        // counts as a discovered dependency (added to `files` when its
        // parent resolved it, or left absent here if it's an entry file), it
        // is named in `unparseable` so the un-followed edge is never hidden,
        // and the walk simply does not recurse past it. Deliberately NOT
        // merged into `unresolvable`: that list means "no file answers this
        // specifier at all"; this is a real, resolved file we just can't
        // read further. Only a parse failure is swallowed here — any other
        // error (e.g. from classifyIgnored) still propagates.
        unparseable.push(toPosix(relative(repoRoot, file)));
        continue;
      }
      for (const specifier of specifiers) {
        edges.push({ from: file, specifier, candidates: candidatePaths(file, specifier) });
      }
    }
    if (edges.length === 0) break;

    const allCandidates = [...new Set(edges.flatMap((e) => e.candidates))];
    const ignoredMap = classifyIgnored(allCandidates, repoRoot);

    const next = [];
    for (const edge of edges) {
      const live = edge.candidates.filter((c) => !ignoredMap.get(c));
      if (live.length === 0) continue; // wholly ignored — stop, not an error
      const resolved = live.find((c) => isRegularFile(c));
      if (!resolved) {
        // FAIL CLOSED: a specifier that resolves to nothing is reported, not
        // silently skipped. The old guard's `continue` here meant a broken
        // edge read as clean.
        unresolvable.push({ specifier: edge.specifier, from: toPosix(relative(repoRoot, edge.from)) });
        continue;
      }
      const rel = toPosix(relative(repoRoot, resolved));
      files.add(rel);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }

  return { files: [...files].sort(), unresolvable, unparseable };
}
