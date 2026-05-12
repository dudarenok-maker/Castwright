/* POST /api/manuscripts/:id/analysis — SSE stream.
   Events are sent as `data: <json>\n\n`. Two payload shapes:
     { kind: 'phase',  phaseId, progress, label? }
     { kind: 'result', response: AnalyseResponse }
   The frontend's `real.analyseManuscript` reads this with fetch + ReadableStream. */

import { Router, type Request, type Response } from 'express';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
import { selectAnalyzer } from '../analyzer/index.js';
import { clearAnalysisCache, loadAnalysisCache, saveAnalysisCache, type AnalysisCache } from '../store/analysis-cache.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { castJsonPath, manuscriptEditsJsonPath, slug, stateJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { BookStateJson } from '../workspace/scan.js';

/* Human-readable label for a Gemini model id. Kept in lockstep with
   src/lib/models.ts MODEL_OPTIONS — the frontend sends the id, we render
   the friendly name in logs and the SSE event stream. */
const MODEL_LABELS: Record<string, string> = {
  'gemini-2.5-flash':         'Gemini 2.5 Flash',
  'gemini-3-flash-preview':   'Gemini 3 Flash',
  'gemini-3.1-flash-lite':    'Gemini 3.1 Flash Lite',
  'gemma-4-31b-it':           'Gemma 4 31B',
  'gemma-4-26b-a4b-it':       'Gemma 4 26B',
};

function humanModel(modelId: string | undefined): string {
  if (!modelId) return 'cowork reviewer';
  return MODEL_LABELS[modelId] ?? modelId;
}

/* Front-end palette has 30 character slots (see src/lib/colors.ts
   CHAR_COLORS + CHARACTER_SLOTS). Gemini and humans both like to invent
   character-specific kebab names like `keefe` that don't exist in the
   palette and fall back to grey. We normalise here: narrator keeps its
   slot; everyone else gets a slot in roster order, cycling after 30.
   Order must match src/lib/colors.ts CHARACTER_SLOTS. */
const PALETTE_SLOTS = [
  'halloran', 'eliza', 'marcus',
  ...Array.from({ length: 27 }, (_, i) => `slot-${i + 4}`),
];
function assignPaletteColors(characters: CharacterOutput[]): CharacterOutput[] {
  let i = 0;
  return characters.map(c => {
    if (c.id === 'narrator' || c.color === 'narrator') return { ...c, color: 'narrator' };
    const slot = PALETTE_SLOTS[i % PALETTE_SLOTS.length];
    i += 1;
    return { ...c, color: slot };
  });
}

/* Stage 1 doesn't know per-sentence counts. Compute lines (sentences spoken)
   and scenes (distinct chapters appeared in) from stage 2 output once we
   have it, and attach to each character. */
function attachLinesAndScenes(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
): CharacterOutput[] {
  const lines = new Map<string, number>();
  const scenes = new Map<string, Set<number>>();
  for (const s of sentences) {
    lines.set(s.characterId, (lines.get(s.characterId) ?? 0) + 1);
    let set = scenes.get(s.characterId);
    if (!set) { set = new Set(); scenes.set(s.characterId, set); }
    set.add(s.chapterId);
  }
  return characters.map(c => ({
    ...c,
    lines: lines.get(c.id) ?? 0,
    scenes: scenes.get(c.id)?.size ?? 0,
  }));
}

export const analysisRouter = Router();

/* Keep aligned with src/data/analysis-phases.ts ANALYSIS_PHASES. */
const PHASES = [
  { id: 0, label: 'Detecting characters',    durationMs: 0    }, // handoff stage 1
  { id: 1, label: 'Parsing and attribution', durationMs: 0    }, // handoff stage 2
  { id: 2, label: 'Matching library',        durationMs: 250  },
];

function bookIdFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'book';
}

function durationPlaceholder(): string {
  return '00:00';
}

/* Heuristic ETA model. Stage 1 is bounded by input size; stage 2 is bounded
   by *output* size (one JSON entry per sentence) and runs longer per input
   char. STAGE1_BASELINE_RATE is the only static baseline — stage 2 is
   computed from stage 1's *observed* rate × STAGE2_STRETCH, so big books
   on slow models still get a sensible bar after the first phase. */
const STAGE1_BASELINE_RATE = 1.0;  // input chars / ms; tuned for gemini-2.5-flash
const STAGE2_STRETCH = 3.0;         // stage 2 typically takes ~3× stage 1
const MIN_EST_MS = 3000;
const MAX_EST_MS = 10 * 60 * 1000;  // 10 minutes — past this the bar caps

function clampEst(ms: number): number {
  return Math.max(MIN_EST_MS, Math.min(MAX_EST_MS, Math.round(ms)));
}

function humanSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function buildStage1Inbox(manuscriptId: string, title: string, sourceText: string): string {
  return `---
manuscriptId: ${manuscriptId}
stage: 1
expectedOutput: ./outbox/${manuscriptId}-stage1.json
schema: see skills/audiobook-character-analysis.md
---

# Stage 1 — Character roster + chapter boundaries

Run the **\`audiobook-character-analysis\`** skill on the manuscript below.
Save the JSON output to:

\`\`\`
server/handoff/outbox/${manuscriptId}-stage1.json
\`\`\`

Schema and few-shot examples live in
\`skills/audiobook-character-analysis.md\`.

Return ONLY a JSON object matching the schema above. No prose, no code fences.

## Manuscript metadata

- Title: ${title}
- Manuscript ID: ${manuscriptId}

## Manuscript

${sourceText}
`;
}

function buildStage2ChapterInbox(
  manuscriptId: string,
  title: string,
  stage1: Stage1Output,
  chapter: { id: number; title: string; body: string },
): string {
  return `---
manuscriptId: ${manuscriptId}
stage: 2
chapterId: ${chapter.id}
expectedOutput: ./outbox/${manuscriptId}-stage2-ch${chapter.id}.json
schema: see skills/audiobook-sentence-attribution.md
---

# Stage 2 — Sentence attribution (Chapter ${chapter.id})

Run the **\`audiobook-sentence-attribution\`** skill on the single chapter
below. For every sentence, return the speaking character (or 'narrator' for
non-dialogue prose). Save to:

\`\`\`
server/handoff/outbox/${manuscriptId}-stage2-ch${chapter.id}.json
\`\`\`

Schema and rules live in \`skills/audiobook-sentence-attribution.md\`.

All \`chapterId\` values in the output MUST be \`${chapter.id}\`. Return ONLY a
JSON object matching the schema above. No prose, no code fences.

## Manuscript

- Title: ${title}
- Manuscript ID: ${manuscriptId}
- Chapter: ${chapter.id} — ${chapter.title}

## Characters (from stage 1)

\`\`\`json
${JSON.stringify(stage1.characters, null, 2)}
\`\`\`

## Chapter ${chapter.id} — ${chapter.title}

${chapter.body}
`;
}

analysisRouter.post('/:id/analysis', async (req: Request, res: Response) => {
  const manuscriptId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const log = (phaseId: number, message: string) => {
    send({ kind: 'log', phaseId, message });
  };

  /* In-memory lookup with a workspace-disk fallback. Lets the analysis
     resume after a server restart for any book that lives in the workspace
     tree (state.json carries the manuscriptId). */
  const record = await getOrHydrateManuscript(manuscriptId);
  if (!record) {
    send({
      kind: 'error',
      code: 'unknown_manuscript',
      message: `No manuscript found for id "${manuscriptId}". Upload a manuscript or open a workspace book to start analysis.`,
    });
    return res.end();
  }

  const startedAt = Date.now();
  const phaseStarts: Record<number, number> = {};

  const markPhase = (id: number) => { phaseStarts[id] = Date.now(); };
  const endPhase = (id: number) => Date.now() - (phaseStarts[id] ?? Date.now());

  const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
  let analyzer;
  try {
    analyzer = selectAnalyzer({ model: requestedModel });
  } catch (e) {
    send({ kind: 'error', message: (e as Error).message });
    return res.end();
  }
  const isGemini = (process.env.ANALYZER ?? 'manual').toLowerCase() === 'gemini';
  const activeModelId = isGemini
    ? (requestedModel ?? process.env.GEMINI_MODEL ?? 'gemma-4-31b-it')
    : undefined;
  const analyzerLabel = isGemini ? humanModel(activeModelId) : 'cowork reviewer';
  if (requestedModel) {
    console.log(`[analysis] manuscript=${manuscriptId} model=${requestedModel}`);
  }

  try {
    const sourceChars = record.sourceText.length;
    const wordCount = record.sourceText.split(/\s+/).filter(Boolean).length;
    /* Pre-flight estimate uses the static baseline for both stages. After
       stage 1 completes we replace stage2EstMs with one derived from the
       *observed* rate, so the second bar reflects actual model speed. */
    let stage1EstMs = clampEst(sourceChars / STAGE1_BASELINE_RATE);
    let stage2EstMs = clampEst((sourceChars / STAGE1_BASELINE_RATE) * STAGE2_STRETCH);

    /* Load any partial progress from a previous attempt. Cached stage 1 is
       reused as-is; cached chapters are skipped in the stage 2 loop. Pass
       `fresh: true` in the request body to discard the cache and start
       over — the route's "Start fresh" button uses this. */
    const requestedFresh = req.body?.fresh === true;
    if (requestedFresh) {
      await clearAnalysisCache(manuscriptId);
      log(0, 'Discarded cached progress — starting from scratch.');
    }
    const cache: AnalysisCache = await loadAnalysisCache(manuscriptId);
    const cachedChapters = cache.chapters ?? {};
    const cachedChapterCount = Object.keys(cachedChapters).length;

    /* ── Phase 0: detecting characters (handoff stage 1). */
    markPhase(0);
    log(0, `Manuscript: ${wordCount.toLocaleString()} words, ${sourceChars.toLocaleString()} characters, ${record.chapterHints.length} chapter${record.chapterHints.length === 1 ? '' : 's'}`);
    log(0, `Estimated total time: ~${humanSeconds(stage1EstMs + stage2EstMs)} (refined after stage 1)`);
    let stage1: Stage1Output;
    let stage1ActualMs = 0;
    if (cache.stage1) {
      const charCount = cache.stage1.characters.length;
      log(0, `Resuming — stage 1 already complete (${charCount} character${charCount === 1 ? '' : 's'} cached).`);
      send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label });
      stage1 = cache.stage1;
    } else {
      send({ kind: 'phase', phaseId: 0, progress: 0.02, label: PHASES[0].label });
      log(0, `Asking ${analyzerLabel} to identify characters…`);
      log(0, `Estimated stage time: ~${humanSeconds(stage1EstMs)}`);
      const stage1Start = Date.now();
      stage1 = await analyzer.runStage1(
        manuscriptId,
        buildStage1Inbox(manuscriptId, record.title, record.sourceText),
        {
          onWaiting: (elapsed) => {
            /* Linear progress against the estimate, capped at 0.95 until the
               real result lands. The bar jumps to 1.0 on completion. */
            const p = Math.min(0.02 + 0.93 * (elapsed / stage1EstMs), 0.95);
            send({ kind: 'phase', phaseId: 0, progress: p, label: PHASES[0].label });
          },
        },
      );
      stage1ActualMs = Date.now() - stage1Start;
      cache.stage1 = stage1;
      await saveAnalysisCache(manuscriptId, cache);
    }
    /* Use the observed rate to refine stage 2's estimate. Stage 2 prompt is
       a similar size to stage 1 plus the small character roster, but its
       output is much larger (one JSON entry per sentence), hence the
       stretch factor. */
    if (stage1ActualMs > 0) {
      stage2EstMs = clampEst(stage1ActualMs * STAGE2_STRETCH);
      log(0, `Detected ${stage1.characters.length} character${stage1.characters.length === 1 ? '' : 's'}: ${stage1.characters.map(c => c.name).join(', ')}`);
      log(0, `${stage1.chapters.length} chapter${stage1.chapters.length === 1 ? '' : 's'} identified in ${humanSeconds(stage1ActualMs)}`);
    }
    send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label });

    /* ── Phase 1: parsing and attribution (handoff stage 2, per chapter).
       We split stage 2 by chapter so each call fits well inside the model's
       context window and free-tier rate limits can recover between calls.
       Overall progress is (chapters_done + current_chapter_local_progress) /
       total_chapters. */
    markPhase(1);
    send({ kind: 'phase', phaseId: 1, progress: 0.02, label: PHASES[1].label });
    const totalChapters = record.chapterHints.length;
    log(1, `Attributing ${totalChapters} chapter${totalChapters === 1 ? '' : 's'} with ${analyzerLabel}, one at a time…`);
    log(1, `Estimated stage time: ~${humanSeconds(stage2EstMs)} (based on stage 1 rate)`);
    if (cachedChapterCount > 0) {
      log(1, `Resuming — ${cachedChapterCount} of ${totalChapters} chapter${cachedChapterCount === 1 ? '' : 's'} already cached.`);
    }
    const chapterEstMs = Math.max(2000, Math.round(stage2EstMs / Math.max(1, totalChapters)));
    const allSentences: SentenceOutput[] = [];

    for (let i = 0; i < totalChapters; i++) {
      const ch = record.chapterHints[i];
      const tickOverall = (frac: number) => {
        const overall = (i + frac) / totalChapters;
        const p = Math.min(0.02 + 0.93 * overall, 0.95);
        send({ kind: 'phase', phaseId: 1, progress: p, label: PHASES[1].label });
      };

      const cached = cachedChapters[ch.id];
      if (cached && cached.length > 0) {
        log(1, `Chapter ${i + 1}/${totalChapters} — ${ch.title}: cached (${cached.length.toLocaleString()} sentences), skipping.`);
        allSentences.push(...cached);
        tickOverall(1);
        continue;
      }

      const chStart = Date.now();
      log(1, `Chapter ${i + 1}/${totalChapters} — ${ch.title} (${ch.body.length.toLocaleString()} chars) via ${analyzerLabel}…`);
      const result = await analyzer.runStage2Chapter(
        manuscriptId,
        ch.id,
        buildStage2ChapterInbox(manuscriptId, record.title, stage1, ch),
        {
          onWaiting: (elapsed) => tickOverall(Math.min(elapsed / chapterEstMs, 1)),
        },
      );
      /* Force-fix the chapterId in case the model echoed back something
         different — the route is the source of truth here. */
      for (const s of result.sentences) s.chapterId = ch.id;
      allSentences.push(...result.sentences);
      cachedChapters[ch.id] = result.sentences;
      cache.chapters = cachedChapters;
      await saveAnalysisCache(manuscriptId, cache);
      /* Roll sentences out to manuscript-edits.json after each chapter so a
         book-state GET sees real per-sentence attributions even when stage 2
         is only partially done. Lets the manuscript view show actual cast
         lines instead of the mock initialSentences fallback. */
      if (record.bookDir) {
        try {
          await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), { sentences: allSentences });
        } catch (persistErr) {
          console.warn('[analysis] failed to roll manuscript-edits.json', persistErr);
        }
      }
      log(1, `Chapter ${i + 1}/${totalChapters} done — ${result.sentences.length.toLocaleString()} sentences in ${humanSeconds(Date.now() - chStart)}`);
    }

    /* Final manuscript-edits.json write. Covers the all-cached resume case
       where no per-iteration write ran. Idempotent. */
    if (record.bookDir) {
      try {
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), { sentences: allSentences });
      } catch (persistErr) {
        console.warn('[analysis] failed final manuscript-edits.json write', persistErr);
      }
    }
    log(1, `Attributed ${allSentences.length.toLocaleString()} sentences across ${totalChapters} chapter${totalChapters === 1 ? '' : 's'}`);
    /* Per-character line counts, sorted by lines descending — most prominent first. */
    {
      const lineCounts = new Map<string, number>();
      for (const s of allSentences) {
        lineCounts.set(s.characterId, (lineCounts.get(s.characterId) ?? 0) + 1);
      }
      const top = stage1.characters
        .map(c => ({ name: c.name, lines: lineCounts.get(c.id) ?? 0 }))
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 4);
      for (const t of top) log(1, `${t.name}: ${t.lines.toLocaleString()} lines`);
    }
    send({ kind: 'phase', phaseId: 1, progress: 1, label: PHASES[1].label });

    /* ── Phase 2: matching library — empty for first slice. */
    markPhase(2);
    log(2, 'No library matches yet (voice library matching is not wired up for this slice).');
    for (let i = 1; i <= 3; i++) {
      send({ kind: 'phase', phaseId: 2, progress: i / 3, label: PHASES[2].label });
      await new Promise(r => setTimeout(r, PHASES[2].durationMs / 3));
    }

    /* ── Compose the AnalyseResponse. */
    const chapterTitleById = new Map(stage1.chapters.map(c => [c.id, c.title]));
    const chapters = record.chapterHints.map(h => ({
      id: h.id,
      title: chapterTitleById.get(h.id) ?? h.title,
      duration: durationPlaceholder(),
      state: 'queued' as const,
      progress: 0,
      characters: {} as Record<string, 'queued' | 'in_progress' | 'done' | 'skipped' | 'failed'>,
    }));

    const characters = attachLinesAndScenes(
      assignPaletteColors(stage1.characters),
      allSentences,
    );

    const totalElapsed = Date.now() - startedAt;
    const bookId = record.bookId ?? bookIdFromTitle(record.title);
    const response = {
      bookId,
      manuscriptId,
      title: record.title,
      phaseTimings: PHASES.map(p => ({ id: p.id, label: p.label, duration: endPhase(p.id) || Math.round(totalElapsed / PHASES.length) })),
      characters,
      chapters,
      sentences: allSentences,
      libraryMatches: [] as Array<{ characterId: string; voiceId: string; confidence: number }>,
    };

    // Persist cast.json + refreshed state.json back into the on-disk book.
    // Only runs for books that came through POST /api/books (workspace flow);
    // legacy POST /api/manuscripts uploads have no bookDir and are skipped.
    if (record.bookDir) {
      try {
        await writeJsonAtomic(castJsonPath(record.bookDir), { characters });
        const statePath = stateJsonPath(record.bookDir);
        const prev = await readJson<BookStateJson>(statePath);
        if (prev) {
          const next: BookStateJson = {
            ...prev,
            chapters: chapters.map(c => ({
              id: c.id,
              title: c.title,
              slug: `${String(c.id).padStart(2, '0')}-${slug(c.title)}`,
              duration: c.duration,
            })),
            updatedAt: new Date().toISOString(),
          };
          await writeJsonAtomic(statePath, next);
        }
      } catch (persistErr) {
        console.error('[analysis] failed to persist .audiobook/* for', record.bookDir, persistErr);
        // Non-fatal — the analysis result still streams back to the client.
      }
    }

    send({ kind: 'result', response });
    res.end();
  } catch (e) {
    console.error('[analysis] failed', e);
    const { code, message } = describeError(e, analyzerLabel);
    send({ kind: 'error', code, message });
    res.end();
  }
});

/* The Gemini SDK throws `ApiError` instances whose `.message` is the raw
   JSON envelope (e.g. `{"error":{"code":503,"message":"...","status":"..."}}`).
   Surface a friendly, copy-pasteable line for the UI plus a short `code` the
   client can switch on (rate_limit | unavailable | internal | invalid_key |
   network | unknown). */
function describeError(err: unknown, modelLabel: string): { code: string; message: string } {
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;

  const parsed = tryParseApiError(raw);
  if (parsed) {
    const code = classifyStatus(parsed.code ?? status, parsed.message);
    const message = trimQuotaMessage(parsed.message);
    return { code, message: `${modelLabel} returned ${parsed.code ?? status ?? '???'}: ${message}` };
  }

  if (status) {
    return { code: classifyStatus(status, raw), message: `${modelLabel} returned ${status}: ${raw}` };
  }
  return { code: 'unknown', message: raw || 'Analysis failed.' };
}

/* Google's 429 body is wall-of-text — strip everything after the first
   sentence so the UI alert stays tractable. The full text still lives in
   the server console for debugging. */
function trimQuotaMessage(message: string): string {
  const firstStop = message.search(/[.\n]/);
  if (firstStop > 0 && firstStop < 240) return message.slice(0, firstStop + 1).trim();
  return message.slice(0, 240) + (message.length > 240 ? '…' : '');
}

function tryParseApiError(raw: string): { code?: number; message: string } | null {
  /* SDK messages often look like 'got status: 503 UNAVAILABLE. {"error":{...}}'.
     Find the first '{' and try to parse from there. */
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start)) as { error?: { code?: number; message?: string } };
    if (obj?.error?.message) {
      return { code: obj.error.code, message: obj.error.message };
    }
  } catch {
    return null;
  }
  return null;
}

function classifyStatus(status: number | undefined, message?: string): string {
  if (!status) return 'unknown';
  if (status === 429) {
    /* Distinguish per-day "free tier exhausted" from short-term per-minute
       throttling — the user-facing remedies differ (switch model / wait
       until quota reset vs. just retry). */
    if (message && /free[_-]?tier|quotaValue":"\d{1,3}"/i.test(message)) return 'daily_quota';
    return 'rate_limit';
  }
  if (status === 503) return 'unavailable';
  if (status === 500) return 'internal';
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 400) return 'bad_request';
  return 'unknown';
}
