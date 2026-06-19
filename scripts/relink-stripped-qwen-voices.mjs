#!/usr/bin/env node
// SUPERSEDED by srv-43 (voiceUuid-keyed storage, plan 226): this script correlates
// characters to voices/qwen/qwen-<voiceId>.pt by legacy name; uuid-keyed files
// (qwen-<uuid>.pt) will be treated as "no embedding on disk". Needs a uuid-aware
// update before rerun on a post-srv-43 workspace.
/* Re-link cast characters to their on-disk designed Qwen voices after a
   re-analysis stripped the per-character `overrideTtsVoices.qwen` pointer.

   Root cause (2026-06-05): navigating to the `…/analysing` URL re-ran the
   analysis/rebaseline pass, which rewrote cast.json and dropped the designed-
   voice override on generated/reused characters — so they display "No voice
   designed yet" even though their voice embeddings (`voices/qwen/qwen-<id>.pt`)
   are intact. This re-points each affected character back at its existing voice;
   it never re-designs or touches the voice files.

   A character is re-linked only when ALL hold (conservative — never invents a
   voice):
     - its deterministic voice `qwen-<id>.pt` exists in `<workspace>/voices/qwen/`,
     - it has no `overrideTtsVoices.qwen.name` already,
     - its `voiceState` is `generated` or `reused` (it was meant to have a voice).

   Dry-run by default; pass `--apply` to write (backs up cast.json first).

   Usage (from repo root):
     node scripts/relink-stripped-qwen-voices.mjs                 # dry-run, all books
     node scripts/relink-stripped-qwen-voices.mjs --book The Drowning Bell
     node scripts/relink-stripped-qwen-voices.mjs --apply --book The Drowning Bell

   Env: WORKSPACE_DIR (default ../audiobook-workspace, then $WORKSPACE_DIR). */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR || join(repoRoot, '..', 'audiobook-workspace'));
const APPLY = process.argv.includes('--apply');
const bookFilterIdx = process.argv.indexOf('--book');
const bookFilter = bookFilterIdx >= 0 ? process.argv[bookFilterIdx + 1] : null;

const VOICES_QWEN = join(WORKSPACE_DIR, 'voices', 'qwen');
const designed = existsSync(VOICES_QWEN)
  ? new Set(readdirSync(VOICES_QWEN).filter((f) => f.endsWith('.pt')).map((f) => f.replace(/\.pt$/, '')))
  : new Set();

function findCastFiles(root) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.backups') continue;
        walk(p);
      } else if (e.name === 'cast.json' && p.replace(/\\/g, '/').includes('/.audiobook/')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

console.log(`Re-link stripped Qwen voices — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log('workspace:', WORKSPACE_DIR);
console.log('designed voices on disk:', designed.size, '\n');

let totalRelinked = 0;
for (const castPath of findCastFiles(join(WORKSPACE_DIR, 'books'))) {
  const bookDir = dirname(dirname(castPath));
  if (bookFilter && !bookDir.replace(/\\/g, '/').toLowerCase().includes(bookFilter.toLowerCase())) continue;
  let cast;
  try {
    cast = JSON.parse(readFileSync(castPath, 'utf8'));
  } catch {
    continue;
  }
  const chars = cast.characters ?? [];
  const relinked = [];
  for (const c of chars) {
    const want = `qwen-${c.id}`;
    const hasRef = c.overrideTtsVoices?.qwen?.name === want;
    const eligibleState = c.voiceState === 'generated' || c.voiceState === 'reused';
    if (designed.has(want) && !hasRef && eligibleState) {
      relinked.push({ id: c.id, name: c.name, state: c.voiceState, was: c.overrideTtsVoices?.qwen?.name ?? null });
      c.overrideTtsVoices = { ...(c.overrideTtsVoices ?? {}), qwen: { ...(c.overrideTtsVoices?.qwen ?? {}), name: want } };
    }
  }
  if (relinked.length) {
    const label = `${cast.title ?? bookDir.split(/[\\/]/).pop()}`;
    console.log(`📕 ${label} (${castPath.replace(/\\/g, '/')})`);
    relinked.forEach((r) => console.log(`   ${APPLY ? '✔ re-linked' : '→ would re-link'} ${r.id} "${r.name}" (${r.state}) → qwen-${r.id}`));
    totalRelinked += relinked.length;
    if (APPLY) {
      const bak = `${castPath}.bak-relink-${Date.now()}`;
      copyFileSync(castPath, bak);
      writeFileSync(castPath, JSON.stringify(cast, null, 2));
      console.log(`   (backup: ${bak.split(/[\\/]/).pop()})`);
    }
    console.log();
  }
}

console.log('─'.repeat(50));
console.log(`${APPLY ? 'Re-linked' : 'Would re-link'} ${totalRelinked} character(s).`);
if (!APPLY && totalRelinked > 0) {
  console.log('\nRun with --apply to write (cast.json is backed up first).');
  console.log('IMPORTANT: stop the app first, or restart it after, so the edit is not overwritten.');
}
