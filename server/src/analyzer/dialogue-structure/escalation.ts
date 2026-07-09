import type { SentenceOutput } from '../../handoff/schemas.js';
import type { Analyzer, StageCall } from '../index.js';
import type { ParagraphEvidence } from './types.js';
import { alignSentences, type AlignedSentence } from './aligner.js';

/* srv-59 Task 9b (spec §5.4). Second-pass re-query of the conversation
   windows crossExamine (Task 7) flagged as unresolved. Pure orchestration
   over the escalation analyzer primitive (Task 9): groups flagged dialogue
   lines by conversation window, builds a small plain-text prompt per
   window, and applies an accepted answer back onto `sentences` — subject
   to the one hard invariant carried over from cross-examine: a `tag-name`
   attribution is NEVER overridden, by this pass or any other.

   `sentences`/`flags` are MUTATED in place (accepted answers rewrite a
   sentence's characterId/confidence and remove its flag entry) — the same
   shared-mutation contract crossExamine's caller already relies on. */

export interface EscalationOutcome {
  /** conversation windows actually queried (budget-consuming). */
  attempted: number;
  /** individual flagged lines whose model answer was accepted and applied. */
  applied: number;
}

export interface EscalateFlaggedWindowsOpts {
  /** MUTATED in place: an accepted assignment rewrites characterId/confidence. */
  sentences: SentenceOutput[];
  /** MUTATED in place: an accepted assignment's entry is removed. */
  flags: Array<{ index: number; reason: string }>;
  paras: ParagraphEvidence[];
  body: string;
  analyzer: Analyzer;
  manuscriptId: string;
  chapterId: number;
  stageCall: StageCall;
  rosterIds: Set<string>;
  /** mutable, shared across every chapter of the same book — decremented
      by 1 per window actually queried, regardless of outcome. */
  budget: { remainingWindows: number };
  maxWindowsPerChapter: number;
}

const ESCALATED_CONFIDENCE = 0.8;
const MAX_WINDOW_CHARS = 1500;
const MAX_CONTEXT_PARAS = 2;
/** Mirrors windows.ts's NARRATION_BREAK_LENGTH: a narration paragraph this
    long or longer is a real digression, not "short" context. */
const SHORT_NARRATION_MAX_LEN = 200;

interface WindowGroup {
  windowId: number;
  /** indices into `sentences`/the alignment, ascending. */
  memberIdx: number[];
}

function isShortNarration(p: ParagraphEvidence): boolean {
  return p.kind === 'narration' && p.end - p.start < SHORT_NARRATION_MAX_LEN;
}

/** Every dialogue paragraph carrying a speech span stamped with this
    windowId (resolveWindows stamps the whole window's paragraphs in one
    pass, so every speech span in a window paragraph shares its windowId). */
function paragraphsInWindow(paras: ParagraphEvidence[], windowId: number): number[] {
  const idxs: number[] = [];
  paras.forEach((p, i) => {
    if (p.kind === 'dialogue' && p.spans.some((s) => s.kind === 'speech' && s.windowId === windowId)) {
      idxs.push(i);
    }
  });
  return idxs;
}

/** Build the window's paragraph-index list (core + up to 2 short-narration
    paragraphs of context each side), then the marker-annotated text, capped
    at MAX_WINDOW_CHARS. Markers are stamped at the START of a paragraph —
    one `>>id<<` per flagged member whose aligned span falls in that
    paragraph (join order stays the paragraphs' natural order). */
function buildWindowText(
  paras: ParagraphEvidence[],
  body: string,
  windowId: number,
  memberIdx: number[],
  sentences: SentenceOutput[],
  aligned: AlignedSentence[],
): { text: string; participantIds: string[] } {
  const corePara = paragraphsInWindow(paras, windowId);
  const firstPara = Math.min(...corePara);
  const lastPara = Math.max(...corePara);

  // markersByPara: paragraph index -> line ids to stamp at its start.
  const markersByPara = new Map<number, number[]>();
  for (const idx of memberIdx) {
    const span = aligned[idx].spans.find((s) => s.kind === 'speech');
    if (!span) continue;
    const pIdx = corePara.find((k) => paras[k].start <= span.start && span.start < paras[k].end);
    if (pIdx === undefined) continue;
    const list = markersByPara.get(pIdx) ?? [];
    list.push(sentences[idx].id);
    markersByPara.set(pIdx, list);
  }

  const renderPara = (pIdx: number): string => {
    const markers = markersByPara.get(pIdx) ?? [];
    const prefix = markers.map((id) => `>>${id}<<`).join('') + (markers.length ? ' ' : '');
    return prefix + body.slice(paras[pIdx].start, paras[pIdx].end);
  };

  let selected = [...corePara];
  let text = selected.map(renderPara).join('\n');

  if (text.length <= MAX_WINDOW_CHARS) {
    // Greedily add short-narration context, nearest paragraph first each
    // side, only while it keeps the total under budget.
    for (let n = 1; n <= MAX_CONTEXT_PARAS; n++) {
      const k = firstPara - n;
      if (k < 0 || !isShortNarration(paras[k])) break;
      const candidate = [k, ...selected].map(renderPara).join('\n');
      if (candidate.length > MAX_WINDOW_CHARS) break;
      selected = [k, ...selected];
      text = candidate;
    }
    for (let n = 1; n <= MAX_CONTEXT_PARAS; n++) {
      const k = lastPara + n;
      if (k >= paras.length || !isShortNarration(paras[k])) break;
      const candidate = [...selected, k].map(renderPara).join('\n');
      if (candidate.length > MAX_WINDOW_CHARS) break;
      selected = [...selected, k];
      text = candidate;
    }
  } else {
    // Core dialogue alone already exceeds the cap. Blindly slicing the
    // joined string from the front can land entirely inside one oversized
    // paragraph and silently drop every marker after it — instead, cap each
    // paragraph to an equal share of the budget so every paragraph (and any
    // marker stamped at its start) survives, just with its body truncated.
    const perParaBudget = Math.max(1, Math.floor((MAX_WINDOW_CHARS - (selected.length - 1)) / selected.length));
    text = selected.map((pIdx) => renderPara(pIdx).slice(0, perParaBudget)).join('\n');
  }

  const participantIds = new Set<string>();
  for (const pIdx of corePara) {
    for (const span of paras[pIdx].spans) {
      if (span.kind === 'speech' && span.windowId === windowId && span.speaker) {
        participantIds.add(span.speaker.characterId);
      }
    }
  }
  for (const idx of memberIdx) participantIds.add(sentences[idx].characterId);

  return { text, participantIds: [...participantIds] };
}

function buildPrompt(windowText: string, memberCount: number, participantIds: string[], rosterIds: Set<string>): string {
  return (
    `You are resolving speaker attribution for ${memberCount} marked dialogue lines.\n` +
    `Characters present (ids): ${participantIds.join(', ')} — full roster ids: ${[...rosterIds].join(', ')}.\n` +
    `Reply with ONLY JSON: {"assignments":[{"line":<number>,"characterId":"<roster id>"}]}.\n` +
    `Text (>>N<< marks the lines to resolve):\n${windowText}`
  );
}

export async function escalateFlaggedWindows(opts: EscalateFlaggedWindowsOpts): Promise<EscalationOutcome> {
  const outcome: EscalationOutcome = { attempted: 0, applied: 0 };
  if (opts.flags.length === 0) return outcome;

  const alignment = alignSentences(opts.sentences, opts.paras, opts.body);

  // Group escalatable flags (a speech span with a windowId) by windowId,
  // in the order their windowId is first encountered.
  const groups: WindowGroup[] = [];
  const groupByWindowId = new Map<number, WindowGroup>();
  for (const flag of opts.flags) {
    const as = alignment.aligned[flag.index];
    const span = as?.spans.find((s) => s.kind === 'speech');
    if (!span || span.windowId === undefined) continue; // not a resolvable dialogue window
    let group = groupByWindowId.get(span.windowId);
    if (!group) {
      group = { windowId: span.windowId, memberIdx: [] };
      groupByWindowId.set(span.windowId, group);
      groups.push(group);
    }
    group.memberIdx.push(flag.index);
  }

  let perChapterRemaining = opts.maxWindowsPerChapter;

  for (const group of groups) {
    if (opts.budget.remainingWindows <= 0 || perChapterRemaining <= 0) break;

    const memberIdx = [...group.memberIdx].sort((a, b) => a - b);
    const { text: windowText, participantIds } = buildWindowText(
      opts.paras,
      opts.body,
      group.windowId,
      memberIdx,
      opts.sentences,
      alignment.aligned,
    );
    const prompt = buildPrompt(windowText, memberIdx.length, participantIds, opts.rosterIds);

    opts.budget.remainingWindows -= 1;
    perChapterRemaining -= 1;
    outcome.attempted += 1;

    const response = await opts.analyzer.runAttributionEscalation(
      opts.manuscriptId,
      opts.chapterId,
      prompt,
      opts.stageCall,
    );
    if (!response) continue; // empty/blocked/unparseable — skip, flags stay intact

    // A model that returns the same `line` twice in one reply must only
    // count/apply once — the second occurrence is a no-op, not a re-count.
    const appliedIdx = new Set<number>();
    for (const assignment of response.assignments) {
      const idx = memberIdx.find((i) => opts.sentences[i].id === assignment.line);
      if (idx === undefined) continue; // not one of this window's marked lines
      if (appliedIdx.has(idx)) continue; // duplicate line entry — no-op
      if (!opts.rosterIds.has(assignment.characterId)) continue;

      const as = alignment.aligned[idx];
      const hasTagName = as.spans.some((s) => s.kind === 'speech' && s.speaker?.source === 'tag-name');
      if (hasTagName) continue; // never override tag-name — the one hard invariant

      opts.sentences[idx].characterId = assignment.characterId;
      opts.sentences[idx].confidence = ESCALATED_CONFIDENCE;
      const flagPos = opts.flags.findIndex((f) => f.index === idx);
      if (flagPos !== -1) opts.flags.splice(flagPos, 1);
      appliedIdx.add(idx);
      outcome.applied += 1;
    }
  }

  return outcome;
}
