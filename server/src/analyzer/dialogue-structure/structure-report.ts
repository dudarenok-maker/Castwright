import type { LanguageConventions } from './types.js';

/* Intake structure-quality signal: quantifies HOW degraded a chapter's
   paragraph structure is, so the silence of the current design is broken and a
   human can act at import time (flag the book, prompt for a better source)
   instead of the degradation being a silent confound in per-chapter metrics.

   The load-bearing number is the HIDDEN set — mid-paragraph dashes sitting in
   narration-open paragraphs (invisible to the paragraph-start engine) — split
   from the dashes already inside dash-open paragraphs (already recovered by the
   interior toggles). The evidenced subset of the hidden set is the ceiling of
   what gated recovery (paragraph-recovery.ts) can sensibly restore. */

const DASH = /(?:&mdash;|&ndash;|[-–—])/;

export interface ParagraphStructureReport {
  paragraphCount: number;
  pctCharsInLongParas: number; // >500 chars
  pctCharsInVeryLongParas: number; // >1500 chars
  largestParagraphChars: number;
  paraInitialDashes: number;
  /** dashes inside narration-open paragraphs — the genuinely hidden/lost set */
  hiddenDashes: number;
  /** hidden dashes preceded by sentence-end — the weak-signal turn candidates */
  hiddenTurnCandidates: number;
  /** ratio of the hidden set to all dashes (0..1); 0 = clean structure */
  hiddenFraction: number;
}

/** Assess one chapter body. `hiddenFraction` near 0 = intact; high = degraded. */
export function assessParagraphStructure(body: string, conv: LanguageConventions): ParagraphStructureReport {
  const paras = body.split(/\r?\n\r?\n/).filter((p) => p.trim().length > 0);
  const lens = paras.map((p) => p.length);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const over500 = lens.filter((l) => l > 500).reduce((a, b) => a + b, 0);
  const over1500 = lens.filter((l) => l > 1500).reduce((a, b) => a + b, 0);

  let paraInitialDashes = 0;
  let hiddenDashes = 0;
  let hiddenTurnCandidates = 0;
  let totalDashes = 0;

  for (const p of paras) {
    const startsDialogue = !!conv.dialogueOpen?.test(p);
    if (startsDialogue) paraInitialDashes++;
    const dashes = [...p.matchAll(new RegExp(DASH.source, 'g'))];
    if (startsDialogue) {
      // first dash is the paragraph-leading dash (already visible); the rest are
      // interior toggles the parser handles — not hidden.
      let first = true;
      for (const _ of dashes) {
        totalDashes++;
        if (first) { first = false; continue; }
      }
      continue;
    }
    // narration-open paragraph: NO leading dash, so every dash is hidden.
    for (const m of dashes) {
      totalDashes++;
      hiddenDashes++;
      const before = p.slice(Math.max(0, m.index! - 6), m.index!);
      if (/([.!?…]|\.{3})\s*$/u.test(before)) hiddenTurnCandidates++;
    }
  }

  const hiddenFraction = totalDashes > 0 ? hiddenDashes / totalDashes : 0;
  return {
    paragraphCount: paras.length,
    pctCharsInLongParas: Math.round((over500 / total) * 100),
    pctCharsInVeryLongParas: Math.round((over1500 / total) * 100),
    largestParagraphChars: lens.length ? Math.max(...lens) : 0,
    paraInitialDashes,
    hiddenDashes,
    hiddenTurnCandidates,
    hiddenFraction,
  };
}