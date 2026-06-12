#!/usr/bin/env node
/* Deterministic re-attribution of an ALREADY-CAST character's tagged dialogue,
   without the analyzer/server. For a recovered speaker who is in cast.json but
   whose lines are still on `narrator` (the plan-182 half-repair state, when a
   re-analysis was interrupted before stage-2), this flips the narrator quote
   that sits immediately before each `"…," <Name> <speech-verb>` tag to that
   character's id — the same conservative heuristic as
   recover-missing-character.mjs (which refuses when the id already exists).

   Scope-limited to specified chapters + a name→id map so it can't touch
   unrelated attribution. Dry-run by default; --apply writes. Backs up
   manuscript-edits.json before writing.

   Usage (from repo root):
     node scripts/reattribute-tagged-dialogue.mjs <bookDir> \
       --in 19=lessom:Lessom --in 47=lessom:Lessom \
       --in 16=behnam:"Behnam Aria" --in 34=woltzer:Woltzer [--apply]

   Each --in is chapterId=id:Name. Name is what appears in the prose tag
   (matched case-insensitively at a word boundary); id is the cast.json id the
   line is flipped to. */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findDialogueReattributions } from './recover-missing-character.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const positional = argv.filter((a) => !a.startsWith('--'));
const bookDir = positional[0];
const targets = []; // { chapterId, id, name }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--in' && argv[i + 1]) {
    const m = argv[i + 1].match(/^(\d+)=([^:]+):(.+)$/);
    if (!m) {
      console.error(`bad --in "${argv[i + 1]}" (expected chapterId=id:Name)`);
      process.exit(2);
    }
    targets.push({ chapterId: Number(m[1]), id: m[2], name: m[3] });
  }
}
if (!bookDir || targets.length === 0) {
  console.error('usage: node scripts/reattribute-tagged-dialogue.mjs <bookDir> --in <chapterId=id:Name> [...] [--apply]');
  process.exit(2);
}

const editsPath = join(resolve(bookDir), '.audiobook', 'manuscript-edits.json');
const castPath = join(resolve(bookDir), '.audiobook', 'cast.json');
if (!existsSync(editsPath)) {
  console.error(`no manuscript-edits.json at ${editsPath}`);
  process.exit(1);
}
const edits = JSON.parse(readFileSync(editsPath, 'utf8'));
const cast = existsSync(castPath) ? JSON.parse(readFileSync(castPath, 'utf8')) : { characters: [] };
const sentences = edits.sentences ?? [];

function narratorCount(chapterId) {
  return sentences.filter((s) => s.chapterId === chapterId && s.characterId === 'narrator').length;
}

const flips = []; // { sentenceId, fromId, toId, text }
for (const t of targets) {
  if (!cast.characters?.some((c) => c.id === t.id)) {
    console.error(`⚠ cast.json has no character id "${t.id}" — flipping anyway (verify the id).`);
  }
  const inChapter = sentences.filter((s) => s.chapterId === t.chapterId);
  const found = findDialogueReattributions(inChapter, t.name);
  for (const r of found) {
    // Only flip a quote that is currently narrator (the broken state); a line
    // already attributed to the right speaker is left alone.
    const s = sentences.find((x) => x.id === r.dialogueSentenceId && x.chapterId === t.chapterId);
    if (!s || s.characterId !== 'narrator') continue;
    flips.push({ sentenceId: s.id, chapterId: t.chapterId, fromId: 'narrator', toId: t.id, text: s.text });
  }
}

console.log(`\n=== Deterministic re-attribution (${apply ? 'APPLY' : 'dry-run'}) ===`);
console.log(`book: ${bookDir}\n`);
const byChapter = {};
for (const f of flips) (byChapter[f.chapterId] = byChapter[f.chapterId] || []).push(f);
for (const t of targets) {
  const fs = byChapter[t.chapterId]?.filter((f) => f.toId === t.id) ?? [];
  console.log(`ch${t.chapterId} → ${t.id}: ${fs.length} narrator line(s) to flip (narrator now ${narratorCount(t.chapterId)})`);
  for (const f of fs.slice(0, 6)) console.log(`    #${f.sentenceId}: ${f.text.slice(0, 80)}`);
  if (fs.length > 6) console.log(`    … +${fs.length - 6} more`);
}
console.log(`\nTotal flips: ${flips.length}`);

if (!apply) {
  console.log('\n[dry-run] nothing written. Re-run with --apply to flip + back up manuscript-edits.json.');
  process.exit(0);
}

// Backup, flip, write atomically, recount.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${editsPath}.before-reattrib-${stamp}.json`;
writeFileSync(backup, readFileSync(editsPath, 'utf8'), 'utf8');
console.log(`\n[backup] ${backup}`);

const flipById = new Map(flips.map((f) => [`${f.chapterId}:${f.sentenceId}`, f.toId]));
let n = 0;
for (const s of sentences) {
  const to = flipById.get(`${s.chapterId}:${s.id}`);
  if (to && s.characterId === 'narrator') {
    s.characterId = to;
    n++;
  }
}
const tmp = `${editsPath}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(edits, null, 2), 'utf8');
renameSync(tmp, editsPath);
console.log(`[wrote] ${editsPath} (${n} sentence(s) re-attributed)`);
for (const t of targets) {
  const lines = sentences.filter((s) => s.chapterId === t.chapterId && s.characterId === t.id).length;
  console.log(`  ch${t.chapterId} ${t.id}: now ${lines} line(s); narrator now ${narratorCount(t.chapterId)}`);
}
console.log('\nNext: regenerate the affected chapters so the new attribution is voiced.');
