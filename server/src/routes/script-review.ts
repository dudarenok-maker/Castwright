/* fs-58 — LLM script-review route. Streams a per-chapter LLM pass that
   reads a book's attributed sentences + post-fold cast roster and emits
   editing ops (strip_tag, split, extract_dialogue, merge, fix_emotion).
   The route never writes a file: it streams `ops` events and the FRONTEND
   applies them through existing Redux manual-edit reducers.

   Non-sticky by design: a disconnect aborts the in-flight analyzer call.
   Already-streamed chapters are already applied client-side, so a re-run
   just fills the remaining chapters.

   ASSUMPTION — overflow deferral: when a chapter's prompt text exceeds the
   model budget (DEFAULT_STAGE2_CHUNK_CHAR_BUDGET), this route emits a
   `chapter-failed` event with a "chapter too large — split it first" message
   and continues to the next chapter. Chunk-with-overlap (the richer approach
   from stage2-chunk.ts) is deferred to a follow-up task. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { manuscriptEditsJsonPath, castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { selectAnalyzerForPhase } from '../analyzer/select-analyzer.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import { DEFAULT_STAGE2_CHUNK_CHAR_BUDGET } from '../analyzer/stage2-chunk.js';
import type { SentenceOutput } from '../handoff/schemas.js';

export const scriptReviewRouter = Router();

/* Local type for the parts of cast.json we need. */
interface CastCharacterSlim {
  id: string;
  name: string;
  role?: string;
}
interface CastFile {
  characters?: CastCharacterSlim[];
}

/* Load the book's POST-FOLD attributed sentences grouped by chapter — the
   same source synth + the manuscript view use. Mirrors loadPostFoldSentencesByChapter
   from annotate-emotion.ts exactly (same reconciliation logic). */
async function loadPostFoldSentencesByChapter(
  manuscriptId: string,
  bookDir: string,
): Promise<Map<number, SentenceOutput[]>> {
  const cache = await loadAnalysisCache(manuscriptId);
  const cachedSentences = Object.values(cache.chapters ?? {}).flat();
  const edits = await readJson<{ sentences?: SentenceOutput[] }>(manuscriptEditsJsonPath(bookDir));

  let sentences: SentenceOutput[];
  if (edits && Array.isArray(edits.sentences) && edits.sentences.length > 0) {
    if (cachedSentences.length > 0) {
      const cacheIds = new Set<number>();
      let maxCacheId = 0;
      for (const s of cachedSentences) {
        cacheIds.add(s.id);
        if (s.id > maxCacheId) maxCacheId = s.id;
      }
      sentences = edits.sentences.filter(
        (s) => typeof s?.id !== 'number' || cacheIds.has(s.id) || s.id > maxCacheId,
      );
    } else {
      sentences = edits.sentences;
    }
  } else {
    sentences = cachedSentences;
  }

  const byChapter = new Map<number, SentenceOutput[]>();
  for (const s of sentences) {
    if (typeof s?.chapterId !== 'number') continue;
    const bucket = byChapter.get(s.chapterId);
    if (bucket) bucket.push(s);
    else byChapter.set(s.chapterId, [s]);
  }
  return byChapter;
}

/* Build the per-chapter script-review prompt. We send the full chapter
   sentence sequence plus the post-fold cast roster (id/name/role) so the
   model can identify characters and propose attribution-level edits.
   Only id/characterId/text go out for the sentences; the model returns a
   flat list of ops each with an anchor and optional new-text/pieceCharacterIds
   /mergeIds/emotion. */
export function buildScriptReviewChapterInbox(
  manuscriptId: string,
  chapterId: number,
  sentences: SentenceOutput[],
  roster: CastCharacterSlim[],
): string {
  const sentencePayload = sentences.map((s) => ({
    sentenceId: s.id,
    characterId: s.characterId,
    text: s.text,
  }));
  const rosterPayload = roster.map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.role ? { role: c.role } : {}),
  }));
  return `---
manuscriptId: ${manuscriptId}
task: script-review
chapterId: ${chapterId}
---

## Cast roster (post-fold)

\`\`\`json
${JSON.stringify(rosterPayload, null, 2)}
\`\`\`

## Sentences (already attributed)

\`\`\`json
${JSON.stringify(sentencePayload, null, 2)}
\`\`\`
`;
}

scriptReviewRouter.post(
  '/:bookId/script-review',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;
    const requestedChapterId: number | undefined =
      typeof req.body?.chapterId === 'number' ? req.body.chapterId : undefined;

    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found.' });
      return;
    }
    const manuscriptId = located.state.manuscriptId;
    if (!manuscriptId) {
      res.status(409).json({ error: 'Book has not been analysed yet.' });
      return;
    }

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, located.bookDir);

    /* When chapterId is supplied in the body, limit the pass to that one chapter. */
    let chapterIds = [...byChapter.keys()].sort((a, b) => a - b);
    if (requestedChapterId !== undefined) {
      chapterIds = chapterIds.filter((id) => id === requestedChapterId);
    }

    /* Load the post-fold cast roster so the prompt carries character names+roles.
       cast.json is written after the minor-cast fold so it already has folded ids.
       A missing or empty cast.json falls back to an empty roster — the model
       will still review the prose even without character context. */
    const castFile = await readJson<CastFile>(castJsonPath(located.bookDir));
    const roster: CastCharacterSlim[] = castFile?.characters ?? [];

    /* SSE setup (mirrors annotate-emotion.ts). */
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const keepAlive = setInterval(() => {
      try {
        res.write(':ka\n\n');
      } catch {
        /* socket gone */
      }
    }, 15_000);
    const send = (payload: unknown): void => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* dead socket */
      }
    };

    const controller = new AbortController();
    let closed = false;
    res.on('close', () => {
      closed = true;
      controller.abort();
      clearInterval(keepAlive);
    });

    if (chapterIds.length === 0) {
      send({
        kind: 'error',
        code: 'no_attribution',
        message: 'Run analysis first — there are no attributed sentences to review.',
      });
      clearInterval(keepAlive);
      res.end();
      return;
    }

    const heartbeat = makeThrottledHeartbeat(send, 2000);
    const selection = selectAnalyzerForPhase({ phase: 'phase1', model: req.body?.model });

    let totalOps = 0;
    let reviewedChapters = 0;
    try {
      for (let i = 0; i < chapterIds.length; i += 1) {
        if (closed) break;
        const chapterId = chapterIds[i];
        send({
          kind: 'phase',
          phaseId: 0,
          progress: i / chapterIds.length,
          label: `Reviewing script — chapter ${chapterId}`,
          chapterId,
        });

        const prompt = buildScriptReviewChapterInbox(
          manuscriptId,
          chapterId,
          byChapter.get(chapterId) ?? [],
          roster,
        );

        /* ASSUMPTION (overflow deferral): if the prompt exceeds the stage-2 char
           budget we emit chapter-failed with a clear message rather than
           silently truncating. Chunk-with-overlap (the richer approach) is
           deferred to a follow-up task. */
        if (prompt.length > DEFAULT_STAGE2_CHUNK_CHAR_BUDGET) {
          send({
            kind: 'chapter-failed',
            chapterId,
            message:
              `Chapter ${chapterId} is too large for a single review call (prompt ${prompt.length} chars ` +
              `> ${DEFAULT_STAGE2_CHUNK_CHAR_BUDGET} char budget) — split it first.`,
          });
          continue;
        }

        try {
          const result = await selection.analyzer.runScriptReviewChapter(
            manuscriptId,
            chapterId,
            prompt,
            {
              signal: controller.signal,
              onChunk: (info) =>
                heartbeat(0, chapterId, {
                  receivedBytes: info.receivedBytes,
                  elapsedMs: info.elapsedMs,
                  sinceLastChunkMs: info.sinceLastChunkMs,
                }),
              onThrottle: (waitMs, reason) =>
                send({
                  kind: 'throttle',
                  phaseId: 0,
                  chapterIndex: chapterId,
                  model: selection.model,
                  waitMs,
                  reason,
                }),
            },
          );
          send({ kind: 'ops', chapterId, ops: result.ops });
          totalOps += result.ops.length;
          reviewedChapters += 1;
        } catch (err) {
          if (err instanceof AnalysisAbortedError) break;
          if (err instanceof DailyQuotaExhaustedError) {
            send({
              kind: 'error',
              code: 'quota_exhausted',
              message:
                'Daily analyzer quota exhausted. Already-reviewed chapters are streamed — re-run to finish.',
              resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined,
            });
            clearInterval(keepAlive);
            if (!closed) res.end();
            return;
          }
          /* One bad chapter shouldn't kill the whole pass — report it and
             carry on so the rest of the book still gets reviewed. */
          send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
        }
      }
    } finally {
      clearInterval(keepAlive);
    }

    if (!closed) {
      send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
      send({ kind: 'result', done: true, reviewedChapters, totalOps });
      res.end();
    }
  },
);
