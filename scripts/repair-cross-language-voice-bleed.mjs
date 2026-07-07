#!/usr/bin/env node
/* Maintenance tool — clear cross-language Qwen voice contamination (fs-61,
 * #1422, one-time / dev-only).
 *
 * Before applyOverrideToCastFiles was book-scoped for standalones (#1422),
 * designing ANY character's voice in ANY standalone book silently
 * overwrote every other confirmed book's character sharing the same bare
 * id (voiceId ?? id) — workspace-wide, no author/series/language check.
 * The per-language Coalfall demo books (fs-61: en/es/fr/de/ru) deliberately
 * reuse the English book's character ids, so this blasted whichever
 * language's design ran LAST onto every other language's same-id character.
 * A Qwen voice bakes its design language into its on-disk manifest/.pt, so
 * a contaminated character's override plays back in the wrong language.
 *
 * This script is a DATA scan, not an API client — it reads/writes cast.json
 * directly against the on-disk workspace (no server dependency). For every
 * confirmed book, for every character carrying a designed Qwen voice
 * (`overrideTtsVoices.qwen.name`), it resolves that voice's sidecar
 * manifest (`voices/qwen/<name>.json`) and compares the manifest's baked
 * `language` word (e.g. "Spanish") against the book's own language. A
 * mismatch — or a missing manifest — means the character's voice
 * originated in a DIFFERENT book; the override/voiceState/ttsModelKey are
 * cleared so the character reads "Needs voice" and can be redesigned
 * in-app. `voiceUuid` is deliberately left untouched — it's minted
 * book-locally (ensureCharacterVoiceUuid was already book-scoped even
 * before this fix) and is safe to keep as the identity slot the next
 * real design will fill.
 *
 * Usage:
 *   node scripts/repair-cross-language-voice-bleed.mjs           # dry run
 *   node scripts/repair-cross-language-voice-bleed.mjs --apply   # writes cast.json
 * Env: WORKSPACE_DIR (default C:\AudiobookWorkspace on Windows dev boxes).
 * No server dependency — safe to run whether or not the app is running,
 * though avoid running it while a design job is actively writing the SAME
 * book's cast.json.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'C:\\AudiobookWorkspace';
const BOOKS_ROOT = join(WORKSPACE_DIR, 'books');
const QWEN_VOICES_DIR = join(WORKSPACE_DIR, 'voices', 'qwen');

/* Mirrors server/src/tts/language-registry.ts's sidecarName column. */
const LANGUAGE_WORD_BY_CODE = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

async function listDirs(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function findConfirmedBooks() {
  const books = [];
  for (const author of await listDirs(BOOKS_ROOT)) {
    for (const series of await listDirs(join(BOOKS_ROOT, author))) {
      for (const title of await listDirs(join(BOOKS_ROOT, author, series))) {
        const bookDir = join(BOOKS_ROOT, author, series, title);
        const state = await readJson(join(bookDir, '.audiobook', 'state.json'));
        if (!state || !state.castConfirmed) continue;
        books.push({ bookDir, author, series, title, state });
      }
    }
  }
  return books;
}

let totalCleared = 0;
let totalCharsChecked = 0;
const manifestCache = new Map();

async function manifestLanguage(voiceName) {
  if (manifestCache.has(voiceName)) return manifestCache.get(voiceName);
  const path = join(QWEN_VOICES_DIR, `${voiceName}.json`);
  const manifest = await readJson(path);
  const language = manifest?.language ?? null;
  manifestCache.set(voiceName, language);
  return language;
}

const books = await findConfirmedBooks();
console.log(`Scanning ${books.length} confirmed book(s) under ${BOOKS_ROOT}\n`);

for (const { bookDir, author, series, title, state } of books) {
  const primaryLang = (state.language || 'en').split('-')[0].toLowerCase();
  const expectedWord = LANGUAGE_WORD_BY_CODE[primaryLang];
  if (!expectedWord) {
    console.warn(`  [skip] ${title}: unrecognised language code "${state.language}"`);
    continue;
  }

  const castPath = join(bookDir, '.audiobook', 'cast.json');
  const cast = await readJson(castPath);
  if (!cast?.characters?.length) continue;

  const clears = [];
  const next = [];
  for (const c of cast.characters) {
    const name = c.overrideTtsVoices?.qwen?.name;
    if (!name) {
      next.push(c);
      continue;
    }
    totalCharsChecked += 1;
    const manifestLang = await manifestLanguage(name);
    if (manifestLang === expectedWord) {
      next.push(c);
      continue;
    }
    clears.push({
      id: c.id,
      name: c.name ?? c.id,
      voiceName: name,
      manifestLang: manifestLang ?? '(missing manifest)',
    });
    /* Scope the clear to the contaminated qwen slot only — overrideTtsVoices
       is a per-engine map (srv-18), so a character with a legitimate,
       correctly-in-language Kokoro/Coqui/Gemini override alongside the bad
       qwen one must keep it. voiceState/ttsModelKey are only reset when
       qwen is (or defaults to being) the ACTIVE engine — otherwise a
       character actively using another engine would have its real,
       unrelated state wiped by a stale qwen leftover. */
    const out = { ...c };
    const engines = { ...(c.overrideTtsVoices ?? {}) };
    delete engines.qwen;
    if (Object.keys(engines).length > 0) out.overrideTtsVoices = engines;
    else delete out.overrideTtsVoices;
    if (!c.ttsEngine || c.ttsEngine === 'qwen') {
      delete out.voiceState;
      delete out.ttsModelKey;
    }
    next.push(out);
  }

  if (clears.length === 0) continue;

  console.log(`=== ${author} / ${series} / ${title} (${state.language}, expects ${expectedWord}) ===`);
  for (const cl of clears) {
    console.log(
      `  CLEAR ${cl.name} (${cl.id}) — voice "${cl.voiceName}" is ${cl.manifestLang}, not ${expectedWord}`,
    );
  }
  totalCleared += clears.length;

  if (APPLY) {
    await writeFile(castPath, JSON.stringify({ ...cast, characters: next }, null, 2));
    console.log(`  [apply] wrote ${castPath}`);
  }
  console.log('');
}

console.log(
  `Checked ${totalCharsChecked} designed character(s) across ${books.length} book(s). ` +
    `${totalCleared} contaminated ${APPLY ? 'cleared' : 'to clear'}.`,
);
console.log(APPLY ? 'APPLIED.' : 'DRY RUN (no writes). Re-run with --apply to write.');
