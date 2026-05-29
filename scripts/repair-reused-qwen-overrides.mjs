#!/usr/bin/env node
/*
 * repair-reused-qwen-overrides.mjs
 *
 * One-time data repair for the reused-Qwen-voice consistency bug.
 *
 * Symptom: a reused character (voiceState 'reused'/'tuned', or any character
 * with `matchedFrom` set) is missing its own `overrideTtsVoices.qwen`, so
 * generation resolves it to '' and renders the chapter in Kokoro instead of the
 * character's designed voice. The runtime fix
 * (server/src/tts/hydrate-reused-voice.ts) resolves this on the fly; writing
 * the override back onto every cast.json makes the data self-consistent so the
 * cast view, exports, and any direct reader agree without read-time hydration.
 *
 * Resolution order per character (matches the runtime resolver, plus a
 * recovery-only fallback the runtime deliberately omits):
 *   1. SOURCE-BOOK CHAIN — follow `matchedFrom` back to the book that holds the
 *      designed override and copy its ttsEngine + overrideTtsVoices.
 *   2. ON-DISK FALLBACK (RECOVERY ONLY) — when no book in the chain carries an
 *      override but the deterministic designed file
 *      `voices/qwen/qwen-<voiceId>.pt` EXISTS, reconstruct the override as
 *      { qwen: { name: `qwen-<voiceId>` } }. This is the only way to recover a
 *      voice whose override was lost in every book (e.g. Lord Vane). The
 *      runtime path never probes disk; this migration does, once, to heal data.
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
 *   node scripts/repair-reused-qwen-overrides.mjs            # dry run
 *   node scripts/repair-reused-qwen-overrides.mjs --apply    # write
 *   BASE="C:/AudiobookWorkspace" node scripts/repair-reused-qwen-overrides.mjs
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

const hasOwnQwen = (c) => !!c?.overrideTtsVoices?.qwen?.name;

/* Recursively collect every `<dir>/.audiobook/` that holds a cast.json — the
   canonical book marker. Robust to tree depth (Author/Series/Title) and
   ignores stray cast.json files not under a `.audiobook/` dir. */
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

/* bookId -> { bookId, title, castPath, isArray, characters }. */
function indexBooks() {
  const byId = new Map();
  const all = [];
  for (const ab of findAudiobookDirs(BOOKS_ROOT)) {
    const state = readJson(path.join(ab, 'state.json'));
    const castPath = path.join(ab, 'cast.json');
    const cast = readJson(castPath);
    const isArray = Array.isArray(cast);
    const characters = isArray ? cast : (cast?.characters ?? null);
    if (!characters) continue;
    const entry = {
      bookId: state?.bookId,
      title: path.basename(path.dirname(ab)),
      castPath,
      isArray,
      characters,
    };
    all.push(entry);
    if (state?.bookId) byId.set(state.bookId, entry);
  }
  return { byId, all };
}

/* Follow matchedFrom back to the book that holds the designed override. */
function resolveFromChain(character, byId, maxHops = 8) {
  if (hasOwnQwen(character)) return null;
  const seen = new Set();
  let cursor = character;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const from = cursor?.matchedFrom;
    if (!from?.bookId || !from?.characterId) return null;
    const key = `${from.bookId}::${from.characterId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const src = byId.get(from.bookId);
    if (!src) return null;
    const source = src.characters.find((c) => c.id === from.characterId);
    if (!source) return null;
    if (hasOwnQwen(source)) {
      return {
        ttsEngine: source.ttsEngine ?? 'qwen',
        overrideTtsVoices: source.overrideTtsVoices ?? {},
      };
    }
    cursor = source;
  }
  return null;
}

/* Recovery-only fallback: the deterministic designed file qwen-<voiceId>.pt. */
function resolveFromDisk(character) {
  const voiceId = character.voiceId;
  if (!voiceId) return null;
  const name = `qwen-${voiceId}`;
  if (!fs.existsSync(path.join(QWEN_VOICES_DIR, `${name}.pt`))) return null;
  return { ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name } } };
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

  const { byId, all } = indexBooks();
  console.log(`Indexed ${all.length} book(s).\n`);

  let changedFiles = 0;
  let viaChain = 0;
  let viaDisk = 0;
  let unresolved = 0;

  for (const book of all) {
    const planned = [];
    let mutated = false;

    const nextChars = book.characters.map((c) => {
      const isReuse = !!c.matchedFrom || c.voiceState === 'reused' || c.voiceState === 'tuned';
      if (!isReuse || hasOwnQwen(c)) return c;

      let resolved = resolveFromChain(c, byId);
      let via = 'chain';
      if (!resolved) {
        resolved = resolveFromDisk(c);
        via = 'disk';
      }
      if (!resolved) {
        unresolved += 1;
        planned.push(
          `    - ${c.name} (${c.id}) — UNRESOLVED (no source override; no qwen-${c.voiceId}.pt)`,
        );
        return c;
      }

      if (via === 'chain') viaChain += 1;
      else viaDisk += 1;
      mutated = true;

      const mergedOverrides = {
        ...resolved.overrideTtsVoices,
        ...(c.overrideTtsVoices ?? {}),
      };
      planned.push(
        `    + ${c.name} (${c.id}) — ${via}: ttsEngine=${resolved.ttsEngine}, qwen=${mergedOverrides.qwen?.name}`,
      );
      return {
        ...c,
        ttsEngine: c.ttsEngine ?? resolved.ttsEngine ?? null,
        overrideTtsVoices: mergedOverrides,
      };
    });

    if (planned.length) {
      console.log(`  [${book.title}] (${book.bookId ?? 'no-bookId'})`);
      for (const line of planned) console.log(line);
    }

    if (mutated) {
      changedFiles += 1;
      if (APPLY) {
        const out = book.isArray ? nextChars : { ...readJson(book.castPath), characters: nextChars };
        fs.copyFileSync(book.castPath, `${book.castPath}.bak`);
        fs.writeFileSync(book.castPath, `${JSON.stringify(out, null, 2)}\n`);
      }
    }
  }

  console.log(
    `\nSummary: ${changedFiles} cast file(s) ${APPLY ? 'written' : 'would change'}; ` +
      `${viaChain} via source chain, ${viaDisk} via on-disk recovery, ${unresolved} unresolved.`,
  );
  if (!APPLY && changedFiles) {
    console.log('DRY RUN — re-run with --apply to write (a .bak is saved per file).');
  }
}

main();
