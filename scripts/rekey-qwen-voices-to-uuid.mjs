/* srv-44 — re-key a book's bespoke Qwen voices from legacy name-keyed storage
   (`qwen-<name>.pt`) to srv-43's uuid-keyed storage (`qwen-<uuid>.pt`), with NO
   GPU / no re-design. A `.pt` is just the cached speaker embedding; it is loaded
   by filename, so re-keying is a pure file-rename + JSON-edit. Use this to fix a
   legacy book (e.g. the canonical library book, or the committed fs-22 demo
   bundle) so its designed voices are collision-free, then ship it with
   `capture-sample-book.mjs`.

   Usage: node scripts/rekey-qwen-voices-to-uuid.mjs "<bookDir>" [voicesDir]
     <bookDir>   — a book root containing `.audiobook/cast.json`.
     [voicesDir] — the qwen voices dir. Defaults to `<bookDir>/voices/qwen`
                   (self-contained bundle). For a workspace book pass the shared
                   `<workspaceRoot>/voices/qwen`.
     --dry-run   — print the plan, change nothing.

   For each DISTINCT designed qwen voice (shared voices map to ONE uuid), it
   mints a uuid, renames `qwen-<name>.{pt,json}` + every `__<emotion>` variant to
   `qwen-<uuid>.*`, rewrites `cast.json` (voiceUuid + qwen.name + variant names),
   and updates each descriptor's `voiceId` + adds the inert `voiceUuid`.
   Idempotent: a character that already has a `voiceUuid` is skipped. */
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [bookDir, voicesDirArg] = args.filter((a) => !a.startsWith('--'));
if (!bookDir) {
  console.error('Usage: node scripts/rekey-qwen-voices-to-uuid.mjs "<bookDir>" [voicesDir] [--dry-run]');
  process.exit(1);
}
const voicesDir = voicesDirArg || join(bookDir, 'voices', 'qwen');
const castPath = join(bookDir, '.audiobook', 'cast.json');
if (!existsSync(castPath)) {
  console.error(`No cast.json at ${castPath}`);
  process.exit(1);
}

const cast = JSON.parse(readFileSync(castPath, 'utf8'));
const newUuid = () => randomUUID().replace(/-/g, '').slice(0, 21); // compact, filename-safe, nanoid-length

/* Map a legacy storage name (e.g. "qwen-wren") → minted uuid, shared across
   every character that references the same name (reuse keeps one .pt). */
const nameToUuid = new Map();
let skipped = 0;
for (const c of cast.characters ?? []) {
  const qwen = c.overrideTtsVoices?.qwen;
  if (!qwen?.name) continue;
  if (c.voiceUuid) {
    skipped++;
    continue;
  } // already re-keyed
  if (!nameToUuid.has(qwen.name)) nameToUuid.set(qwen.name, newUuid());
}
if (nameToUuid.size === 0) {
  console.log(`Nothing to re-key (${skipped} character(s) already have a voiceUuid).`);
  process.exit(0);
}

/* Rename one on-disk voice file pair (base or variant) old→new. */
const renames = [];
const planRename = (oldKey, newKey) => {
  for (const ext of ['pt', 'json']) {
    const from = join(voicesDir, `${oldKey}.${ext}`);
    const to = join(voicesDir, `${newKey}.${ext}`);
    if (existsSync(from)) renames.push({ from, to, ext, newKey });
  }
};

/* Discover variant emotion suffixes present on disk for a base (e.g. __angry). */
const variantSuffixes = (baseKey) => {
  if (!existsSync(voicesDir)) return [];
  return [
    ...new Set(
      readdirSync(voicesDir)
        .map((f) => f.match(new RegExp(`^${baseKey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(__[^.]+)\\.(pt|json)$`)))
        .filter(Boolean)
        .map((m) => m[1]),
    ),
  ];
};

for (const [oldName, uuid] of nameToUuid) {
  const newName = `qwen-${uuid}`;
  planRename(oldName, newName);
  for (const suffix of variantSuffixes(oldName)) planRename(`${oldName}${suffix}`, `${newName}${suffix}`);
}

console.log(`Re-keying ${nameToUuid.size} voice(s) in ${voicesDir}${dryRun ? ' (dry-run)' : ''}:`);
for (const [oldName, uuid] of nameToUuid) console.log(`  ${oldName} → qwen-${uuid}`);
console.log(`Files to rename: ${renames.length}; cast characters skipped (already keyed): ${skipped}`);

if (dryRun) process.exit(0);

/* 1. Rename files + patch each descriptor's voiceId + add inert voiceUuid. */
for (const { from, to, ext, newKey } of renames) {
  renameSync(from, to);
  if (ext === 'json') {
    const d = JSON.parse(readFileSync(to, 'utf8'));
    const uuid = newKey.replace(/^qwen-/, '').split('__')[0];
    d.voiceId = newKey; // storage key
    d.voiceUuid = uuid; // inert, srv-43 acceptance
    writeFileSync(to, JSON.stringify(d, null, 2));
  }
}

/* 2. Rewrite cast.json: voiceUuid + qwen.name + variant names. */
for (const c of cast.characters ?? []) {
  const qwen = c.overrideTtsVoices?.qwen;
  if (!qwen?.name || c.voiceUuid) continue;
  const uuid = nameToUuid.get(qwen.name);
  if (!uuid) continue;
  c.voiceUuid = uuid;
  qwen.name = `qwen-${uuid}`;
  if (qwen.variants) {
    for (const [emotion, v] of Object.entries(qwen.variants)) {
      if (v?.name) v.name = `qwen-${uuid}__${emotion}`;
    }
  }
}
writeFileSync(castPath, JSON.stringify(cast, null, 2));

console.log(`Done. Re-keyed ${nameToUuid.size} voice(s); rewrote ${castPath}.`);
