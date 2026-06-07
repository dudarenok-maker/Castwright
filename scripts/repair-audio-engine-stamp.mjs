#!/usr/bin/env node
/*
 * repair-audio-engine-stamp.mjs
 *
 * One-time data repair for the false engine-drift badge (2026-06-07).
 *
 * Symptom: a chapter shows "⚠ Generated with Kokoro v1 · current engine is
 * Qwen" even though its audio actually rendered on Qwen. Plan 35 (chapter-wide
 * engine-drift detection) predated plan 108 (per-character engine routing):
 * finalize-chapter-write stamped `state.json.audioModelKey` with the generation
 * request's DEFAULT engine, not the engine the audio actually rendered in. A
 * narration-only chapter whose narrator carries `ttsEngine: 'qwen'`, regenerated
 * while the project default was Kokoro, rendered 100% on Qwen but stamped
 * `kokoro-v1` → a false drift badge once the project engine was set to Qwen.
 *
 * The truth lives in `audio/<slug>.segments.json` -> `characterSnapshots`, where
 * each speaking character's ACTUAL engine is recorded (`renderedFallbackEngine`
 * ?? `voiceEngine`). This script recomputes the per-engine voice-count breakdown
 * from those snapshots and, when the chapter is UNIFORM on a single engine whose
 * canonical key disagrees with the stamped `audioModelKey`, corrects the stamp.
 * It also backfills the new `audioEngines` field on every rendered chapter (so
 * mixed-engine chapters gain the "Kokoro (1), Qwen (6)" caption data).
 *
 * It NEVER rewrites the audio — only the metadata stamp that already disagrees
 * with the rendered audio. Mixed-engine chapters keep their `audioModelKey`
 * (a single key can't represent them); only `audioEngines` is added.
 *
 * DRY RUN BY DEFAULT — prints the planned writes and exits without touching
 * disk. Pass --apply to write each changed state.json (a .bak is written first).
 *
 * Env:
 *   BASE                 workspace root (overrides everything)
 *   AUDIOBOOK_WORKSPACE  workspace root (same default the server uses)
 *   default              <home>/AudiobookWorkspace
 *
 * Usage:
 *   node scripts/repair-audio-engine-stamp.mjs            # dry run
 *   node scripts/repair-audio-engine-stamp.mjs --apply    # write
 *   BASE="C:/AudiobookWorkspace" node scripts/repair-audio-engine-stamp.mjs --apply
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

/* Canonical engine -> model key. Mirrors server canonicalModelKeyForEngine.
   Gemini variants can't be recovered from a snapshot, so a uniform-Gemini
   chapter keeps its existing stamp (left untouched below). */
const CANONICAL = {
  kokoro: 'kokoro-v1',
  qwen: 'qwen3-tts-0.6b',
  coqui: 'coqui-xtts-v2',
  piper: 'piper-en-us-medium',
};

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/* Recursively collect every `<dir>/.audiobook/` that holds a state.json. */
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
        if (fs.existsSync(path.join(child, 'state.json'))) found.push(child);
        continue; // never descend into .audiobook
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

/* Distinct speaking characters per engine they ACTUALLY rendered in. Mirrors
   server engineBreakdownFromSnapshots. */
function engineBreakdownFromSnapshots(snapshots) {
  const breakdown = {};
  for (const snap of Object.values(snapshots ?? {})) {
    const engine = snap?.renderedFallbackEngine ?? snap?.voiceEngine;
    if (!engine) continue;
    breakdown[engine] = (breakdown[engine] ?? 0) + 1;
  }
  return breakdown;
}

const sameBreakdown = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

function main() {
  if (!fs.existsSync(BOOKS_ROOT)) {
    console.error(`No books root at ${BOOKS_ROOT}. Set BASE to your workspace.`);
    process.exit(1);
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — workspace: ${BASE}\n`);

  let booksChanged = 0;
  let stampsFixed = 0;
  let breakdownsAdded = 0;

  for (const ab of findAudiobookDirs(BOOKS_ROOT)) {
    const statePath = path.join(ab, 'state.json');
    const state = readJson(statePath);
    if (!state || !Array.isArray(state.chapters)) continue;
    const audioDir = path.join(path.dirname(ab), 'audio');
    const bookLabel = path.relative(BOOKS_ROOT, path.dirname(ab));

    let bookChanged = false;
    for (const ch of state.chapters) {
      if (!ch?.slug) continue;
      const segPath = path.join(audioDir, `${ch.slug}.segments.json`);
      const seg = readJson(segPath);
      if (!seg?.characterSnapshots) continue;
      const breakdown = engineBreakdownFromSnapshots(seg.characterSnapshots);
      const engines = Object.keys(breakdown);
      if (engines.length === 0) continue;

      const changes = [];

      // 1) Correct a wrong uniform-engine stamp.
      if (engines.length === 1) {
        const canonical = CANONICAL[engines[0]];
        if (canonical && ch.audioModelKey && ch.audioModelKey !== canonical) {
          changes.push(`audioModelKey ${ch.audioModelKey} → ${canonical}`);
          if (APPLY) ch.audioModelKey = canonical;
          stampsFixed += 1;
        }
      }

      // 2) Add / refresh the per-engine breakdown.
      if (!sameBreakdown(ch.audioEngines, breakdown)) {
        changes.push(`audioEngines ${JSON.stringify(ch.audioEngines ?? {})} → ${JSON.stringify(breakdown)}`);
        if (APPLY) ch.audioEngines = breakdown;
        breakdownsAdded += 1;
      }

      if (changes.length) {
        console.log(`  [${bookLabel}] ch${ch.id} ${ch.slug}: ${changes.join('; ')}`);
        bookChanged = true;
      }
    }

    if (bookChanged) {
      booksChanged += 1;
      if (APPLY) {
        fs.copyFileSync(statePath, `${statePath}.bak-engine-stamp-${Date.now()}`);
        fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }
    }
  }

  console.log(
    `\n${APPLY ? 'Wrote' : 'Would write'} ${booksChanged} book(s): ` +
      `${stampsFixed} stamp(s) corrected, ${breakdownsAdded} breakdown(s) set.`,
  );
  if (!APPLY && booksChanged > 0) console.log('Re-run with --apply to write.');
}

main();
