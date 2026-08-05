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

import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

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
