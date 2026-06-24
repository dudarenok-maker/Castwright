/*
 * invalidate-stale-qwen-base-samples.mjs — ONE-TIME cleanup.
 *
 * The srv-43 uuid repair (scripts/repair-qwen-voice-uuid-keys.mjs, #1067)
 * re-keys a character's Qwen voice name from the legacy `qwen-<id>` to
 * `qwen-<voiceUuid>`. The voice-sample cache filename embeds that name in its
 * hash (`<scope>-<modelKey>-<djb2(text|voiceName)>.mp3`, see
 * server/src/tts/voice-sample-cache.ts), so after a re-key every BASE sample a
 * voice had rendered before the re-key is stranded at the old hash. The
 * "Sampled" badge prefix-matches the stale file (voices.ts hasCachedQwenSample)
 * so it still shows green, but "Play 12s" recomputes the new hash, misses, and
 * re-synthesises. This script deletes those stranded base samples so the badge
 * goes honest and the next Play re-renders under the correct key.
 *
 * It is deliberately NOT wired into the repair tool's re-runnable flow: it
 * cannot recompute the exact expected hash without replicating the server's
 * sample-text selection (buildSampleText), which the cache module warns must
 * never drift. So it over-deletes by scope (any base sample of a re-keyed
 * voice, stale or not) — the only cost is re-rendering a base sample that
 * happened to be current. Run it ONCE after a repair; re-running after a
 * legitimate re-render would delete the fresh sample again.
 *
 * Emotion VARIANT samples (`<scope>__<emotion>-…`) are PRESERVED — they are
 * re-minted by the design route under the new key and match correctly.
 *
 * Usage:
 *   node scripts/invalidate-stale-qwen-base-samples.mjs            # dry-run
 *   node scripts/invalidate-stale-qwen-base-samples.mjs --apply    # delete
 *   node scripts/invalidate-stale-qwen-base-samples.mjs --workspace=C:\AudiobookWorkspace
 *
 * Back up server/audio/voices/ before --apply. Stopping the server is not
 * required (samples re-render on demand), but the in-memory "Sampled" flag is
 * recomputed per query so a refresh reflects the deletion.
 */
import { readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dirname = dirname(fileURLToPath(import.meta.url));

/* Qwen sample model keys that name cache files. Only 0.6b is in use today; the
   1.7b quality tier is listed defensively (a no-op when absent). */
const QWEN_SAMPLE_MODEL_KEYS = ['qwen3-tts-0.6b', 'qwen3-tts-1.7b'];

/* A row is "re-keyed" (uuid-storage) when its persisted Qwen name is exactly
   `qwen-<voiceUuid>` — i.e. the repair tool has already moved it off the legacy
   name-derived key. Legacy rows (name still `qwen-<id>`) are left untouched:
   their base samples are still valid. */
export function isUuidKeyedQwenRow(character) {
  const uuid = character?.voiceUuid;
  const name = character?.overrideTtsVoices?.qwen?.name;
  return !!uuid && name === `qwen-${uuid}`;
}

/* Sample cache scope — must match src/lib/sample-scope.ts sampleScopeFor:
   the persisted voiceId, else the `char-<id>` namespace. */
export function sampleScopeForRow(character) {
  return character?.voiceId ?? `char-${character?.id}`;
}

/* Which cache files are stranded base samples of a re-keyed voice. A base
   sample for scope S is `S-<modelKey>-<hash>.mp3`; an emotion variant is
   `S__<emotion>-<modelKey>-<hash>.mp3`, so anchoring the prefix on
   `S-<modelKey>-` matches base only AND avoids scope-prefix collisions
   (e.g. `char-mr-` would otherwise swallow `char-mr-sweeney-…`). */
export function selectStaleBaseSampleFiles({ rows, fileNames, modelKeys = QWEN_SAMPLE_MODEL_KEYS }) {
  const prefixes = [];
  for (const row of rows ?? []) {
    if (!isUuidKeyedQwenRow(row)) continue;
    const scope = sampleScopeForRow(row);
    for (const mk of modelKeys) prefixes.push(`${scope}-${mk}-`);
  }
  const hit = new Set();
  for (const f of fileNames ?? []) {
    if (prefixes.some((p) => f.startsWith(p))) hit.add(f);
  }
  return [...hit];
}

/* --- I/O glue (not unit-tested; the selection logic above is) --- */

function resolveWorkspace() {
  const flag = process.argv.find((a) => a.startsWith('--workspace='));
  if (flag) return flag.slice('--workspace='.length);
  return process.env.WORKSPACE_DIR ?? 'C:\\AudiobookWorkspace';
}

/* Mirror server voiceSampleAudioDir(): env override, else server/audio/voices. */
function resolveSampleDir() {
  return process.env.VOICE_SAMPLE_AUDIO_DIR ?? resolve(__dirname, '..', 'server', 'audio', 'voices');
}

async function listCastJsons(booksRoot) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.upgrade-backups') continue;
        await walk(p);
      } else if (e.name === 'cast.json') {
        out.push(p);
      }
    }
  }
  await walk(booksRoot);
  return out;
}

function rowsFromCast(cast) {
  const chars = cast?.characters ?? cast?.cast ?? cast;
  return Array.isArray(chars) ? chars : Object.values(chars ?? {});
}

async function main() {
  const workspace = resolveWorkspace();
  const booksRoot = join(workspace, 'books');
  const sampleDir = resolveSampleDir();

  if (!existsSync(sampleDir)) {
    console.log(`Sample cache dir not found: ${sampleDir} — nothing to do.`);
    return;
  }

  const castPaths = await listCastJsons(booksRoot);
  const rows = [];
  for (const cp of castPaths) {
    try {
      rows.push(...rowsFromCast(JSON.parse(await readFile(cp, 'utf8'))));
    } catch {
      /* skip unreadable cast.json */
    }
  }
  const reKeyed = rows.filter(isUuidKeyedQwenRow);
  const fileNames = (await readdir(sampleDir)).filter((f) => f.endsWith('.mp3'));
  const stale = selectStaleBaseSampleFiles({ rows, fileNames });

  console.log(`Workspace:    ${workspace}`);
  console.log(`Sample dir:   ${sampleDir}`);
  console.log(`Cast rows:    ${rows.length} (${reKeyed.length} uuid-keyed Qwen)`);
  console.log(`Base samples to invalidate: ${stale.length}`);
  for (const f of stale.sort()) console.log(`  ${APPLY ? 'deleting' : 'would delete'}  ${f}`);

  if (!stale.length) {
    console.log('\nNothing stranded — done.');
    return;
  }
  if (!APPLY) {
    console.log(`\nDry-run. Back up ${sampleDir}, then re-run with --apply to delete.`);
    return;
  }
  for (const f of stale) await unlink(join(sampleDir, f));
  console.log(`\nDeleted ${stale.length} stranded base sample(s). They re-render on the next Play.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('invalidate-stale-qwen-base-samples.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
