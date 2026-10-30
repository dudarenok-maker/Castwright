/* Plan 289 (#3784) — per-field revision tokens for the four PUT /state slices.

   A token is derived from content, never stored: for field `f` of a slice it is
   `first16hex(sha256(manuscriptId ∥ editEpoch ∥ f ∥ canonicalJson(value)))`.
   `state.json.editEpoch` is the only stored part; import mints it and the wiping
   writers (re-parse, replace, Start fresh) rotate it, so every token of a wiped
   or re-imported book moves. No other writer touches it.

   This is the only place tokens are made. Pure: no fs, no locks. */
import { createHash, randomBytes } from 'node:crypto';

export type SliceName = 'state' | 'cast' | 'manuscript' | 'changeLog';
/** Field -> token. Opaque to clients, which echo it back unchanged. */
export type SliceRevision = Record<string, string>;

/** The editorial `state.json` fields PUT /state can write. `chapters` and
 *  `updatedAt` are deliberately absent (no client sends `chapters` on this
 *  slice; `updatedAt` moves on every write). */
export const STATE_REVISION_FIELDS = [
  'castConfirmed',
  'title',
  'author',
  'series',
  'seriesPosition',
  'isStandalone',
  'narratorCredit',
  'genre',
  'publicationDate',
  'description',
  'notes',
  'audioFormat',
  'language',
  'tags',
  'prosodyEnabled',
  'prosodyAnnotated',
] as const;
export const CAST_REVISION_FIELDS = ['characters'] as const;
export const MANUSCRIPT_REVISION_FIELDS = ['sentences', 'mergedAwayKeys'] as const;
export const CHANGELOG_REVISION_FIELDS = ['events'] as const;

const FIELDS: Record<SliceName, readonly string[]> = {
  state: STATE_REVISION_FIELDS,
  cast: CAST_REVISION_FIELDS,
  manuscript: MANUSCRIPT_REVISION_FIELDS,
  changeLog: CHANGELOG_REVISION_FIELDS,
};

export interface RevisionSalt {
  manuscriptId: string;
  /** Absent on a legacy book: salts as the empty string, no migration. */
  editEpoch?: string;
}

const ABSENT_FILE = '<absent-file>';
const ABSENT_FIELD = '<absent-field>';

/** JSON with object keys sorted at every depth. Arrays keep their order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Thrown from inside a slice's locked span when a conditional write carries a
 *  stale field. The route maps it to 409 `stale_revision`; nothing was written. */
export class StaleRevisionError extends Error {
  constructor(public readonly fields: string[]) {
    super('stale_revision');
    this.name = 'StaleRevisionError';
  }
}

/** A client-echoed base: a flat map of string tokens. */
export function isSliceRevision(v: unknown): v is SliceRevision {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((t) => typeof t === 'string')
  );
}

/** A fresh edit epoch. Server-owned: `state.json.editEpoch`. */
export function mintEditEpoch(): string {
  return `ep_${randomBytes(8).toString('base64url').slice(0, 10)}`;
}

/** The per-field tokens of one slice. `content` is the parsed file, or `null`
 *  when the file is absent. Callers pass the RAW read, before any decoration. */
export function sliceRevision(
  slice: SliceName,
  content: Record<string, unknown> | null | undefined,
  salt: RevisionSalt,
): SliceRevision {
  const out: SliceRevision = {};
  for (const field of FIELDS[slice]) {
    const value =
      content == null ? ABSENT_FILE : content[field] === undefined ? ABSENT_FIELD : canonicalJson(content[field]);
    out[field] = createHash('sha256')
      .update([salt.manuscriptId, salt.editEpoch ?? '', field, value].join('\0'))
      .digest('hex')
      .slice(0, 16);
  }
  return out;
}

/** The carried fields (keys of `next`, the tokens of the server's post-merge,
 *  post-transform values) that make a conditional write stale: the base token
 *  is present, differs from the current one, and the write would change the
 *  field. A field the write leaves as it is is never stale (a lost-response
 *  retry succeeds rather than being refused). */
export function staleFields(
  base: SliceRevision | undefined,
  current: SliceRevision,
  next: SliceRevision,
): string[] {
  if (!base) return [];
  return Object.keys(next).filter(
    (f) => base[f] !== undefined && base[f] !== current[f] && next[f] !== current[f],
  );
}
