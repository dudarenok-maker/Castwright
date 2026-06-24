#!/usr/bin/env node
/* Maintenance tool — re-key legacy Qwen voice files to the srv-43 voiceUuid
 * storage key (issue #1057). One-time / dev-only.
 *
 * Background: a bespoke Qwen voice is stored on disk as `<key>.pt` (+ `.json`,
 * + `<key>__<emotion>.*` variants) under `<workspace>/voices/qwen/`, where
 * `key = qwenStorageKey(character)`. srv-43 made that key prefer
 * `qwen-<voiceUuid>` over the legacy `qwen-<voiceId ?? id>`. A voice DESIGNED
 * before its uuid was minted lives at the legacy id-key; once a uuid is later
 * stamped onto the character (e.g. by a bulk "Design full cast" pass), every
 * resolver — `pickVoiceForEngine` and the variant-mint base anchor — flips to
 * `qwen-<uuid>`, but nothing renamed the `.pt`. Result: the base load fails →
 * silent Kokoro fallback on re-render, and "Design full cast → Emotion variants"
 * no-ops (the base anchor `qwen-<uuid>.pt` is absent).
 *
 * This tool finds every cast character whose `qwen-<uuid>.pt` is MISSING but
 * whose persisted base `.pt` EXISTS, and re-keys the files to `qwen-<uuid>`,
 * then rewrites the cast.json `overrideTtsVoices.qwen.name` (and variant slot
 * names) to match. A voice is shared series-wide (one `.pt`), so the file rename
 * happens once (idempotent) while each book's cast.json is rewritten as the walk
 * reaches it.
 *
 * REUSED voices (`matchedFrom` set) are SKIPPED and reported — their `.pt` is
 * owned by the source book; re-keying here would break the source's reference.
 * Re-run after the source book is migrated, or relink.
 *
 * Usage:
 *   node scripts/repair-qwen-voice-uuid-keys.mjs            # dry run (no writes)
 *   node scripts/repair-qwen-voice-uuid-keys.mjs --apply    # rename files + rewrite cast.json
 *   WORKSPACE_DIR=C:\AudiobookWorkspace node scripts/repair-qwen-voice-uuid-keys.mjs
 *   node scripts/repair-qwen-voice-uuid-keys.mjs --workspace=/path/to/workspace
 *
 * SAFETY: stop the server AND the TTS sidecar first (so no `.pt` is mid-read),
 * and back up `<workspace>/voices/qwen/` before `--apply`. Dry-run prints the
 * full plan; review it before applying.
 */
import { readdir, rename, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');

/* ── Pure helpers (unit-tested in scripts/tests/) ──────────────────────────── */

/** A file belongs to `key` iff it is the base (`<key>.pt`/`.json`) or an emotion
    variant (`<key>__<emotion>.<ext>`). The `__` / `.` boundary keeps `qwen-dad`
    from matching `qwen-dad-2`. Mirrors server/src/tts/qwen-voice-files.ts. */
export function belongsToKey(name, key) {
  return name === `${key}.pt` || name === `${key}.json` || name.startsWith(`${key}__`);
}

/** Plan the file renames for re-keying `oldKey` → `newKey` given the directory
    listing. Skips a file whose destination already exists (never clobbers). */
export function planRenames(entries, oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return [];
  const present = new Set(entries);
  const plan = [];
  for (const name of entries) {
    if (!belongsToKey(name, oldKey)) continue;
    const to = `${newKey}${name.slice(oldKey.length)}`;
    if (present.has(to)) continue;
    plan.push({ from: name, to });
  }
  return plan;
}

/** Classify a voice GROUP keyed by its persisted qwen `name` (the on-disk key
    every row of that voice points at). `uuids` is the array of DISTINCT
    non-empty voiceUuid values across the group's rows; `ptExists(key)` →
    whether `<key>.pt` is on disk.

    A bespoke voice is loaded at `qwenStorageKey` = `qwen-<voiceUuid>` (srv-43).
    So a group is healthy when its persisted name already IS the uuid key. When
    rows carry a uuid but the `.pt` still lives at the legacy `name` key, every
    row resolves to a missing `qwen-<uuid>.pt` — consolidate by re-keying the
    files to the uuid and rewriting the rows. Grouping by `name` (not per-row)
    is what lets this fix a voice whose every appearance is a reused link in a
    matchedFrom cycle (no clean origin row), as long as the rows AGREE on one
    uuid.

    - { action: 'skip' }                         no uuid anywhere → resolves to
                                                 the legacy key where the .pt is.
    - { action: 'noop' }                         name already the uuid key.
    - { action: 'consolidate', oldKey, newKey }  re-key legacy .pt → uuid key +
                                                 rewrite every row.
    - { action: 'flag', oldKey, newKey, reason } can't auto-fix (rows disagree
                                                 on uuid / no .pt / conflict). */
export function classifyVoiceGroup(name, uuids, ptExists) {
  if (uuids.length === 0) return { action: 'skip' };
  if (uuids.length > 1)
    return { action: 'flag', oldKey: name, newKey: null, reason: `rows disagree on uuid (${uuids.join(', ')}) — relink` };
  const newKey = `qwen-${uuids[0]}`;
  if (name === newKey) return { action: 'noop' };
  if (ptExists(newKey))
    return { action: 'flag', oldKey: name, newKey, reason: `both "${name}.pt" and "${newKey}.pt" exist — resolve by hand` };
  if (ptExists(name)) return { action: 'consolidate', oldKey: name, newKey };
  return { action: 'flag', oldKey: name, newKey, reason: `no .pt at "${name}" or "${newKey}" — (re)design this voice` };
}

/** Rewrite a character's qwen base name + variant slot names from oldKey to
    newKey (pure; returns a new character). */
export function rekeyCharacterNames(character, oldKey, newKey) {
  const q = character.overrideTtsVoices.qwen;
  const variants = q.variants
    ? Object.fromEntries(
        Object.entries(q.variants).map(([emotion, slot]) => [
          emotion,
          { ...slot, name: `${newKey}__${emotion}` },
        ]),
      )
    : q.variants;
  return {
    ...character,
    overrideTtsVoices: {
      ...character.overrideTtsVoices,
      qwen: { ...q, name: newKey, ...(variants ? { variants } : {}) },
    },
  };
}

/* ── Script body ───────────────────────────────────────────────────────────── */

function resolveWorkspace() {
  const flag = process.argv.find((a) => a.startsWith('--workspace='));
  if (flag) return flag.slice('--workspace='.length);
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR;
  console.error(
    'Set the workspace: WORKSPACE_DIR=<path> or --workspace=<path> (the dir that contains books/ and voices/).',
  );
  process.exit(2);
}

async function listCastJsons(booksRoot) {
  const out = [];
  const dirs = async (p) => {
    try {
      return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {
      return [];
    }
  };
  for (const author of await dirs(booksRoot))
    for (const series of await dirs(join(booksRoot, author.name)))
      for (const title of await dirs(join(booksRoot, author.name, series.name))) {
        const p = join(booksRoot, author.name, series.name, title.name, '.audiobook', 'cast.json');
        if (existsSync(p)) out.push({ path: p, label: `${author.name}/${series.name}/${title.name}` });
      }
  return out;
}

async function main() {
  const workspace = resolveWorkspace();
  const voicesDir = join(workspace, 'voices', 'qwen');
  const booksRoot = join(workspace, 'books');
  console.log(`Workspace: ${workspace}`);
  console.log(`Mode:      ${APPLY ? 'APPLY (will rename files + rewrite cast.json)' : 'DRY RUN (no writes)'}`);
  if (!existsSync(voicesDir)) {
    console.error(`No voices dir at ${voicesDir} — nothing to do.`);
    process.exit(0);
  }

  const voiceFiles = (await readdir(voicesDir, { withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => d.name);
  const ptSet = new Set(voiceFiles.filter((n) => n.endsWith('.pt')).map((n) => n.slice(0, -3)));
  const ptExists = (key) => ptSet.has(key);

  const casts = await listCastJsons(booksRoot);

  // ── Pass 1: parse every cast; build voice GROUPS keyed by persisted qwen.name.
  // A voice is shared across books, so its rows span casts; each group collects
  // its distinct uuids and the (book, char) coordinates of its rows.
  const parsed = []; // index-aligned with `casts`; null for an unparseable cast
  const groups = new Map(); // name -> { uuids:Set, rows:[{ bookIdx, charIdx }] }
  for (let b = 0; b < casts.length; b++) {
    let cast;
    try {
      cast = JSON.parse(await readFile(casts[b].path, 'utf8'));
    } catch {
      parsed.push(null);
      continue;
    }
    parsed.push({ path: casts[b].path, label: casts[b].label, cast });
    const chars = cast.characters ?? [];
    for (let i = 0; i < chars.length; i++) {
      const nm = chars[i]?.overrideTtsVoices?.qwen?.name;
      if (!nm) continue;
      let g = groups.get(nm);
      if (!g) groups.set(nm, (g = { uuids: new Set(), rows: [] }));
      if (chars[i].voiceUuid) g.uuids.add(chars[i].voiceUuid);
      g.rows.push({ bookIdx: b, charIdx: i });
    }
  }

  // Classify every group → consolidations (auto-fix) + flags (manual).
  const consolidations = [];
  const flags = [];
  for (const [name, g] of groups) {
    const c = classifyVoiceGroup(name, [...g.uuids], ptExists);
    if (c.action === 'consolidate') consolidations.push({ ...c, uuid: [...g.uuids][0], rows: g.rows });
    else if (c.action === 'flag') flags.push({ name, ...c });
  }

  // ── Pass 2: apply. Re-key each voice's files once, then rewrite the name +
  // stamp the shared uuid on every row of the group.
  const dirtyBooks = new Set();
  let rowCount = 0;
  for (const { oldKey, newKey, uuid, rows } of consolidations) {
    for (const { from, to } of planRenames(voiceFiles, oldKey, newKey)) {
      console.log(`  rename  ${from}  →  ${to}`);
      if (APPLY) await rename(join(voicesDir, from), join(voicesDir, to));
      const idx = voiceFiles.indexOf(from);
      if (idx !== -1) voiceFiles[idx] = to;
    }
    for (const { bookIdx, charIdx } of rows) {
      const entry = parsed[bookIdx];
      if (!entry) continue;
      let ch = rekeyCharacterNames(entry.cast.characters[charIdx], oldKey, newKey);
      if (ch.voiceUuid !== uuid) ch = { ...ch, voiceUuid: uuid }; // stamp the shared identity on any row lacking it
      entry.cast.characters[charIdx] = ch;
      dirtyBooks.add(bookIdx);
      rowCount++;
      console.log(`  cast    ${entry.label}: ${ch.id}  ${oldKey} → ${newKey}`);
    }
  }
  if (APPLY)
    for (const b of dirtyBooks)
      await writeFile(parsed[b].path, JSON.stringify(parsed[b].cast, null, 2) + '\n');

  console.log(
    `\n${APPLY ? 'Consolidated' : 'Would consolidate'}: ${consolidations.length} voice(s) re-keyed on disk; ${rowCount} cast row(s) rewritten.`,
  );
  if (flags.length) {
    console.log(`\nNeeds manual attention (not auto-fixed):`);
    for (const f of flags) console.log(`  ${f.name}${f.newKey ? ` → ${f.newKey}` : ''}\n      ↳ ${f.reason}`);
  }
  if (!APPLY && (consolidations.length || flags.length))
    console.log(`\nReview the plan above, back up ${voicesDir}, stop the server, then re-run with --apply.`);
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('repair-qwen-voice-uuid-keys.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
