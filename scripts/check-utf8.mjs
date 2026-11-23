#!/usr/bin/env node
// scripts/check-utf8.mjs
//
// CI guard (#4586): fail on any tracked TEXT file under server/, src/ or
// scripts/ that is not valid UTF-8. #4594 re-encoded server/src/upgrade/apply.ts,
// which had a lone Windows-1252 byte (0x97, an em dash) in a comment; this
// check keeps that from recurring.
//
// Usage:
//   node scripts/check-utf8.mjs      # scan the git repo at the cwd
//
// Binary files are skipped (a NUL byte anywhere, or a known binary extension).
// There is deliberately NO per-file allowlist: if a text file must be non-UTF-8,
// extend this script so the exception is visible in review.
//
// Exits 0 if clean; exits 1 and names each offending file with the byte offset
// of the first invalid sequence otherwise.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubGitEnv } from './git-env.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

export const SCAN_ROOTS = ['server', 'src', 'scripts'];

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'pdf',
  'zip', 'gz', 'mp3', 'wav', 'mp4', 'm4a', 'm4b', 'onnx', 'bin',
  'safetensors', 'pt', 'pth', 'npz', 'npy',
]);

function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset of the first byte of the first invalid sequence, or -1 if valid.
 * @param {Uint8Array} bytes
 */
function firstInvalidOffset(bytes) {
  if (isValidUtf8(bytes)) return -1;
  // stream:true tolerates a multi-byte character cut at the prefix end, so the
  // smallest invalid prefix length n pins the fault to byte n-1.
  const prefixOk = (n) => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n), { stream: true });
      return true;
    } catch {
      return false;
    }
  };
  let lo = 0;
  let hi = bytes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixOk(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Pure core. Returns the entries that are not valid UTF-8 text.
 * Binary entries (NUL byte, or extension in BINARY_EXTENSIONS) are skipped.
 * @param {{ path: string, bytes: Uint8Array }[]} entries
 * @returns {{ path: string, offset: number }[]}
 */
export function findNonUtf8(entries) {
  const offenders = [];
  for (const { path, bytes } of entries) {
    if (BINARY_EXTENSIONS.has(extensionOf(path))) continue;
    if (bytes.includes(0)) continue;
    const offset = firstInvalidOffset(bytes);
    if (offset !== -1) offenders.push({ path, offset });
  }
  return offenders;
}

/**
 * Tracked files under SCAN_ROOTS in the git repo at `root`, as repo-relative
 * forward-slash paths.
 * @param {string} root
 * @returns {string[]}
 */
export function listTrackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], {
    cwd: root,
    env: scrubGitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Read every tracked file under `root` and return the non-UTF-8 offenders.
 * @param {string} root
 */
export function scanTrackedTextFiles(root) {
  const entries = [];
  for (const path of listTrackedFiles(root)) {
    try {
      entries.push({ path, bytes: readFileSync(join(root, path)) });
    } catch {
      // Tracked but absent from the working tree: nothing to check.
    }
  }
  return { checked: entries.length, offenders: findNonUtf8(entries) };
}

if (isDirectlyInvoked(import.meta.url)) {
  const { checked, offenders } = scanTrackedTextFiles(process.cwd());
  if (offenders.length === 0) {
    process.stdout.write(`check-utf8: OK — ${checked} tracked text files are valid UTF-8.\n`);
    process.exitCode = 0;
  } else {
    process.stdout.write('check-utf8: FAIL — non-UTF-8 files:\n');
    for (const o of offenders) {
      process.stdout.write(`  ${o.path} (first invalid byte at offset ${o.offset})\n`);
    }
    process.stdout.write('Fix: re-encode the file as UTF-8 (replace the stray byte with the intended character).\n');
    process.exitCode = 1;
  }
}
