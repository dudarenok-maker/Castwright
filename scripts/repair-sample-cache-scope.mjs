#!/usr/bin/env node
/* Maintenance tool — voice-sample cache scope migration (one-time / dev-only).
 *
 * The voice-sample cache filename is `<scope>-<modelKey>-<hash>.<ext>`, where
 * `scope = sampleScopeFor(character) = character.voiceId ?? char-<id>` and
 * `hash` is derived from (text, voiceName). Two changes can move a character's
 * scope without changing the audio:
 *   1. The `sampleScopeFor` fix (stop keying on the timing-dependent library
 *      `voice?.id`) → a voiceId-less character moves `<id>` → `char-<id>`.
 *   2. The series-reuse backfill (`repair-series-reuse.mjs`) unifies `voiceId`
 *      → a relinked character moves `char-<id>` / `<id>` → `<voiceId>`.
 * After either, the player computes the NEW scope and misses the audition that
 * was cached under the OLD scope → an avoidable re-synthesis.
 *
 * This copies (never deletes) each cached file from its old scope to the
 * character's current `sampleScopeFor` scope, PRESERVING the `-<modelKey>-<hash>`
 * suffix. SAFETY: the hash encodes (text, voiceName), so a wrong copy simply
 * never gets hit (hash mismatch) — it can NEVER serve the wrong voice. Worst
 * case is a harmless orphan file.
 *
 * Usage:
 *   node scripts/repair-sample-cache-scope.mjs            # dry run (no writes)
 *   node scripts/repair-sample-cache-scope.mjs --apply    # copy files
 * Env: BASE (default http://localhost:8080), CACHE_DIR (default server/audio/voices).
 * Requires the dev server running (reads casts via GET /api/books/:id/state).
 */
import { readdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const CACHE_DIR = process.env.CACHE_DIR ?? resolve('server', 'audio', 'voices');
const APPLY = process.argv.includes('--apply');

/* Longest-first so e.g. `gemini-2.5-flash` is matched before a bare `gemini`. */
const MODEL_KEYS = [
  'qwen3-tts-0.6b',
  'coqui-xtts-v2',
  'kokoro-v1',
  'gemini-3.1-flash',
  'gemini-2.5-flash',
  'piper-en-us-medium',
].sort((a, b) => b.length - a.length);

/** Split `<scope>-<modelKey>[-<hash>].<ext>` → { scope, suffix } (suffix keeps
 *  modelKey + hash + ext). Returns null for files that don't carry a known
 *  model key (and for `raw-*` base-voice samples, which aren't char-scoped). */
function parseFile(name) {
  if (name.startsWith('raw-')) return null;
  for (const mk of MODEL_KEYS) {
    const marker = `-${mk}`;
    const i = name.indexOf(marker);
    if (i > 0) return { scope: name.slice(0, i), suffix: name.slice(i + 1) };
  }
  return null;
}

const sampleScopeFor = (c) => c.voiceId ?? `char-${c.id}`;

const lib = await (await fetch(`${BASE}/api/library`)).json();
const bookIds = lib.authors.flatMap((a) => a.series.flatMap((s) => s.books.map((b) => b.bookId)));

/* scope → set of current scopes any character with that old-scope candidate
   now resolves to. */
const remap = new Map();
const addRemap = (from, to) => {
  if (from === to) return;
  if (!remap.has(from)) remap.set(from, new Set());
  remap.get(from).add(to);
};

for (const bookId of bookIds) {
  const st = await (await fetch(`${BASE}/api/books/${encodeURIComponent(bookId)}/state`)).json();
  for (const c of st.cast?.characters ?? []) {
    const now = sampleScopeFor(c);
    for (const cand of new Set([`char-${c.id}`, c.id, c.voiceId].filter(Boolean))) {
      addRemap(cand, now);
    }
  }
}

const files = existsSync(CACHE_DIR) ? readdirSync(CACHE_DIR) : [];
const planned = [];
for (const name of files) {
  const parsed = parseFile(name);
  if (!parsed) continue;
  const targets = remap.get(parsed.scope);
  if (!targets) continue;
  for (const ns of targets) {
    const target = `${ns}-${parsed.suffix}`;
    if (target === name) continue;
    if (existsSync(resolve(CACHE_DIR, target))) continue;
    if (planned.some((p) => p.target === target)) continue;
    planned.push({ from: name, target });
  }
}

console.log(`cache dir: ${CACHE_DIR}`);
console.log(`files scanned: ${files.length} | planned copies: ${planned.length}\n`);
for (const p of planned) console.log(`  ${p.from}  →  ${p.target}`);

if (APPLY) {
  for (const p of planned) copyFileSync(resolve(CACHE_DIR, p.from), resolve(CACHE_DIR, p.target));
  console.log(`\nCOPIED ${planned.length} file(s).`);
} else {
  console.log(`\nDRY RUN (no writes). Re-run with --apply to copy.`);
}
