// Plan 49 — pin the manifest decisions in scripts/build-release-zip.mjs.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Asserts the right cross-section of:
//   - includes (frontend source, server source, sidecar source, runtime scripts)
//   - excludes (node_modules, .venv, Kokoro weights, dev-only docs, maintainer scripts)
//   - .gitkeep retention inside keepGitkeepIn directories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  MANIFEST,
  matchesManifest,
  releaseZipName,
  releaseInternalPrefix,
  companionApkSrc,
  companionApkZipEntry,
} from '../build-release-zip.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const INCLUDED = [
  'package.json',
  'package-lock.json',
  'index.html',
  'openapi.yaml',
  'README.md',
  'INSTALL.md',

  // Frontend source + bundle
  'src/main.tsx',
  'src/views/account.tsx',
  'src/lib/api.ts',
  'dist/index.html',
  'dist/assets/index-abc123.js',

  // Server source + bundle
  'server/package.json',
  'server/package-lock.json',
  'server/.env.example',
  'server/src/index.ts',
  'server/src/routes/user-settings.ts',
  'server/dist/index.js',

  // Sidecar (everything except .venv, tests, kokoro weights)
  'server/tts-sidecar/main.py',
  'server/tts-sidecar/requirements.txt',
  'server/tts-sidecar/start.ps1',
  'server/tts-sidecar/scripts/install-kokoro.ps1',
  'server/tts-sidecar/scripts/install-kokoro.sh',
  'server/tts-sidecar/scripts/install-kokoro.mjs',

  // Runtime scripts the deployer invokes
  'scripts/start-app-prod.mjs',
  'scripts/stop-app.mjs',
  'scripts/preflight-ffmpeg.cjs',

  // fs-1 upgrade machinery (stable launcher + restarter + one-time setup)
  'launch.mjs',
  'scripts/restart-after-upgrade.mjs',
  'scripts/setup-versioned-install.mjs',
  // fs-1 — bundled release notes (generated at build time, read by /api/info)
  'RELEASE_NOTES.md',

  // Empty-dir markers stay so the runtime layout matches what the server expects
  'server/handoff/inbox/.gitkeep',
  'server/handoff/outbox/.gitkeep',
  'server/tts-sidecar/voices/kokoro/.gitkeep',
];

const EXCLUDED = [
  // Installed deps + venvs
  'node_modules/react/index.js',
  'server/node_modules/express/index.js',
  'server/tts-sidecar/.venv/Scripts/python.exe',
  'server/tts-sidecar/.venv/bin/python',

  // Secrets
  '.env',
  '.env.local',
  '.env.production.local',
  'server/.env',

  // Kokoro weights (1.1 GB)
  'server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx',
  'server/tts-sidecar/voices/kokoro/voices-v1.0.bin',

  // Working data
  'server/handoff/inbox/some-stage1.md',
  'server/handoff/outbox/some-stage2.json',
  'server/audio/some-book/chapter-01.mp3',
  'server/workspace/some-book/.audiobook/state.json',

  // Dev / repo metadata
  '.git/HEAD',
  '.github/workflows/release.yml',
  '.husky/pre-commit',
  '.run/server.pid',
  'logs/server.log',
  'coverage/index.html',
  'playwright-report/index.html',

  // Maintainer-only doc + test surfaces
  'e2e/listen-playback.spec.ts',
  'docs/BACKLOG.md',
  'docs/features/archive/49-release-package.md',
  'scripts/tests/bump-version.test.mjs',
  'server/tts-sidecar/tests/test_smoke.py',
  'CLAUDE.md',
  'CONTRIBUTING.md',

  // Maintainer-only scripts
  'scripts/bump-version.mjs',
  'scripts/build-release-zip.mjs',
  'scripts/start-app.ps1',
  'scripts/validate-commit-msg.mjs',
  'scripts/verify-cache.mjs',
  'scripts/reconcile-broken-cast.ps1',
  'scripts/gen-parser-fixtures.mjs',

  // Generated / cached artefacts
  '.verify-cache.json',
  '.verify-cache.json.tmp',
  'server.tsbuildinfo',
  'tsconfig.tsbuildinfo',
  '.vite/deps/_metadata.json',
];

for (const rel of INCLUDED) {
  test(`MANIFEST: includes ${rel}`, () => {
    assert.equal(
      matchesManifest(rel),
      true,
      `Expected ${rel} to be INCLUDED in the release zip — manifest decided otherwise.`,
    );
  });
}

for (const rel of EXCLUDED) {
  test(`MANIFEST: excludes ${rel}`, () => {
    assert.equal(
      matchesManifest(rel),
      false,
      `Expected ${rel} to be EXCLUDED from the release zip — manifest decided otherwise.`,
    );
  });
}

test('MANIFEST exposes both include and exclude pattern lists', () => {
  assert.ok(Array.isArray(MANIFEST.include));
  assert.ok(Array.isArray(MANIFEST.exclude));
  assert.ok(MANIFEST.include.length > 5);
  assert.ok(MANIFEST.exclude.length > 5);
  assert.ok(MANIFEST.keepGitkeepIn.includes('server/tts-sidecar/voices/kokoro'));
});

test('releaseZipName returns castwright- prefixed zip filename', () => {
  assert.equal(releaseZipName('v1.7.0'), 'release/castwright-v1.7.0.zip');
});

test('releaseInternalPrefix returns castwright- prefixed top dir', () => {
  assert.equal(releaseInternalPrefix('v1.7.0'), 'castwright-v1.7.0');
});

test('companionApkZipEntry nests the APK under the release prefix at companion/', () => {
  assert.equal(
    companionApkZipEntry('v1.7.0'),
    'castwright-v1.7.0/companion/castwright-companion.apk',
  );
});

test('companionApkSrc honours COMPANION_APK_SRC, else defaults to the Flutter output', () => {
  const prev = process.env.COMPANION_APK_SRC;
  try {
    delete process.env.COMPANION_APK_SRC;
    assert.match(
      companionApkSrc().replace(/\\/g, '/'),
      /apps\/android\/build\/app\/outputs\/flutter-apk\/app-release\.apk$/,
    );
    process.env.COMPANION_APK_SRC = 'some/custom-build.apk';
    assert.match(companionApkSrc().replace(/\\/g, '/'), /custom-build\.apk$/);
  } finally {
    if (prev === undefined) delete process.env.COMPANION_APK_SRC;
    else process.env.COMPANION_APK_SRC = prev;
  }
});

test('ships the analyzer skill prompts (read at runtime from <root>/skills)', () => {
  assert.equal(matchesManifest('skills/audiobook-sentence-attribution.md'), true);
  assert.equal(matchesManifest('skills/audiobook-character-detection-per-chapter.md'), true);
  assert.equal(matchesManifest('skills/audiobook-voice-style.md'), true);
});

test('ships the fs-22 bundled demo book (manuscript + cast + voice files)', () => {
  assert.equal(matchesManifest('samples/the-coalfall-commission/.audiobook/cast.json'), true);
  assert.equal(matchesManifest('samples/the-coalfall-commission/voices/qwen/qwen-coalfall.pt'), true);
});

// PR #3404 review pass 2/3 — the same class as the is-main-module.mjs guard in
// entry-point-guard-convention.test.mjs, made general: a shipped file that
// gains a relative import must have that import target ALSO shipped, or it
// crashes/no-ops at import / dot-source time on a real zip install.
//
// Scans EVERY tracked file the manifest ships (not just literal scripts/
// entries — server/src/** and server/tts-sidecar/** reach OUT of their globs
// too: server/src/index.ts imports sidecar installers, and the
// attribution-eval CLIs import across trees). JS/TS files go through the
// TypeScript lexer (`ts.preProcessFile`, plus a token scan for `new URL(…,
// import.meta.url)`), which handles comments and string contents correctly —
// the previous regex enumeration + line-comment stripping did not (a `/*`
// inside `'logs/*.log'` ate real imports; `indexOf('//')` ate an import after
// `'https://…'`). PowerShell is scanned differently: a lexer exists
// ([System.Management.Automation.Language.Parser]::ParseFile, on every leg
// that runs PowerShell) but a Node test cannot call it without spawning a
// shell, so it gets a small quote-aware comment stripper plus the spellings that reach a script- or
// module-dir-relative file: `Join-Path <dir> '<rel>'` (with or without
// -Path / -ChildPath, wrapped in dot-source / `&` / Import-Module or not) and
// `"$PSScriptRoot\<rel>"` interpolation.
const SHIPPED_CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
const SHIPPED_PS_EXT = /\.(ps1|psm1)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.Tests\.ps1$/;
const PS_REFERENCED_EXT =/\.(ps1|psm1|psd1|mjs|cjs|js)$/i;

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean);
}

function relativeJsSpecifiers(source) {
  const specs = new Set();
  const info = ts.preProcessFile(source, true, true);
  for (const f of info.importedFiles) specs.add(f.fileName);
  // `new URL('./x', import.meta.url)` — a file reference preProcessFile does
  // not model. Token scan: new URL ( <string> , import . meta . url
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const window = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    window.push({ kind, value: scanner.getTokenValue() });
    if (window.length > 10) window.shift();
    if (window.length < 10) continue;
    const [nw, url, lp, str, comma, imp, dot1, meta, dot2, last] = window;
    if (
      nw.kind === ts.SyntaxKind.NewKeyword &&
      url.value === 'URL' &&
      lp.kind === ts.SyntaxKind.OpenParenToken &&
      (str.kind === ts.SyntaxKind.StringLiteral || str.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) &&
      comma.kind === ts.SyntaxKind.CommaToken &&
      imp.kind === ts.SyntaxKind.ImportKeyword &&
      dot1.kind === ts.SyntaxKind.DotToken &&
      meta.value === 'meta' &&
      dot2.kind === ts.SyntaxKind.DotToken &&
      last.value === 'url'
    ) {
      specs.add(str.value);
    }
  }
  return [...specs].filter((s) => /^\.\.?\//.test(s));
}

// Strip PowerShell comments (`# …` and `<# … #>`) without touching text inside
// '…' / "…" strings.
function stripPsComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

function relativePsReferences(source) {
  const src = stripPsComments(source);
  // $PSScriptRoot, plus any variable assigned the script's own directory
  // (`$here = Split-Path -Parent $MyInvocation.MyCommand.Path`).
  const dirVars = new Set(['PSScriptRoot']);
  for (const m of src.matchAll(
    /\$(\w+)\s*=\s*Split-Path\s+(?:-Parent\s+)?(?:\$MyInvocation\.MyCommand\.(?:Path|Definition)|\$PSCommandPath)/gi,
  )) {
    dirVars.add(m[1]);
  }
  const vars = [...dirVars].join('|');
  const refs = new Set();
  const add = (rel) => {
    const norm = rel.replace(/\\/g, '/');
    if (PS_REFERENCED_EXT.test(norm)) refs.add(norm);
  };
  // Join-Path $dir 'rel' / Join-Path -Path $dir -ChildPath "rel"
  const joinRe = new RegExp(
    String.raw`Join-Path\s+(?:-Path\s+)?\$(?:${vars})\s+(?:-ChildPath\s+)?['"]([^'"]+)['"]`,
    'gi',
  );
  for (const m of src.matchAll(joinRe)) add(m[1]);
  // "$PSScriptRoot\rel" / "$here\rel" interpolation (dot-source, &, Import-Module -Name …)
  const interpRe = new RegExp(String.raw`\$(?:${vars})[\\/]([^\s'"` + '`' + String.raw`)]+)`, 'gi');
  for (const m of src.matchAll(interpRe)) add(m[1]);
  return [...refs];
}

// Resolve a specifier the way a TS/Node resolver would, against the tracked
// file set. Returns the tracked paths it can mean ([] when none is tracked —
// a generated or non-tracked target this guard cannot judge).
function resolveTracked(fromRel, spec, trackedSet) {
  const base = relative(repoRoot, resolve(repoRoot, dirname(fromRel), spec)).split('\\').join('/');
  const stem = base.replace(/\.(m?js|cjs)$/, '');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.mts', '.cts'].map((e) => stem + e),
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.psm1', '.ps1'].map((e) => base + e),
    ...['/index.ts', '/index.tsx', '/index.js', '/index.mjs'].map((e) => base + e),
  ];
  return candidates.filter((c) => trackedSet.has(c));
}

// A shipped file that reaches an unshipped target, and why that is fine.
// Each entry is keyed `<importer> -> <target>` so a SECOND unshipped import
// from the same importer still fails.
const UNSHIPPED_IMPORT_ALLOWLIST = {
  // run-golden-tests.ps1 is the opt-in maintainer golden-audio runner: it
  // drives server/tts-sidecar/tests/golden/, which is itself excluded from the
  // zip (`server/tts-sidecar/tests/**`), so the script cannot run on an
  // install regardless of whether its dot-sourced helper ships.
  'server/tts-sidecar/run-golden-tests.ps1 -> scripts/lib/golden-bless-pytest-args.ps1':
    'maintainer golden-audio runner; its tests/ tree is not shipped either',
};

test('every relative import target of a MANIFEST-shipped file is itself shipped', () => {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const failures = [];
  for (const rel of tracked) {
    if (!matchesManifest(rel)) continue;
    // A *.test.* / *.Tests.ps1 file ships with its glob but never RUNS on an
    // install (no vitest/Pester there), so what it imports can't crash one.
    if (TEST_FILE.test(rel)) continue;
    const isCode = SHIPPED_CODE_EXT.test(rel);
    const isPs = SHIPPED_PS_EXT.test(rel);
    if (!isCode && !isPs) continue;
    const source = readFileSync(resolve(repoRoot, rel), 'utf8');
    const specs = isCode ? relativeJsSpecifiers(source) : relativePsReferences(source);
    for (const spec of specs) {
      for (const target of resolveTracked(rel, spec, trackedSet)) {
        if (matchesManifest(target)) continue;
        if (`${rel} -> ${target}` in UNSHIPPED_IMPORT_ALLOWLIST) continue;
        failures.push(`${rel} imports ${target}, which MANIFEST.include does not ship`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `The following shipped files import a target MANIFEST.include does not ship — ` +
      `add the target to MANIFEST.include (or, for a file that genuinely cannot run on an install, ` +
      `to UNSHIPPED_IMPORT_ALLOWLIST with a reason):\n${failures.join('\n')}`,
  );
});

// Positive controls for the scanner itself — every spelling must be FOUND,
// and the two lossy-comment-stripping shapes must not hide a later import.
test('relativeJsSpecifiers finds every import spelling, and is not fooled by strings that look like comments', () => {
  const source = [
    "import a from './from.mjs';",
    "import './side-effect.mjs';",
    "export { b } from './reexport.mjs';",
    "const c = require('./required.cjs');",
    "const d = await import('./dynamic.mjs');",
    'const e = await import(`./template.mjs`);',
    "const f = new URL('./url-ref.mjs', import.meta.url);",
    "const glob = 'logs/*.log'; const u = 'https://example.com'; import('./after-strings.mjs');",
    "// import './commented-out.mjs';",
    "/* import './block-commented.mjs'; */",
    "import bare from 'node:fs'; import pkg from 'typescript';",
  ].join('\n');
  const found = relativeJsSpecifiers(source).sort();
  assert.deepEqual(found, [
    './after-strings.mjs',
    './dynamic.mjs',
    './from.mjs',
    './reexport.mjs',
    './required.cjs',
    './side-effect.mjs',
    './template.mjs',
    './url-ref.mjs',
  ]);
});

test('relativePsReferences finds dot-source / Import-Module / & / Join-Path spellings and ignores comments', () => {
  const source = [
    '$here = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '. (Join-Path $here "..\\..\\scripts\\lib\\dot-join.ps1")',
    '. "$PSScriptRoot\\lib\\dot-interp.ps1"',
    'Import-Module (Join-Path $PSScriptRoot "lib\\mod-join.psm1") -Force',
    'Import-Module -Name "$PSScriptRoot\\lib\\mod-name.psm1"',
    "& (Join-Path -Path $PSScriptRoot -ChildPath 'amp-child.ps1')",
    '$m = Join-Path $here "lib\\via-variable.psm1"; Import-Module $m',
    "# . (Join-Path $PSScriptRoot 'commented.ps1')",
    '<# Import-Module "$PSScriptRoot\\block-commented.psm1" #>',
    "$other = Join-Path $someOtherVar 'unrelated.ps1'",
  ].join('\n');
  assert.deepEqual(relativePsReferences(source).sort(), [
    '../../scripts/lib/dot-join.ps1',
    'amp-child.ps1',
    'lib/dot-interp.ps1',
    'lib/mod-join.psm1',
    'lib/mod-name.psm1',
    'lib/via-variable.psm1',
  ]);
});

// The general scan above only follows static references FROM a shipped file.
// server/src/system/prevent-sleep.ts reaches scripts/lib/prevent-sleep.ps1
// the other direction — by spawning a resolve()-built path at runtime, not a
// static relative import — so no source-level regex over server/src/** can
// find it without either false-positiving on unrelated string literals or
// hand-parsing arbitrary spawn() call expressions. A targeted assertion is
// the honest fix for that one known site rather than a scan that looks
// general but only works by accident.
test('prevent-sleep.ps1 (spawned by server/src/system/prevent-sleep.ts) ships in the release zip', () => {
  assert.equal(
    matchesManifest('scripts/lib/prevent-sleep.ps1'),
    true,
    'server/src/system/prevent-sleep.ts spawns scripts/lib/prevent-sleep.ps1 at runtime; a ' +
      'missing manifest entry makes Windows sleep prevention silently inert on a zip install.',
  );
});

test('the npm-script targets that shipped text tells a zip user to run ship too (install:cert-mobile, tts:sidecar)', () => {
  for (const target of ['scripts/print-cert-install-instructions.mjs', 'scripts/launch-sidecar.mjs']) {
    assert.equal(
      matchesManifest(target),
      true,
      `${target} is the target of an npm script shipped text points users at; unshipped it crashes ` +
        'with ERR_MODULE_NOT_FOUND on a zip install.',
    );
  }
});

// The import scan above follows static imports; shipped TEXT reaches an
// unshipped script through package.json's `scripts` instead ("Run `npm run X`").
// For every root npm script whose command is `node <tracked file>`, if that file
// is not shipped, no shipped file may tell the user to `npm run` it.
// Comment-only mentions are listed (keyed `<file> -> <script>`) with a reason.
const UNSHIPPED_NPM_RUN_ALLOWLIST = {
  // The opt-in maintainer golden-audio runners: their tests/golden/ tree is not
  // shipped (`server/tts-sidecar/tests/**`), so they cannot run on an install
  // regardless (same reason as UNSHIPPED_IMPORT_ALLOWLIST's run-golden-tests entry).
  'server/tts-sidecar/run-golden-tests.ps1 -> test:golden-audio:sidecar':
    'maintainer golden-audio runner; its tests/ tree is not shipped either',
  'server/tts-sidecar/run-tests.ps1 -> test:golden-audio':
    'maintainer golden-audio runner; its tests/ tree is not shipped either',
};
const SHIPPED_TEXT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|md|ps1|psm1)$/;

test('no MANIFEST-shipped file tells the user to `npm run` a script whose target file is not shipped', () => {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const unshipped = [];
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    const m = /^node\s+(\S+)/.exec(cmd);
    if (!m) continue;
    const target = m[1].replace(/^\.\//, '');
    if (trackedSet.has(target) && !matchesManifest(target)) unshipped.push({ name, target });
  }
  assert.ok(unshipped.length > 0, 'sanity: the repo has unshipped maintainer scripts for this guard to judge');
  const failures = [];
  for (const rel of tracked) {
    if (!matchesManifest(rel) || TEST_FILE.test(rel) || !SHIPPED_TEXT_EXT.test(rel)) continue;
    const source = readFileSync(resolve(repoRoot, rel), 'utf8');
    for (const { name, target } of unshipped) {
      const re = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`);
      if (re.test(source) && !(`${rel} -> ${name}` in UNSHIPPED_NPM_RUN_ALLOWLIST)) {
        failures.push(`${rel} says \`npm run ${name}\`, but its target ${target} is not shipped`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `Add the target to MANIFEST.include, reword the text, or (comment-only mention) allowlist it:\n${failures.join('\n')}`,
  );
});
