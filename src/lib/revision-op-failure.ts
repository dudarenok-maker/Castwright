/* Plan 286 — the one error type every revisions op throws (real and mock),
   so the thunks branch on `code` only. Outside api.ts so the mocks can
   import it without a cycle. */
import type { RevisionsState } from './types';

export const REVISION_OP_CODES = [
  'invalid_selection', 'book_not_found', 'revision_not_found', 'chapter_busy', 'no_previous_audio',
  'live_audio_missing', 'revision_gone', 'restore_failed', 'has_revision', 'lock_contention', 'not_found',
] as const;
export type RevisionOpCode = (typeof REVISION_OP_CODES)[number] | 'unexpected';

export class RevisionOpFailure extends Error {
  constructor(message: string, readonly status: number, readonly code: RevisionOpCode, readonly state?: RevisionsState) {
    super(message);
    this.name = 'RevisionOpFailure';
  }
}

export async function revisionOpFailureFrom(res: Response, fallback: string): Promise<RevisionOpFailure> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; state?: RevisionsState } | null;
  const raw = typeof body?.error === 'string' ? body.error : null;
  const known = raw !== null && (REVISION_OP_CODES as readonly string[]).includes(raw);
  const code: RevisionOpCode = known ? (raw as RevisionOpCode) : 'unexpected';
  const message = typeof body?.message === 'string' ? body.message : !known && raw !== null ? raw : fallback;
  return new RevisionOpFailure(message, res.status, code, body?.state);
}
