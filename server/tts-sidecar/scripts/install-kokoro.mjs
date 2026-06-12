#!/usr/bin/env node
// install-kokoro.mjs -- download the Kokoro v1 ONNX model + voices manifest
// into the sidecar voices/kokoro/ directory so the sidecar can preload them
// on boot. (fs-21 wave 1 -- in-app install parity with install-kokoro.ps1.)
//
// Cross-platform Node ESM (Windows + macOS + Linux). The .ps1/.sh siblings
// continue to exist for terminal use; this .mjs is the portable entry the
// in-app install-bootstrap can spawn without shell constraints.
//
// What it does:
//   1. Resolve the target directory (env overrides or <repoRoot>/server/
//      tts-sidecar/voices/kokoro/).
//   2. For each of the two weight files (kokoro-v1.0.onnx + voices-v1.0.bin):
//      - If the file exists AND its SHA256 matches the pin -> skip.
//      - Otherwise download via Node global fetch (follows 302 redirects),
//        verify SHA256, refuse + delete on mismatch.
//
// Usage:
//   node server/tts-sidecar/scripts/install-kokoro.mjs
//
// Idempotent: already-verified files are skipped without re-downloading.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> tts-sidecar/ -> server/ -> repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const KOKORO_URL_BASE =
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/';

const FILES = [
  { name: 'kokoro-v1.0.onnx', url: `${KOKORO_URL_BASE}kokoro-v1.0.onnx` },
  { name: 'voices-v1.0.bin', url: `${KOKORO_URL_BASE}voices-v1.0.bin` },
];

/** SHA256 a file synchronously, returning a lowercased hex string. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Read the kokoro section from model-hashes.json (next to this script).
 * Returns an object keyed by filename, each { sha256, sizeBytes }.
 */
export function kokoroHashes() {
  const manifest = JSON.parse(readFileSync(join(__dirname, 'model-hashes.json'), 'utf8'));
  return manifest.kokoro;
}

function step(msg) {
  process.stdout.write(`[install-kokoro] ${msg}\n`);
}

function resolveTargetDir() {
  // Prefer explicit env overrides (KOKORO_MODEL_PATH points at the .onnx file).
  if (process.env.KOKORO_MODEL_PATH) return dirname(process.env.KOKORO_MODEL_PATH);
  if (process.env.KOKORO_VOICES_PATH) return dirname(process.env.KOKORO_VOICES_PATH);
  return join(REPO_ROOT, 'server', 'tts-sidecar', 'voices', 'kokoro');
}

async function downloadFile(url, destPath) {
  step(`Downloading ${url}`);
  // Node 20 global fetch follows 302 redirects automatically (GitHub releases
  // 302 -> cdn.githubusercontent.com). No manual redirect handling needed.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) {
    throw new Error(
      `Downloaded file is only ${buf.length} bytes -- looks like an error page, not weights.`,
    );
  }
  await writeFile(destPath, buf);
}

async function installFile(name, url, targetDir, hashes) {
  const dest = join(targetDir, name);
  const pin = hashes[name];

  if (existsSync(dest)) {
    const actual = sha256File(dest);
    if (pin && actual === pin.sha256) {
      step(`${name} already present, verified — skipping.`);
      return;
    }
    step(`${name} exists but failed integrity check — re-downloading.`);
    unlinkSync(dest);
  }

  await downloadFile(url, dest);

  step(`Verifying ${name}...`);
  const actual = sha256File(dest);
  if (pin && actual !== pin.sha256) {
    unlinkSync(dest);
    step(`ERROR sha256 mismatch for ${name}`);
    step(`  expected ${pin.sha256}`);
    step(`  got      ${actual}`);
    step(
      `  Deleted the file. Re-run to retry, or re-bless model-hashes.json if the upstream asset legitimately changed.`,
    );
    process.exit(1);
  }

  const sizeMB = ((await import('node:fs')).statSync(dest).size / 1024 / 1024).toFixed(1);
  step(`Downloaded and verified ${name} (${sizeMB} MB).`);
}

async function main() {
  const targetDir = resolveTargetDir();

  if (!existsSync(targetDir)) {
    step(`Creating ${targetDir}`);
    mkdirSync(targetDir, { recursive: true });
  }

  const hashes = kokoroHashes();

  for (const { name, url } of FILES) {
    await installFile(name, url, targetDir, hashes);
  }

  step('Done. Restart the sidecar to pick up the new weights.');
}

// Run only when invoked directly (node install-kokoro.mjs); stay inert on import
// so unit tests can exercise sha256File / kokoroHashes without triggering a download.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[install-kokoro] FAIL: ${err.message}\n`);
    process.exit(1);
  });
}
