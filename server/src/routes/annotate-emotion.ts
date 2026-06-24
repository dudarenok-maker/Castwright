/* fs-33 — emotion-only backfill route. Streams a lightweight LLM pass that
   reads a book's already-attributed sentences and emits per-sentence delivery
   emotions WITHOUT re-attributing. The route never writes a file: it streams
   `annotation` events and the FRONTEND applies them through the same
   manuscript-slice → persistence-middleware → manuscript-edits.json path that
   manual per-quote emotion tags use today (so synth picks them up via
   rebuildCacheFromEdits, and manual tags always win via fill-only-empty).

   Non-sticky by design: a disconnect aborts the in-flight analyzer call.
   Already-streamed chapters are already applied client-side, so a re-run just
   fills the remaining empties. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { loadPostFoldSentencesByChapter } from '../store/post-fold-sentences.js';
import { selectAnalyzerForPhase } from '../analyzer/select-analyzer.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import type { SentenceOutput } from '../handoff/schemas.js';

export const annotateEmotionRouter = Router();

/* Build the per-chapter emotion-annotation prompt. We send the FULL chapter
   sentence sequence (narrator splits included) so the model has the
   dialogue-tag context that signals delivery ("she whispered" is a narrator
   split adjacent to the spoken line) — but the skill only annotates spoken
   lines. Only id/characterId/text go out; the model returns {sentenceId,
   emotion}. */
export function buildEmotionChapterInbox(
  manuscriptId: string,
  chapterId: number,
  sentences: SentenceOutput[],
): string {
  const payload = sentences.map((s) => ({
    sentenceId: s.id,
    characterId: s.characterId,
    text: s.text,
  }));
  return `---
manuscriptId: ${manuscriptId}
task: emotion-annotation
chapterId: ${chapterId}
---

## Sentences (already attributed — do NOT re-attribute)

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
`;
}

annotateEmotionRouter.post(
  '/:bookId/annotate-emotion',
  async (req: Request, res: Response): Promise<void> => {
    const { bookId } = req.params;

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
    /* Skip chapters the user excluded from narration (front/back-matter they
       opted out of). Mirrors the generation route's `!c.excluded` filter
       (analysis.ts) so emotion detection never burns analyzer calls on
       chapters that will never be rendered. */
    const excludedChapterIds = new Set<number>(
      located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
    );
    const chapterIds = [...byChapter.keys()]
      .filter((id) => !excludedChapterIds.has(id))
      .sort((a, b) => a - b);

    /* SSE setup (mirrors analysis.ts). */
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
        message: 'Run analysis first — there are no attributed sentences to annotate.',
      });
      clearInterval(keepAlive);
      res.end();
      return;
    }

    const heartbeat = makeThrottledHeartbeat(send, 2000);
    const selection = selectAnalyzerForPhase({ phase: 'phase1', model: req.body?.model });

    let totalAnnotations = 0;
    let annotatedChapters = 0;
    try {
      for (let i = 0; i < chapterIds.length; i += 1) {
        if (closed) break;
        const chapterId = chapterIds[i];
        send({
          kind: 'phase',
          phaseId: 0,
          progress: i / chapterIds.length,
          label: `Detecting emotions — chapter ${chapterId}`,
          chapterId,
        });

        const prompt = buildEmotionChapterInbox(
          manuscriptId,
          chapterId,
          byChapter.get(chapterId) ?? [],
        );

        try {
          const result = await selection.analyzer.runEmotionChapter(manuscriptId, chapterId, prompt, {
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
          });
          send({ kind: 'annotation', chapterId, annotations: result.annotations });
          totalAnnotations += result.annotations.length;
          annotatedChapters += 1;
        } catch (err) {
          if (err instanceof AnalysisAbortedError) break;
          if (err instanceof DailyQuotaExhaustedError) {
            send({
              kind: 'error',
              code: 'quota_exhausted',
              message:
                'Daily analyzer quota exhausted. Already-detected chapters are applied — re-run to finish.',
              resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined,
            });
            clearInterval(keepAlive);
            if (!closed) res.end();
            return;
          }
          /* One bad chapter shouldn't kill the whole pass — report it and
             carry on so the rest of the book still gets annotated. */
          send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
        }
      }
    } finally {
      clearInterval(keepAlive);
    }

    if (!closed) {
      send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
      send({ kind: 'result', done: true, annotatedChapters, totalAnnotations });
      res.end();
    }
  },
);
