#!/usr/bin/env node
/*
 * backfill-qwen-voicestyle.mjs
 *
 * One-time data backfill for the missing-persona display gap (plan 149).
 *
 * Symptom: a character with a DESIGNED Qwen voice shows a blank "Voice persona"
 * in the Profile Drawer, and a re-design 400s ("Add a persona before
 * designing"). Cause: the persona text was persisted only on the voice sidecar
 * `voices/qwen/<name>.json` under `instruct`, never mirrored onto the
 * character's `voiceStyle` (reuse copies the override but not the persona, and
 * even origin books were missing it). The drawer reads `character.voiceStyle`.
 *
 * This script copies each designed voice's sidecar `instruct` back onto the
 * character's `voiceStyle` wherever it's empty, so the textarea (and the
 * design route's persona default) read it directly — and reuse pass-through
 * (server/src/routes/series-cast.ts) carries it to later volumes. The runtime
 * fallback (GET .../designed-persona) resolves it on the fly; this backfill
 * makes the data self-consistent for every direct reader.
 *
 * Scope + resolution per character:
 *   - In scope when it has a designed Qwen voice (own
 *     `overrideTtsVoices.qwen.name` OR a reused/derived `qwen-<voiceId>` whose
 *     sidecar exists) AND `voiceStyle` is empty/missing.
 *   - Sidecar name = own `overrideTtsVoices.qwen.name`, else `qwen-<voiceId>`.
 *   - Read `voices/qwen/<name>.json`.instruct; write it to `voiceStyle` when
 *     non-empty. A designed voice with no sidecar/instruct is UNRESOLVED
 *     (printed, not mutated).
 *
 * Idempotent: a character whose `voiceStyle` is already set is skipped.
 *
 * DRY RUN BY DEFAULT — prints the planned writes and exits without touching
 * disk. Pass --apply to write each changed cast.json (a .bak is written first).
 *
 * Env:
 *   BASE                 workspace root (overrides everything)
 *   AUDIOBOOK_WORKSPACE  workspace root (same default the server uses)
 *   default              <home>/AudiobookWorkspace
 *
 * Usage:
 *   node scripts/backfill-qwen-voicestyle.mjs            # dry run
 *   node scripts/backfill-qwen-voicestyle.mjs --apply    # write
 *   BASE="C:/AudiobookWorkspace" node scripts/backfill-qwen-voicestyle.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');

const BASE =
  (process.env.BASE && path.resolve(process.env.BASE)) ||
  (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
  path.join(os.homedir(), 'AudiobookWorkspace');

const BOOKS_ROOT = path.join(BASE, 'books');
const QWEN_VOICES_DIR = path.join(BASE, 'voices', 'qwen');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const hasVoiceStyle = (c) => typeof c?.voiceStyle === 'string' && c.voiceStyle.trim().length > 0;

/* The designed voice name for a character: an explicit per-character qwen
   override wins, else the stable derived `qwen-<voiceId>` (matches
   deriveQwenVoiceId on the server). Null when the character has no qwen
   identity at all. */
function designedVoiceName(c) {
  const own = c?.overrideTtsVoices?.qwen?.name;
  if (own) return own;
  if (c?.voiceId) return `qwen-${c.voiceId}`;
  return null;
}

/* Read the persona `instruct` from a voice sidecar, or '' when absent. */
function readInstruct(name) {
  const sidecar = readJson(path.join(QWEN_VOICES_DIR, `${name}.json`));
  return typeof sidecar?.instruct === 'string' ? sidecar.instruct.trim() : '';
}

/* Recursively collect every `<dir>/.audiobook/` that holds a cast.json. */
function findAudiobookDirs(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === '.audiobook') {
        if (fs.existsSync(path.join(child, 'cast.json'))) found.push(child);
        continue; // never descend into .audiobook
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

/* { bookId, title, castPath, isArray, characters } per book. */
function indexBooks() {
  const all = [];
  for (const ab of findAudiobookDirs(BOOKS_ROOT)) {
    const state = readJson(path.join(ab, 'state.json'));
    const castPath = path.join(ab, 'cast.json');
    const cast = readJson(castPath);
    const isArray = Array.isArray(cast);
    const characters = isArray ? cast : (cast?.characters ?? null);
    if (!characters) continue;
    all.push({
      bookId: state?.bookId,
      title: path.basename(path.dirname(ab)),
      castPath,
      isArray,
      characters,
    });
  }
  return all;
}

function main() {
  if (!fs.existsSync(BOOKS_ROOT)) {
    console.error(`No books dir at ${BOOKS_ROOT} (set BASE?). Aborting.`);
    process.exit(1);
  }
  console.log(`Workspace: ${BASE}`);
  console.log(
    `Qwen voices: ${QWEN_VOICES_DIR} (${fs.existsSync(QWEN_VOICES_DIR) ? 'present' : 'MISSING'})\n`,
  );

  const all = indexBooks();
  console.log(`Indexed ${all.length} book(s).\n`);

  let changedFiles = 0;
  let filled = 0;
  let unresolved = 0;

  for (const book of all) {
    const planned = [];
    let mutated = false;

    const nextChars = book.characters.map((c) => {
      const name = designedVoiceName(c);
      // Only touch characters that have a designed Qwen voice + no persona yet.
      if (!name || hasVoiceStyle(c)) return c;
      const onDisk = fs.existsSync(path.join(QWEN_VOICES_DIR, `${name}.json`));
      // Not a designed voice (no sidecar) and no own override → not in scope.
      if (!onDisk && !c?.overrideTtsVoices?.qwen?.name) return c;

      const instruct = readInstruct(name);
      if (!instruct) {
        unresolved += 1;
        planned.push(`    - ${c.name} (${c.id}) — UNRESOLVED (no instruct in ${name}.json)`);
        return c;
      }

      filled += 1;
      mutated = true;
      const preview = instruct.length > 60 ? `${instruct.slice(0, 57)}…` : instruct;
      planned.push(`    + ${c.name} (${c.id}) — ${name}: "${preview}"`);
      return { ...c, voiceStyle: instruct };
    });

    if (planned.length) {
      console.log(`  [${book.title}] (${book.bookId ?? 'no-bookId'})`);
      for (const line of planned) console.log(line);
    }

    if (mutated) {
      changedFiles += 1;
      if (APPLY) {
        const out = book.isArray
          ? nextChars
          : { ...readJson(book.castPath), characters: nextChars };
        fs.copyFileSync(book.castPath, `${book.castPath}.bak`);
        fs.writeFileSync(book.castPath, `${JSON.stringify(out, null, 2)}\n`);
      }
    }
  }

  console.log(
    `\nSummary: ${changedFiles} cast file(s) ${APPLY ? 'written' : 'would change'}; ` +
      `${filled} persona(s) backfilled, ${unresolved} unresolved.`,
  );
  if (!APPLY && changedFiles) {
    console.log('DRY RUN — re-run with --apply to write (a .bak is saved per file).');
  }
}

main();
