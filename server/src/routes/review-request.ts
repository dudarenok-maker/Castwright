/* Plan 285 (#3400) — the `review` intent a queue entry or generation request
   may carry: { characterId, triggeredBy }. Shared by routes/queue.ts (the
   enqueue whitelist) and routes/generation.ts (the request body) so both
   reject the same malformed shapes. Lives under routes/ so generation.ts
   gains no new import from audio/ or workspace/. Not set by any client in PR 1. */

export interface ReviewRequest {
  characterId: string;
  triggeredBy: string;
}

export const INVALID_REVIEW = 'invalid' as const;

/** undefined/null → absent. A plain object with a non-empty string
    characterId and a string triggeredBy → that pair (extra fields dropped).
    Anything else → INVALID_REVIEW. */
export function parseReviewRequest(raw: unknown): ReviewRequest | undefined | typeof INVALID_REVIEW {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return INVALID_REVIEW;
  const r = raw as Record<string, unknown>;
  if (typeof r.characterId !== 'string' || r.characterId.length === 0) return INVALID_REVIEW;
  if (typeof r.triggeredBy !== 'string') return INVALID_REVIEW;
  return { characterId: r.characterId, triggeredBy: r.triggeredBy };
}
