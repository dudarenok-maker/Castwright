#!/usr/bin/env node
/*
 * remint-anchored-variants.mjs
 *
 * One-time migration for fs-55: re-mints existing emotion variant voices
 * through the new anchored pipeline so they are identity-locked to their
 * base voice (not the old drifted approach that baked the full persona into
 * the emotion instruct).
 *
 * Background: Tasks 0-6 of fs-55 introduced a new mint path
 * (POST /qwen/mint-variant) that decodes the base voice's ref_code through
 * the 1.7B-Base and anchors the emotion variant to it.  Variants minted via
 * this path carry `"mintMethod": "anchored-icl-instruct"` in their sidecar
 * `.json`.  Pre-fs-55 variants lack that field — they were built differently
 * and may drift from the base speaker identity.  This script identifies those
 * legacy variants and re-mints them.
 *
 * How it works:
 *   1. Walk the qwen voices directory, reading each `<voiceId>.json`.
 *   2. `planRemints` filters to variant voiceIds (those with a `__<emotion>`
 *      suffix) whose json lacks `mintMethod === 'anchored-icl-instruct'`.
 *   3. In --apply mode, POST /qwen/mint-variant for each, using:
 *        baseVoiceId    = the variant id with `__<emotion>` stripped
 *        variantVoiceId = the original variant voiceId
 *        emotionInstruct = the canonical delivery clause from EMOTION_INSTRUCT
 *
 * Dry-run by default — prints the plan and exits without touching anything.
 * Pass --apply to perform the re-mints.
 *
 * Requirements:
 *   - The Qwen sidecar must be running and the 0.6B + 1.7B-Base models must
 *     be loaded (or loadable) — /qwen/mint-variant blocks until the mint
 *     completes.  Each base voice must have been designed already.
 *   - The sidecar URL defaults to http://localhost:9000; override with
 *     SIDECAR_URL or LOCAL_TTS_URL.
 *   - The qwen voices directory defaults to <AudiobookWorkspace>/voices/qwen;
 *     override with QWEN_VOICES_DIR.
 *
 * Usage:
 *   node scripts/remint-anchored-variants.mjs             # dry run
 *   node scripts/remint-anchored-variants.mjs --apply     # re-mint
 *   SIDECAR_URL=http://localhost:9000 node scripts/remint-anchored-variants.mjs --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// EMOTION_INSTRUCT — delivery clauses sent as emotionInstruct to the sidecar.
// Duplicated (not imported) from server/src/routes/qwen-voice.ts so this
// script has no build-time dep on the compiled server.
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const EMOTION_INSTRUCT = {
  whisper: 'Delivered in a very soft, breathy whisper — barely audible, hushed and faint.',
  angry: 'Delivered with loud, forceful anger — shouting, sharp and intense.',
  excited: 'Delivered with bright, high-energy excitement.',
  sad: 'Delivered sadly — subdued, downcast, and heavy.',
};

// ---------------------------------------------------------------------------
// Pure helper — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Given an array of voice descriptors `{ voiceId, mintMethod? }`, return the
 * voiceIds of legacy (non-anchored) emotion variants — those whose voiceId
 * contains a `__<emotion>` suffix AND whose mintMethod is NOT
 * `'anchored-icl-instruct'`.
 *
 * Base voices (no `__` suffix) are never included regardless of mintMethod.
 *
 * @param {Array<{ voiceId: string, mintMethod?: string }>} voices
 * @returns {string[]}
 */
export function planRemints(voices) {
  return voices
    .filter(
      ({ voiceId, mintMethod }) =>
        voiceId.includes('__') && mintMethod !== 'anchored-icl-instruct',
    )
    .map(({ voiceId }) => voiceId);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Collect all voice descriptors from `.json` files in `dir`.
 * Returns `{ voiceId, mintMethod? }[]` — one entry per file that has a
 * `voiceId` field.
 *
 * @param {string} dir
 * @returns {Array<{ voiceId: string, mintMethod?: string }>}
 */
function loadVoiceDescriptors(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const descriptors = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const data = readJson(path.join(dir, e.name));
    if (typeof data?.voiceId === 'string') {
      descriptors.push({ voiceId: data.voiceId, mintMethod: data.mintMethod });
    }
  }
  return descriptors;
}

/**
 * Strip the `__<emotion>` suffix from a variant voiceId to get the base id.
 * e.g. `'qwen-v_marlow__angry'` → `'qwen-v_marlow'`
 *
 * @param {string} variantId
 * @returns {string}
 */
function baseVoiceId(variantId) {
  const idx = variantId.lastIndexOf('__');
  return idx === -1 ? variantId : variantId.slice(0, idx);
}

/**
 * Extract the emotion label from a variant voiceId.
 * e.g. `'qwen-v_marlow__angry'` → `'angry'`
 *
 * @param {string} variantId
 * @returns {string}
 */
function emotionSuffix(variantId) {
  const idx = variantId.lastIndexOf('__');
  return idx === -1 ? '' : variantId.slice(idx + 2);
}

// ---------------------------------------------------------------------------
// main — exported for unit tests; also called when run as a script
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv               — flags (pass [] for dry-run defaults)
 * @param {string}   [qwenVoicesDirOverride] — override the qwen voices dir (tests)
 * @param {string}   [sidecarUrlOverride]    — override the sidecar base URL (tests)
 */
export async function main(argv = process.argv.slice(2), qwenVoicesDirOverride, sidecarUrlOverride) {
  const APPLY = argv.includes('--apply');

  const DEFAULT_WORKSPACE = path.join(os.homedir(), 'AudiobookWorkspace');
  const BASE =
    (process.env.BASE && path.resolve(process.env.BASE)) ||
    (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
    DEFAULT_WORKSPACE;

  const QWEN_DIR =
    qwenVoicesDirOverride ??
    (process.env.QWEN_VOICES_DIR && path.resolve(process.env.QWEN_VOICES_DIR)) ??
    path.join(BASE, 'voices', 'qwen');

  const SIDECAR_URL = (
    sidecarUrlOverride ??
    process.env.SIDECAR_URL ??
    process.env.LOCAL_TTS_URL ??
    'http://localhost:9000'
  ).replace(/\/+$/, '');

  console.log(`Qwen voices dir : ${QWEN_DIR}`);
  console.log(`Sidecar URL     : ${SIDECAR_URL}`);
  console.log(`Mode            : ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  if (!fs.existsSync(QWEN_DIR)) {
    console.error(`Qwen voices dir not found: ${QWEN_DIR}`);
    console.error('Set QWEN_VOICES_DIR or BASE to your workspace.');
    process.exit(1);
  }

  const descriptors = loadVoiceDescriptors(QWEN_DIR);
  console.log(`Found ${descriptors.length} voice file(s) in qwen dir.\n`);

  const legacy = planRemints(descriptors);

  if (legacy.length === 0) {
    console.log('No legacy variants found — nothing to re-mint.');
    return;
  }

  console.log(`Legacy variants to re-mint (${legacy.length}):`);
  for (const id of legacy) {
    const base = baseVoiceId(id);
    const emotion = emotionSuffix(id);
    const instruct = EMOTION_INSTRUCT[emotion];
    if (!instruct) {
      console.log(`  [SKIP] ${id} — unknown emotion '${emotion}' (no EMOTION_INSTRUCT clause)`);
      continue;
    }
    console.log(`  ${APPLY ? '' : '[dry] '}${id}  ←  base: ${base}  emotion: ${emotion}`);

    if (!APPLY) continue;

    // POST /qwen/mint-variant
    let response;
    try {
      response = await fetch(`${SIDECAR_URL}/qwen/mint-variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVoiceId: base,
          variantVoiceId: id,
          emotionInstruct: instruct,
        }),
      });
    } catch (err) {
      console.error(`  [ERROR] ${id}: fetch failed — ${err.message}`);
      process.exitCode = 1;
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`  [ERROR] ${id}: sidecar returned ${response.status} — ${text}`);
      process.exitCode = 1;
      continue;
    }

    console.log(`  [OK]   ${id} re-minted (${response.status})`);
  }

  console.log(`\nDone. ${legacy.length} variant(s) ${APPLY ? 're-minted' : 'would be re-minted'}.`);
  if (!APPLY) console.log('Re-run with --apply to perform the re-mints.');
}

// Run when executed directly (not imported in tests).
const selfPath = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (selfPath.endsWith('remint-anchored-variants.mjs')) {
  main();
}
