// Plan 49 — pin the manifest decisions in scripts/build-release-zip.mjs.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Asserts the right cross-section of:
//   - includes (frontend source, server source, sidecar source, runtime scripts)
//   - excludes (node_modules, .venv, Kokoro weights, dev-only docs, maintainer scripts)
//   - .gitkeep retention inside keepGitkeepIn directories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// PR #3404 review pass 2, orange finding 2 — the same class as the
// is-main-module.mjs guard in entry-point-guard-convention.test.mjs, made
// general: a shipped scripts/*.{mjs,cjs,ps1,psm1} file that gains a new
// relative import (JS `./…`/`../…`, or a `Join-Path $PSScriptRoot …`
// Import-Module) must have that import target ALSO in MANIFEST.include, or
// the entry point crashes/no-ops at import/dot-source time on a real zip
// install. Scoped to literal (non-glob) entries directly under `scripts/`
// — `server/tts-sidecar/**` and `server/src/**` ship wholesale via a glob,
// so a relative import that stays inside either tree is already covered by
// that glob; the one case that reaches OUT of a glob (scripts/lib/is-main-
// module.mjs, imported by nine server/tts-sidecar/scripts/*.mjs installers)
// is pinned separately by entry-point-guard-convention.test.mjs's own
// "shared helper ships in the release zip" test.
function shippedScriptEntries() {
  return MANIFEST.include.filter(
    (p) => p.startsWith('scripts/') && !p.includes('*') && /\.(mjs|cjs|ps1|psm1)$/.test(p),
  );
}

const JS_IMPORT_PATTERNS = [
  /\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
];
const PS_IMPORT_MODULE_PATTERN =
  /Import-Module\s*\(\s*Join-Path\s+\$PSScriptRoot\s+['"]([^'"]+)['"]\s*\)/g;

// Strip comments before matching — this repo's scripts are prose-heavy, and
// a doc comment can itself contain example import text (e.g. is-main-
// module.mjs's own header shows `import { isDirectlyInvoked } from
// './lib/is-main-module.mjs';` as guidance for ITS callers, not a real
// self-import) that a naive scan over raw source mis-reads as a real target.
function stripLineComments(source, commentToken) {
  return source
    .split('\n')
    .map((line) => {
      const idx = line.indexOf(commentToken);
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function relativeImportTargets(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const dir = dirname(absPath);
  const rawTargets = new Set();
  if (/\.(mjs|cjs)$/.test(absPath)) {
    const source = stripLineComments(raw.replace(/\/\*[\s\S]*?\*\//g, ''), '//');
    for (const pattern of JS_IMPORT_PATTERNS) {
      for (const m of source.matchAll(pattern)) rawTargets.add(m[1]);
    }
  } else {
    const source = stripLineComments(raw, '#');
    for (const m of source.matchAll(PS_IMPORT_MODULE_PATTERN)) {
      rawTargets.add(m[1].replace(/\\/g, '/'));
    }
  }
  return [...rawTargets].map((t) => resolve(dir, t));
}

test('every relative import target of a MANIFEST-shipped scripts/ file is itself shipped', () => {
  const failures = [];
  for (const rel of shippedScriptEntries()) {
    const absPath = resolve(repoRoot, rel);
    for (const targetAbs of relativeImportTargets(absPath)) {
      const targetRel = relative(repoRoot, targetAbs).split('\\').join('/');
      if (!matchesManifest(targetRel)) {
        failures.push(`${rel} imports ${targetRel}, which MANIFEST.include does not ship`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `The following shipped scripts/ files import a target MANIFEST.include does not ship — ` +
      `add the target to MANIFEST.include:\n${failures.join('\n')}`,
  );
});

// The general scan above only follows imports FROM a shipped scripts/ file.
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
