/* fs-58 — LLM script-review route. Streams a per-chapter LLM pass that
   reads a book's attributed sentences + post-fold cast roster and emits
   editing ops (strip_tag, split, extract_dialogue, merge, fix_emotion).
   The route never writes a file: it streams `ops` events and the FRONTEND
   applies them through existing Redux manual-edit reducers.

   Non-sticky by design: a disconnect aborts the in-flight analyzer call.
   Already-streamed chapters are already applied client-side, so a re-run
   just fills the remaining chapters.

   Large chapters: a chapter whose prompt exceeds the local model's context
   window is split by `chunkSentencesByBudget` (chapter-chunker.ts) into
   budgeted chunks. Each chunk carries an OWNED CORE plus overlap CONTEXT; an op
   is emitted only by the chunk whose core contains its primary sentence
   (`ownsOp` / `primarySentenceId`), so every sentence is reviewed exactly once
   across the overlapping chunks. Cloud engines get a MAX_SAFE_INTEGER budget
   from `chapterChunkBudget`, so they stay one call per chapter. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { loadPostFoldSentencesByChapter } from '../store/post-fold-sentences.js';
import { selectAnalyzerForPhase } from '../analyzer/select-analyzer.js';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import {
  chunkSentencesByBudget,
  chunkWithContext,
  ownsOp,
  primarySentenceId,
  chapterChunkBudget,
} from '../analyzer/chapter-chunker.js';
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

/* fs-64 — cross-chapter context for the script-review pass. The prior chapter's
   final two-speaker exchange is fed (read-only) into a chapter's first chunk so
   the model can resolve a tagless chapter-opening line via turn-taking. */
const NARRATOR_ID = 'narrator'; // module-private convention (re-declared, never exported)
export const PRIOR_TURN_LOOKBACK = 6; // sentences (positions) scanned back from the chapter end
export const MAX_PRIOR_TURN_CHARS = 240; // hard cap per rendered line

export interface BoundaryTurn {
  speakerId: string;
  speakerName: string;
  text: string;
}
export interface PriorExchange {
  turns: BoundaryTurn[]; // exactly two, [A, B] in reading order
}

function capLine(text: string): string {
  return text.length > MAX_PRIOR_TURN_CHARS
    ? text.slice(0, MAX_PRIOR_TURN_CHARS - 1).trimEnd() + '…'
    : text;
}

/* The prior chapter's final two-speaker exchange, or null when it does not end
   in a live exchange. Narration and excludeFromSynthesis residue are filtered;
   the remaining eligible sentences in the last PRIOR_TURN_LOOKBACK positions are
   collapsed into contiguous same-speaker turns. Gate: >=2 turns (which, by the
   collapse, guarantees the last two are different speakers). Two distinct people
   folded to one id (e.g. unknown-male) collapse to one turn -> null. */
export function priorChapterBoundaryExchange(
  sentences: Array<{ id: number; characterId: string; text: string; excludeFromSynthesis?: boolean }>,
  roster: Array<{ id: string; name: string }>,
): PriorExchange | null {
  const eligible = sentences
    .slice(-PRIOR_TURN_LOOKBACK)
    .filter((s) => s.characterId !== NARRATOR_ID && s.excludeFromSynthesis !== true);

  const turns: Array<{ speakerId: string; lastText: string }> = [];
  for (const sentence of eligible) {
    const prev = turns[turns.length - 1];
    if (prev && prev.speakerId === sentence.characterId) {
      prev.lastText = sentence.text; // extend the run; keep its boundary-adjacent line
    } else {
      turns.push({ speakerId: sentence.characterId, lastText: sentence.text });
    }
  }
  if (turns.length < 2) return null;

  const nameOf = (id: string): string => roster.find((r) => r.id === id)?.name ?? id;
  const toTurn = (t: { speakerId: string; lastText: string }): BoundaryTurn => ({
    speakerId: t.speakerId,
    speakerName: nameOf(t.speakerId),
    text: capLine(t.lastText),
  });
  const [a, b] = turns.slice(-2);
  return { turns: [toTurn(a), toTurn(b)] };
}

/* Build the per-chapter script-review prompt. We send the full chapter
   sentence sequence plus the post-fold cast roster (id/name/role) so the
   model can identify characters and propose attribution-level edits.
   Only id/characterId/text go out for the sentences; the model returns a
   flat list of ops each with an anchor and optional new-text/pieceCharacterIds
   /mergeIds/emotion. */
/* fs-58 — serialize the per-sentence review input. `instruct` (always English)
   rides along only when present, and `vocalization` only when `true` (never
   `false`), so the prompt sees the fields exactly as the apply layer stores
   them. Lifted out of buildScriptReviewChapterInbox so it can be unit-tested. */
export function buildReviewSentencesInput(
  sentences: Array<{
    id: number;
    characterId: string;
    text: string;
    instruct?: string;
    vocalization?: boolean;
  }>,
): Array<Record<string, unknown>> {
  return sentences.map((s) => ({
    sentenceId: s.id,
    characterId: s.characterId,
    text: s.text,
    ...(s.instruct ? { instruct: s.instruct } : {}),
    ...(s.vocalization ? { vocalization: true } : {}),
  }));
}

export function buildScriptReviewChapterInbox(
  manuscriptId: string,
  chapterId: number,
  sentences: SentenceOutput[],
  roster: CastCharacterSlim[],
): string {
  const sentencePayload = buildReviewSentencesInput(sentences);
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
    } else {
      /* Whole-book review skips chapters the user excluded from narration
         (front/back-matter). Mirrors the detect-emotions + generation filters.
         An explicit per-chapter request above is honoured even when excluded. */
      const excludedChapterIds = new Set<number>(
        located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
      );
      chapterIds = chapterIds.filter((id) => !excludedChapterIds.has(id));
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

    if (byChapter.size === 0) {
      /* The book carries no attributed sentences at all — it was never
         analysed (or analysis produced nothing). */
      send({
        kind: 'error',
        code: 'no_attribution',
        message: 'Run analysis first — there are no attributed sentences to review.',
      });
      clearInterval(keepAlive);
      res.end();
      return;
    }
    if (chapterIds.length === 0) {
      /* The book IS analysed, but the requested chapterId matched no chapter
         with attributed sentences — a distinct case from the unanalysed book. */
      send({
        kind: 'error',
        code: 'no_such_chapter',
        message: `Chapter ${requestedChapterId} has no attributed sentences to review.`,
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

        /* Split the chapter's sentences into budgeted chunks (one call each).
           The owned-core rule keeps each sentence reviewed exactly once across
           the overlapping context windows. A cloud engine gets a huge budget so
           the whole chapter is a single chunk (unchanged behaviour). */
        const chunks = chunkSentencesByBudget(byChapter.get(chapterId) ?? [], {
          charBudget: chapterChunkBudget(selection.engine),
          overlap: 3,
          serialize: (s) => JSON.stringify({ id: s.id, characterId: s.characterId, text: s.text }),
        });

        for (const chunk of chunks) {
          if (closed) break;
          const prompt = buildScriptReviewChapterInbox(
            manuscriptId,
            chapterId,
            chunkWithContext(chunk),
            roster,
          );
          try {
            const result = await selection.analyzer.runScriptReviewChapter(
              manuscriptId,
              chapterId,
              prompt,
              {
                signal: controller.signal,
                language: bookStateLanguage(located.state),
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
            /* Emit only the ops this chunk OWNS (primary sentence in its core),
               so a sentence appearing in another chunk's context isn't emitted twice. */
            const owned = result.ops.filter((op) => ownsOp(chunk.coreIds, primarySentenceId(op)));
            if (owned.length) {
              send({ kind: 'ops', chapterId, ops: owned });
              totalOps += owned.length;
            }
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
            /* One bad chunk shouldn't kill the whole pass — report it and
               carry on so the rest of the book still gets reviewed. */
            send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
          }
        }
        reviewedChapters += 1;
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
