/* #4040 (owner decision 2026-11-08) — an emotion variant is designed against one
   base embedding, and a base redesign replaces that embedding for every book on
   the key. Instead of rewriting the other books' cast.json (the eager reset, which
   a client's next whole-roster PUT or a reparse carryover undid), each variant
   records which base it was made from and is ignored once the base moves on:

   - a base REDESIGN (a design or a promote that replaces an existing base `.pt`)
     writes a fresh `rev` into the base's sidecar json (`qwen-<key>.json`);
   - a variant design records the base's `rev`, read when its render began, as
     `baseRev` in its own json (`qwen-<key>__<emotion>.json`);
   - a variant is CURRENT iff `baseRev === rev`, absent counting as `undefined` on
     both sides: a legacy variant stays valid until its base is first redesigned.

   A stale variant is treated as not designed: the render falls back to the base
   voice, the cast GET omits it, a cast write drops it (so a client cannot restore
   it), the reparse carryover drops it, and the startup variant sweep no longer
   counts a row's stale slot as naming the file (sweepOrphanVariantFiles deletes
   it). Copies of a voice family (the #3992 / #4037 mints) copy the json, so both
   fields travel with the files. Nothing here writes a cast.json.

   A json that cannot be read for a reason other than absence (EBUSY, a torn
   write) decides nothing: the variant is kept, so a transient error never drops a
   take. */

import { nanoid } from 'nanoid';
import { qwenVoiceSidecarPath } from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';

const UNKNOWN = Symbol('unknown');
type Rev = string | undefined | typeof UNKNOWN;

async function readRevField(key: string, field: 'rev' | 'baseRev'): Promise<Rev> {
  try {
    const json = await readJson<Record<string, unknown>>(qwenVoiceSidecarPath(key));
    const v = json?.[field];
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return UNKNOWN;
  }
}

/** The base's current `rev` (undefined when absent or unreadable), for a variant
    design to record when its render begins. */
export async function readBaseRev(baseKey: string): Promise<string | undefined> {
  const rev = await readRevField(baseKey, 'rev');
  return rev === UNKNOWN ? undefined : rev;
}

async function patchJson(key: string, patch: (json: Record<string, unknown>) => void): Promise<void> {
  const path = qwenVoiceSidecarPath(key);
  const json = (await readJson<Record<string, unknown>>(path)) ?? {};
  patch(json);
  await writeJsonAtomic(path, json);
}

/** A base redesign landed at `baseKey`: give it a fresh `rev`, so every variant
    recorded against an earlier one (or none) is stale. */
export async function stampBaseRedesign(baseKey: string): Promise<void> {
  await patchJson(baseKey, (json) => {
    json.rev = nanoid();
  });
}

/** A variant design landed at `variantKey`: record the base `rev` it was rendered
    against (absent when the base had none). */
export async function stampVariantBaseRev(variantKey: string, baseRev: string | undefined): Promise<void> {
  await patchJson(variantKey, (json) => {
    if (baseRev === undefined) delete json.baseRev;
    else json.baseRev = baseRev;
  });
}

interface VariantRow {
  id?: string;
  voiceId?: string | null;
  voiceUuid?: string | null;
  overrideTtsVoices?: unknown;
}

/** The key the render derives a row's variants from (pickVoiceForEngine's qwen
    branch: a library slot's `qwen-<libraryUuid>`, else the row's storage key). */
export function qwenVariantBaseKey(row: VariantRow): string {
  const qwen = (row.overrideTtsVoices as { qwen?: { libraryUuid?: string } } | undefined)?.qwen;
  return qwen?.libraryUuid ? `qwen-${qwen.libraryUuid}` : qwenStorageKey(row, row.id ?? '');
}

/** Does any row carry a qwen variant slot at all? Synchronous, so a caller with
    none skips dropStaleVariants without yielding. */
export function anyQwenVariants(rows: readonly unknown[]): boolean {
  return rows.some((row) => {
    const variants = ((row as VariantRow)?.overrideTtsVoices as { qwen?: { variants?: object } } | undefined)?.qwen
      ?.variants;
    return !!variants && typeof variants === 'object' && Object.keys(variants).length > 0;
  });
}

/** `rows` with every stale variant slot removed (an emptied `variants` map is
    dropped, as the variant DELETE does). Rows with nothing stale are returned as
    the same objects; a changed row is a copy. Never throws. */
export async function dropStaleVariants<T>(rows: T[]): Promise<T[]> {
  const baseRevs = new Map<string, Promise<Rev>>();
  const baseRevOf = (key: string): Promise<Rev> => {
    let rev = baseRevs.get(key);
    if (!rev) baseRevs.set(key, (rev = readRevField(key, 'rev')));
    return rev;
  };
  return Promise.all(
    rows.map(async (row) => {
      const r = row as VariantRow;
      const slots = r?.overrideTtsVoices as Record<string, unknown> | undefined;
      const qwen = slots?.qwen as { variants?: Record<string, unknown> } | undefined;
      const variants = qwen?.variants;
      if (!variants || typeof variants !== 'object' || Object.keys(variants).length === 0) return row;
      let baseKey: string;
      try {
        baseKey = qwenVariantBaseKey(r);
      } catch {
        return row;
      }
      const baseRev = await baseRevOf(baseKey);
      if (baseRev === UNKNOWN) return row;
      const kept: Record<string, unknown> = {};
      let dropped = false;
      for (const [emotion, v] of Object.entries(variants)) {
        if (v) {
          const variantRev = await readRevField(`${baseKey}__${emotion}`, 'baseRev');
          if (variantRev !== UNKNOWN && variantRev !== baseRev) {
            dropped = true;
            continue;
          }
        }
        kept[emotion] = v;
      }
      if (!dropped) return row;
      const nextQwen: Record<string, unknown> = { ...qwen };
      if (Object.keys(kept).length > 0) nextQwen.variants = kept;
      else delete nextQwen.variants;
      return { ...(row as object), overrideTtsVoices: { ...slots, qwen: nextQwen } } as T;
    }),
  );
}
