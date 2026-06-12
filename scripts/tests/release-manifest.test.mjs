// Plan 49 — pin the manifest decisions in scripts/build-release-zip.mjs.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Asserts the right cross-section of:
//   - includes (frontend source, server source, sidecar source, runtime scripts)
//   - excludes (node_modules, .venv, Kokoro weights, dev-only docs, maintainer scripts)
//   - .gitkeep retention inside keepGitkeepIn directories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST,
  matchesManifest,
  releaseZipName,
  releaseInternalPrefix,
  companionApkSrc,
  companionApkZipEntry,
} from '../build-release-zip.mjs';

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
