/* POST /api/manuscripts/:id/analysis — SSE stream.
   Events are sent as `data: <json>\n\n`. Two payload shapes:
     { kind: 'phase',  phaseId, progress, label? }
     { kind: 'result', response: AnalyseResponse }
   The frontend's `real.analyseManuscript` reads this with fetch + ReadableStream. */

import { Router, type Request, type Response } from 'express';
import { getManuscript } from '../store/manuscripts.js';
import { selectAnalyzer } from '../analyzer/index.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';

/* Front-end palette has 30 character slots (see src/lib/colors.ts
   CHAR_COLORS + CHARACTER_SLOTS). Gemini and humans both like to invent
   character-specific kebab names like `Marlow` that don't exist in the
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

function buildStage2Inbox(manuscriptId: string, title: string, stage1: Stage1Output, chapters: { id: number; title: string; body: string }[]): string {
  const chapterBlocks = chapters.map(ch => `### Chapter ${ch.id} — ${ch.title}\n\n${ch.body}`).join('\n\n');
  return `---
manuscriptId: ${manuscriptId}
stage: 2
expectedOutput: ./outbox/${manuscriptId}-stage2.json
schema: see skills/audiobook-sentence-attribution.md
---

# Stage 2 — Sentence attribution

Run the **\`audiobook-sentence-attribution\`** skill. For every sentence in
every chapter below, return the speaking character (or 'narrator' for
non-dialogue prose). Save to:

\`\`\`
server/handoff/outbox/${manuscriptId}-stage2.json
\`\`\`

Schema and rules live in \`skills/audiobook-sentence-attribution.md\`.

Return ONLY a JSON object matching the schema above. No prose, no code fences.

## Manuscript

- Title: ${title}
- Manuscript ID: ${manuscriptId}

## Characters (from stage 1)

\`\`\`json
${JSON.stringify(stage1.characters, null, 2)}
\`\`\`

## Chapters

${chapterBlocks}
`;
}

analysisRouter.post('/:id/analysis', async (req: Request, res: Response) => {
  const manuscriptId = req.params.id;
  const record = getManuscript(manuscriptId);

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

  if (!record) {
    send({ kind: 'error', message: `Unknown manuscriptId: ${manuscriptId}` });
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
  const analyzerLabel = (process.env.ANALYZER ?? 'manual').toLowerCase() === 'gemini'
    ? (requestedModel ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash')
    : 'cowork reviewer';
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

    /* ── Phase 0: detecting characters (handoff stage 1). */
    markPhase(0);
    log(0, `Manuscript: ${wordCount.toLocaleString()} words, ${sourceChars.toLocaleString()} characters, ${record.chapterHints.length} chapters`);
    log(0, `Estimated total time: ~${humanSeconds(stage1EstMs + stage2EstMs)} (refined after stage 1)`);
    send({ kind: 'phase', phaseId: 0, progress: 0.02, label: PHASES[0].label });
    log(0, `Asking ${analyzerLabel} to identify characters…`);
    log(0, `Estimated stage time: ~${humanSeconds(stage1EstMs)}`);
    const stage1Start = Date.now();
    const stage1: Stage1Output = await analyzer.runStage1(
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
    const stage1ActualMs = Date.now() - stage1Start;
    /* Use the observed rate to refine stage 2's estimate. Stage 2 prompt is
       a similar size to stage 1 plus the small character roster, but its
       output is much larger (one JSON entry per sentence), hence the
       stretch factor. */
    stage2EstMs = clampEst(stage1ActualMs * STAGE2_STRETCH);
    log(0, `Detected ${stage1.characters.length} characters: ${stage1.characters.map(c => c.name).join(', ')}`);
    log(0, `${stage1.chapters.length} chapter${stage1.chapters.length === 1 ? '' : 's'} identified in ${humanSeconds(stage1ActualMs)}`);
    send({ kind: 'phase', phaseId: 0, progress: 1, label: PHASES[0].label });

    /* ── Phase 1: parsing and attribution (handoff stage 2). */
    markPhase(1);
    send({ kind: 'phase', phaseId: 1, progress: 0.02, label: PHASES[1].label });
    log(1, `Asking ${analyzerLabel} to attribute every sentence…`);
    log(1, `Estimated stage time: ~${humanSeconds(stage2EstMs)} (based on stage 1 rate)`);
    const stage2 = await analyzer.runStage2(
      manuscriptId,
      buildStage2Inbox(manuscriptId, record.title, stage1, record.chapterHints),
      {
        onWaiting: (elapsed) => {
          const p = Math.min(0.02 + 0.93 * (elapsed / stage2EstMs), 0.95);
          send({ kind: 'phase', phaseId: 1, progress: p, label: PHASES[1].label });
        },
      },
    );
    log(1, `Attributed ${stage2.sentences.length.toLocaleString()} sentences across ${stage1.chapters.length} chapters`);
    /* Per-character line counts, sorted by lines descending — most prominent first. */
    {
      const lineCounts = new Map<string, number>();
      for (const s of stage2.sentences) {
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
      stage2.sentences,
    );

    const totalElapsed = Date.now() - startedAt;
    const response = {
      bookId: bookIdFromTitle(record.title),
      manuscriptId,
      title: record.title,
      phaseTimings: PHASES.map(p => ({ id: p.id, label: p.label, duration: endPhase(p.id) || Math.round(totalElapsed / PHASES.length) })),
      characters,
      chapters,
      sentences: stage2.sentences,
      libraryMatches: [] as Array<{ characterId: string; voiceId: string; confidence: number }>,
    };

    send({ kind: 'result', response });
    res.end();
  } catch (e) {
    console.error('[analysis] failed', e);
    send({ kind: 'error', message: (e as Error).message || 'Analysis failed.' });
    res.end();
  }
});
