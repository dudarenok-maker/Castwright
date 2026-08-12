// PR review finding 3 (entry-point-guard convention branch, follow-up to
// #2296/#2297): a mid-archive `archive.on('error', …)` used to be fatal
// instantly via process.exit(1) in the caller. Once build-release-zip.mjs
// stopped calling process.exit() (a648f31a, to fix truncated stdout on an
// async POSIX pipe — see the comment by CliError/die in
// scripts/build-release-zip.mjs), an unhandled archive error just rejected
// the zip-writing Promise while archive.pipe(output) kept draining every
// already-queued file: the build sat for the full archive duration and left
// a larger, complete-looking but INVALID zip at outPath. writeReleaseZip's
// `onArchiveError` handler now aborts the archiver, destroys the output
// stream, and removes the partial file on any archive error or non-ENOENT
// warning.
//
// This drives that exact handler via an injected `loadArchiver` — a real
// archiver-internal race (a file vanishing between its lstat and its read)
// is possible but not reliably reproducible cross-platform on demand.
// scripts/tests/archiver-zip.test.mjs separately pins that archiver's real
// .pipe/.file/.finalize/warning/error surface behaves the way this code
// assumes, so faking just the emission of an 'error'/'warning' here tests
// OUR wiring without re-testing archiver's own internals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReleaseZip } from '../build-release-zip.mjs';

// Minimal stand-in for archiver's ZipArchive. Records whether `.abort()` was
// called, captures the real output stream passed to `.pipe()` so a test can
// drive it to completion, and runs a per-test `onFinalize(archive)` callback
// from `.finalize()` to simulate the archiver library firing its own
// 'error'/'warning' event at the point a real mid-archive failure would.
class FakeZipArchive extends EventEmitter {
  constructor(onFinalize) {
    super();
    this.aborted = false;
    this.finalized = false;
    this.output = null;
    this._onFinalize = onFinalize;
  }
  pipe(output) {
    this.output = output;
    return this;
  }
  file() {
    // No-op: this fake never writes real zip bytes. archiver-zip.test.mjs
    // already proves the real .file()/.finalize() path produces valid
    // zip content; this suite only exercises the error-handling wiring.
  }
  abort() {
    this.aborted = true;
  }
  finalize() {
    this.finalized = true;
    this._onFinalize(this);
  }
}

function loaderFor(fake) {
  return () =>
    Promise.resolve({
      ZipArchive: class {
        constructor() {
          return fake;
        }
      },
    });
}

test('writeReleaseZip aborts the archiver and removes the partial zip on a mid-archive error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-release-zip-cleanup-error-'));
  try {
    const outPath = join(dir, 'castwright-v9.9.9.zip');
    const fake = new FakeZipArchive((archive) => {
      setImmediate(() =>
        archive.emit('error', Object.assign(new Error('EACCES: fake mid-archive failure'), { code: 'EACCES' })),
      );
    });

    await assert.rejects(
      () =>
        writeReleaseZip({
          outPath,
          matched: [{ rel: 'package.json', abs: join(dir, 'package.json') }],
          apkSrc: null,
          apkExists: false,
          version: 'v9.9.9',
          loadArchiver: loaderFor(fake),
        }),
      /EACCES: fake mid-archive failure/,
    );

    assert.equal(fake.finalized, true, 'finalize() should still have been reached');
    // Per archiver's own core.js doc, abort() stops it draining any
    // remaining queued files — this is the fix under test.
    assert.equal(fake.aborted, true, 'archive.abort() must be called on a mid-archive error');
    assert.equal(existsSync(outPath), false, 'a failed build must not leave a partial zip at outPath');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReleaseZip treats a non-ENOENT archive warning the same as an error (aborts, cleans up, rejects)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-release-zip-cleanup-warn-'));
  try {
    const outPath = join(dir, 'castwright-v9.9.9.zip');
    const fake = new FakeZipArchive((archive) => {
      setImmediate(() =>
        archive.emit('warning', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
      );
    });

    await assert.rejects(
      () =>
        writeReleaseZip({
          outPath,
          matched: [{ rel: 'package.json', abs: join(dir, 'package.json') }],
          apkSrc: null,
          apkExists: false,
          version: 'v9.9.9',
          loadArchiver: loaderFor(fake),
        }),
      /EACCES: permission denied/,
    );

    assert.equal(fake.aborted, true, 'a non-ENOENT warning must also abort the archiver');
    assert.equal(existsSync(outPath), false, 'a failed build must not leave a partial zip at outPath');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReleaseZip ignores an ENOENT warning (no abort, resolves normally)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-release-zip-cleanup-enoent-'));
  try {
    const outPath = join(dir, 'castwright-v9.9.9.zip');
    const fake = new FakeZipArchive((archive) => {
      archive.emit('warning', Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
      // A real archiver run ends the piped output once finalize() genuinely
      // completes; do the same here so writeReleaseZip's Promise resolves
      // instead of hanging on a fake that never really pipes anything.
      archive.output.end();
    });

    await writeReleaseZip({
      outPath,
      matched: [{ rel: 'package.json', abs: join(dir, 'package.json') }],
      apkSrc: null,
      apkExists: false,
      version: 'v9.9.9',
      loadArchiver: loaderFor(fake),
    });

    assert.equal(fake.aborted, false, 'an ENOENT warning must not abort the archiver');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
