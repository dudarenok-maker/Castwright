// Plan 104 — pin the archiver v8 API contract that
// scripts/build-release-zip.mjs depends on. Discovered by
// `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// archiver v8 dropped the v7 callable factory (`archiver('zip', …)`) in
// favour of pure-ESM named class exports (ZipArchive / TarArchive / …).
// build-release-zip.mjs now constructs `new ZipArchive(opts)` and drives
// it via .pipe / .file / .finalize + warning/error events. This test
// exercises that exact surface end-to-end so a future archiver bump that
// changes the class API fails here rather than silently at release time
// (the release zip builder has no other automated coverage of the zip
// write path — release-manifest.test.mjs only pins the MANIFEST rules).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('archiver v8 exposes ZipArchive as a constructable class (no v7 factory)', async () => {
  const mod = await import('archiver');
  assert.equal(
    typeof mod.ZipArchive,
    'function',
    'archiver must export a ZipArchive class — build-release-zip.mjs constructs `new ZipArchive(...)`',
  );
  // v7's callable default factory must be gone (or at least not relied on).
  assert.equal(mod.default, undefined, 'archiver v8 has no callable default export');
});

test('ZipArchive builds a non-empty zip via the .pipe/.file/.finalize surface used by build-release-zip', async () => {
  const { ZipArchive } = await import('archiver');
  const dir = mkdtempSync(join(tmpdir(), 'archiver-zip-test-'));
  try {
    const srcPath = join(dir, 'hello.txt');
    writeFileSync(srcPath, 'audiobook-generator release smoke test');
    const outPath = join(dir, 'out.zip');

    await new Promise((resolveZip, rejectZip) => {
      const output = createWriteStream(outPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on('close', resolveZip);
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') return;
        rejectZip(err);
      });
      archive.on('error', rejectZip);
      archive.pipe(output);
      archive.file(srcPath, { name: 'release/hello.txt' });
      archive.finalize();
    });

    const size = statSync(outPath).size;
    assert.ok(size > 0, 'finalized zip should be non-empty');
    // A PKZIP local-file-header begins with the bytes "PK\x03\x04".
    const buf = await readFile(outPath);
    assert.equal(buf[0], 0x50, 'zip magic byte 0 (P)');
    assert.equal(buf[1], 0x4b, 'zip magic byte 1 (K)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
