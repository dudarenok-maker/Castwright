import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractRelativeSpecifiers, resolveSpecifier, classifyIgnored, walk } from '../lib/module-graph.mjs';
import { execFileSync } from 'node:child_process';

test('extracts static, dynamic and require specifiers', () => {
  const src = `
import a from './a.mjs';
const b = await import('./b.mjs');
const c = require('./c.js');
export { d } from './d.mjs';
export * from './e.mjs';
import fs from 'node:fs';
import pkg from 'archiver';
`;
  assert.deepEqual(
    extractRelativeSpecifiers(src).sort(),
    ['./a.mjs', './b.mjs', './c.js', './d.mjs', './e.mjs'],
  );
});

// Comments are invisible to a parser — no stripping step, no desync class.
// verify-cache.mjs:107 has a literal require('../../pinokio.js') in a comment
// that resolves OUTSIDE the repo; under fail-closed resolution the regex
// approach turned that into a check-ignore exit-128 crash.
test('ignores a specifier inside a comment', () => {
  const src = `// loads it via createRequire + require('../../pinokio.js')\nimport x from './real.mjs';\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./real.mjs']);
});

// The regex approach extracted this; acorn does not. It is fixture DATA in a
// test, not an edge — a false positive that inflated the closure.
test('ignores a specifier inside a string literal', () => {
  const src = `const source = "const config = require('../../pinokio.js');";\nimport y from './real.mjs';\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./real.mjs']);
});

// The exact shape that defeated the hand-rolled lexer: `return /a\/*b/;` is
// read as division, `/*` opens a phantom comment, a later `*/` closes it, and
// every import in between is swallowed with NO desync signal.
test('a keyword-preceded regex literal does not swallow later imports', () => {
  const src = [
    'function f() { return /a\\/*b/; }',
    "import x from './real.mjs';",
    '/* ordinary comment */',
    "import y from './other.mjs';",
  ].join('\n');
  assert.deepEqual(extractRelativeSpecifiers(src).sort(), ['./other.mjs', './real.mjs']);
});

test('handles CJS scripts that are not valid ESM', () => {
  const src = `const x = require('./a.js');\nmodule.exports = x;\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./a.js']);
});

test('handles a hashbang', () => {
  const src = `#!/usr/bin/env node\nimport a from './a.mjs';\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./a.mjs']);
});

// FAIL CLOSED: unparseable input must be reported, never treated as "no
// edges". Silently returning [] is the "absent reads as clean" shape.
test('throws on unparseable source rather than returning no edges', () => {
  assert.throws(() => extractRelativeSpecifiers('function ( { >>> ;'), /parse/i);
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

test('resolveSpecifier resolves an exact path', () => {
  const d = tree({ 'a.mjs': '', 'b.mjs': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './b.mjs'), join(d, 'b.mjs'));
});

test('resolveSpecifier tries extension candidates', () => {
  const d = tree({ 'a.mjs': '', 'b.js': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './b'), join(d, 'b.js'));
});

// TypeScript emits .js specifiers for .ts sources — scripts/diff-analysis-ab.mjs
// imports ../server/src/handoff/schemas.js and only the .ts exists.
test('resolveSpecifier maps a .js specifier onto a .ts source', () => {
  const d = tree({ 'a.mjs': '', 'schemas.ts': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './schemas.js'), join(d, 'schemas.ts'));
});

test('resolveSpecifier returns null when nothing resolves', () => {
  const d = tree({ 'a.mjs': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './nope.mjs'), null);
});

// `existsSync` is true for directories: the literal-match candidate ('' in
// CANDIDATES) is tried before any `/index.*` candidate, so an unguarded
// resolver would return the directory itself here — a bogus path the
// transitive walk would then treat as a file safe to read.
test('resolveSpecifier resolves a directory specifier via its index file, never the directory itself', () => {
  const d = tree({ 'a.mjs': '', 'dir/index.ts': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './dir'), join(d, 'dir', 'index.ts'));
});

test('resolveSpecifier returns null for a directory with no index candidate, not the directory itself', () => {
  const d = tree({ 'a.mjs': '', 'dir/other.ts': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './dir'), null);
});

// Anti-vacuity on the extractor itself: every real hooks test must parse.
// A parse regression would otherwise surface only as a mysteriously shrunken
// closure. This count is a point-in-time measurement, not an invariant — it
// grows as hooks tests are added, which is why the floor below is a loose
// `>= 40` rather than tracking it exactly. Measured on this branch when this
// test was authored: 63 files, 0 failures.
test('every hooks test file parses', () => {
  const dir = resolve(import.meta.dirname);
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length >= 40, `expected >= 40 hooks tests, found ${files.length}`);
  const failures = [];
  for (const f of files) {
    try { extractRelativeSpecifiers(readFileSync(join(dir, f), 'utf8')); }
    catch (err) { failures.push(`${f}: ${err.message}`); }
  }
  assert.deepEqual(failures, [], `unparseable hooks test(s):\n${failures.join('\n')}`);
});

function gitRepo(files, ignore) {
  const dir = tree(files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), ignore, 'utf8');
  return dir;
}

test('classifyIgnored marks gitignored paths', () => {
  const d = gitRepo({ 'src/a.js': '', 'dist/b.js': '' }, 'dist/\n');
  const m = classifyIgnored([join(d, 'dist', 'b.js'), join(d, 'src', 'a.js')], d);
  assert.equal(m.get(join(d, 'dist', 'b.js')), true);
  assert.equal(m.get(join(d, 'src', 'a.js')), false);
});

// The property the rule depends on: check-ignore is pure pattern matching, so
// it answers correctly for paths that do NOT exist. That is what makes the
// rule clone-state independent — server/dist is present locally (1,812 files)
// and absent on a fresh CI clone, and "untracked" would classify differently
// in each, giving red on CI and green locally.
test('classifyIgnored answers for a path that does not exist on disk', () => {
  const d = gitRepo({ 'src/a.js': '' }, 'dist/\n');
  const m = classifyIgnored([join(d, 'dist', 'never', 'existed.js')], d);
  assert.equal(m.get(join(d, 'dist', 'never', 'existed.js')), true);
});

// M18: exit 128 (path outside the repo) and git-unavailable must FAIL CLOSED.
// "Non-zero => not ignored" conflates 128 with 1; "non-zero => skip" would
// classify everything as ignored wherever git is absent, making the guard
// vacuously green — the "absent reads as clean" shape.
test('classifyIgnored throws on a path outside the repository (exit 128)', () => {
  const d = gitRepo({ 'src/a.js': '' }, 'dist/\n');
  assert.throws(
    () => classifyIgnored([resolve(d, '..', 'outside.js')], d),
    /check-ignore/i,
  );
});

// git's default core.quotePath=true C-quotes non-ASCII bytes in printed
// paths ('café' -> '"caf\303\251"'). Without `-c core.quotePath=false` on the
// git invocation, that quoted form never matches the plain POSIX string this
// module builds, and a genuinely-ignored non-ASCII path misclassifies as NOT
// ignored.
test('classifyIgnored marks a gitignored path containing non-ASCII characters', () => {
  const d = gitRepo({ 'src/a.js': '' }, 'dist/\n');
  mkdirSync(join(d, 'dist', 'café'), { recursive: true });
  writeFileSync(join(d, 'dist', 'café', 'f.js'), '', 'utf8');
  const m = classifyIgnored([join(d, 'dist', 'café', 'f.js')], d);
  assert.equal(m.get(join(d, 'dist', 'café', 'f.js')), true);
});

// M17 — the mutation the M5-pair alone cannot provide. In the real repo the
// walk's live case is neutralised by the declarations landing in the same PR:
// a depth-1 closure is a SUBSET of a zero-missing full closure, so it is also
// zero-missing (measured: depth-1 = 56, floor = 50, missing = [] -> GREEN).
// Deleting the walk would leave the whole battery green. This synthetic tree
// is what actually pins recursion.
test('walk follows a depth-2 edge (M17: deleting recursion must go red)', () => {
  const d = gitRepo({
    'test.mjs': "import a from './a.mjs';\n",
    'a.mjs': "import b from './b.mjs';\n",
    'b.mjs': "export default 1;\n",
  }, '');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.ok(files.includes('a.mjs'), 'depth-1 edge must be found');
  assert.ok(files.includes('b.mjs'), 'depth-2 edge must be found — recursion is load-bearing');
});

// I1 (#2154 review): walk() inlines its own candidate-picking loop instead of
// calling resolveSpecifier, and used a bare `existsSync` there — true for a
// directory too, and the literal-match candidate ('' in CANDIDATES) is tried
// before any `/index.*` candidate. That re-admits the exact directory bug
// `resolveSpecifier`/`isRegularFile` was hardened against, just in the
// function production actually uses: a directory-shaped specifier resolves
// to the directory ITSELF, which then can't be read (I2) and silently
// truncates the closure past it.
test('walk resolves a directory-shaped specifier to its index file, not the directory itself (I1)', () => {
  const d = gitRepo({
    'test.mjs': "import lib from './lib';\n",
    'lib/index.js': "import deep from './deep.mjs';\n",
    'lib/deep.mjs': "export default 1;\n",
  }, '');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.ok(files.includes('lib/index.js'), 'must resolve into the index file, not the bare directory');
  assert.ok(!files.includes('lib'), 'the directory itself must never enter the closure');
  assert.ok(
    files.includes('lib/deep.mjs'),
    'must recurse past the index file into its own imports — a directory in the closure cannot be read, silently truncating here',
  );
});

test('walk stops at gitignored paths', () => {
  const d = gitRepo({
    'test.mjs': "import a from './dist/a.mjs';\n",
    'dist/a.mjs': "import b from './b.mjs';\n",
    'dist/b.mjs': "export default 1;\n",
  }, 'dist/\n');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.deepEqual(files, [], 'nothing under an ignored dir may enter the closure');
});

test('walk survives an import cycle', () => {
  const d = gitRepo({
    'test.mjs': "import a from './a.mjs';\n",
    'a.mjs': "import b from './b.mjs';\n",
    'b.mjs': "import a from './a.mjs';\n",
  }, '');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.deepEqual(files.sort(), ['a.mjs', 'b.mjs']);
});

// A bare specifier that isn't filtered before candidate resolution would
// still leave `files` empty (it would resolve to nothing and land in
// `unresolvable` instead) — asserting `files` alone cannot fail if bare-
// specifier filtering breaks. `unresolvable` must ALSO stay empty: a bare
// specifier is not a broken relative import, it's not an import edge at all,
// so it must never reach candidate resolution in either list.
test('walk does not follow bare specifiers', () => {
  const d = gitRepo({ 'test.mjs': "import fs from 'node:fs';\nimport x from 'archiver';\n" }, '');
  const { files, unresolvable } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.deepEqual(files, []);
  assert.deepEqual(unresolvable, [], 'a bare specifier must never reach candidate resolution');
});

// M9 — needs a synthetic fixture: post-hardening the real tree has ZERO
// unresolvable specifiers (the count goes 1 -> 0 once comments are stripped),
// so asserting against the real repo would be vacuous.
test('walk reports an unresolvable specifier rather than skipping it', () => {
  const d = gitRepo({ 'test.mjs': "import x from './missing.mjs';\n" }, '');
  const { unresolvable } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.equal(unresolvable.length, 1);
  assert.equal(unresolvable[0].specifier, './missing.mjs');
});

// The defect this repo's real closure hits: acorn is a JavaScript parser, and
// server/src/handoff/schemas.ts (one of the two genuine missing declarations
// this whole PR exists to catch) is TypeScript. It's reached precisely via
// resolveSpecifier's .js -> .ts mapping (the same shape as the
// 'resolveSpecifier maps a .js specifier onto a .ts source' test above), and
// extractRelativeSpecifiers is fail-closed: it THROWS on unparseable input.
// A naive walk would therefore crash on the single most important file in
// the closure. The policy: a resolved-but-unparseable file is a LEAF — it
// still counts as a discovered dependency (already in `files`), it does not
// crash the walk, it is named in `unparseable` (a distinct fact from an
// unresolved specifier), and the walk does not recurse past it.
test('walk records an unparseable TS file as a leaf: found, named, not recursed into', () => {
  const d = gitRepo({
    'test.mjs': "import s from './schemas.js';\n",
    'schemas.ts': "export function f(x: number): string {\n  return String(x);\n}\nimport hidden from './hidden.mjs';\n",
    'hidden.mjs': "export default 1;\n",
  }, '');
  const { files, unresolvable, unparseable } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.ok(files.includes('schemas.ts'), 'the unparseable file is still a discovered dependency');
  assert.deepEqual(unparseable, ['schemas.ts'], 'named in its own list, not merged into unresolvable');
  assert.deepEqual(unresolvable, [], 'a parse failure is not a resolution failure');
  assert.ok(!files.includes('hidden.mjs'), 'must not recurse past an unparseable file');
});
