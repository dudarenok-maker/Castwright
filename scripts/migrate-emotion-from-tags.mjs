#!/usr/bin/env node
/*
 * migrate-emotion-from-tags.mjs
 *
 * One-time migration for fs-25 (plan 177) — retire the legacy inline audio-tag
 * system in favour of the structured `Sentence.emotion` field.
 *
 * The old per-quote work injected bracketed cues (`[shouting]`, `[excited]`,
 * `[whispers]`, `[emphatic]`, …) into `sentence.text`. They drove ZERO local
 * audio (every local TTS engine strips them) and were only a display layer.
 * fs-25 removes the display chips, so any bracket left in stored text would now
 * render literally ("[shouting]"). This migration, per cached analysis file:
 *   - seeds `sentence.emotion` from the FIRST emotion-mapping tag, ONLY when
 *     the sentence has no emotion yet (manual/analyzer emotion wins);
 *   - strips ALL known `[tags]` from `sentence.text`.
 *
 * Mirrors server/src/handoff/emotion-from-tags.ts (extractInlineEmotion) — keep
 * the two in sync; that module is the tested source of truth.
 *
 * Idempotent: a re-run finds no brackets and no-ops.
 *
 * DRY RUN BY DEFAULT — prints planned changes and exits. Pass --apply to write
 * (a .bak is written first per file).
 *
 * Env:
 *   CACHE_DIR  analysis-cache directory (default: server/handoff/cache)
 *
 * Usage:
 *   node scripts/migrate-emotion-from-tags.mjs            # dry run
 *   node scripts/migrate-emotion-from-tags.mjs --apply    # write
 *   CACHE_DIR="C:/.../cache" node scripts/migrate-emotion-from-tags.mjs --apply
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CACHE_DIR
  ? resolve(process.env.CACHE_DIR)
  : resolve(__dirname, '..', 'server', 'handoff', 'cache');
const APPLY = process.argv.includes('--apply');

/* Mirror of server/src/parsers/audio-tags.ts:AUDIO_TAGS + the fs-25 mapping. */
const AUDIO_TAGS = ['emphatic', 'shouting', 'whispers', 'laughs', 'sighs', 'excited', 'hesitant'];
const EMOTION_FROM_TAG = {
  shouting: 'angry',
  whispers: 'whisper',
  excited: 'excited',
  emphatic: null,
  laughs: null,
  sighs: null,
  hesitant: null,
};
const ALL_TAGS_RE = new RegExp(`\\s*\\[(?:${AUDIO_TAGS.join('|')})\\]\\s*`, 'gi');
const TAG_TOKEN_RE = new RegExp(`\\[(${AUDIO_TAGS.join('|')})\\]`, 'gi');

function extractInlineEmotion(text, currentEmotion) {
  let emotion = currentEmotion;
  if (!emotion) {
    for (const m of text.matchAll(TAG_TOKEN_RE)) {
      const mapped = EMOTION_FROM_TAG[m[1].toLowerCase()];
      if (mapped) {
        emotion = mapped;
        break;
      }
    }
  }
  const cleaned = text.replace(ALL_TAGS_RE, ' ').replace(/\s+/g, ' ').trim();
  return { text: cleaned, emotion };
}

if (!existsSync(CACHE_DIR)) {
  console.log(`[migrate-emotion] cache dir not found: ${CACHE_DIR} — nothing to do.`);
  process.exit(0);
}

const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.bak'));
let totalChanged = 0;
let filesChanged = 0;

for (const file of files) {
  const path = join(CACHE_DIR, file);
  let cache;
  try {
    cache = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`[migrate-emotion] skip unreadable ${file}: ${e.message}`);
    continue;
  }
  if (!cache || typeof cache.chapters !== 'object' || cache.chapters === null) continue;

  let fileChanges = 0;
  for (const sentences of Object.values(cache.chapters)) {
    if (!Array.isArray(sentences)) continue;
    for (const s of sentences) {
      if (!s || typeof s.text !== 'string') continue;
      const { text, emotion } = extractInlineEmotion(s.text, s.emotion);
      if (text !== s.text || emotion !== s.emotion) {
        if (APPLY) {
          s.text = text;
          if (emotion) s.emotion = emotion;
        }
        fileChanges += 1;
      }
    }
  }

  if (fileChanges > 0) {
    filesChanged += 1;
    totalChanged += fileChanges;
    console.log(`[migrate-emotion] ${file}: ${fileChanges} sentence(s) ${APPLY ? 'migrated' : 'to migrate'}`);
    if (APPLY) {
      copyFileSync(path, `${path}.bak`);
      writeFileSync(path, JSON.stringify(cache, null, 2));
    }
  }
}

console.log(
  `[migrate-emotion] ${APPLY ? 'APPLIED' : 'DRY RUN'} — ${totalChanged} sentence(s) across ${filesChanged} file(s) in ${CACHE_DIR}.`,
);
if (!APPLY && totalChanged > 0) console.log('[migrate-emotion] re-run with --apply to write (a .bak is kept per file).');
