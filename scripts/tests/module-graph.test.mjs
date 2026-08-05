import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractRelativeSpecifiers, resolveSpecifier, classifyIgnored } from '../lib/module-graph.mjs';
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
