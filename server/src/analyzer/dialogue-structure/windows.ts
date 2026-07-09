import type { ParagraphEvidence, SpanEvidence } from './types.js';

/* Spec §5.2 (Task 5). A window is a run of contiguous dialogue paragraphs;
   short narration doesn't split it, a long one does — conversations don't
   survive a real narrative digression. Ambiguous cases (pronoun gender not
   unique, alternation parity conflicting with an anchored turn, 3+ speaker
   windows) are left unanchored rather than guessed: same "flag, never
   fabricate" invariant as the parser. Pure: no I/O, no model calls. */

export type WindowRoster = Record<string, 'male' | 'female' | 'neutral'>;

/** A narration paragraph at/over this length breaks a window; shorter ones
    (a beat, a one-line aside) don't. */
const NARRATION_BREAK_LENGTH = 200;

type PendingSpan = SpanEvidence & { pendingPronoun?: 'first' | 'male' | 'female' };

function speechSpansOf(paragraph: ParagraphEvidence): SpanEvidence[] {
  return paragraph.spans.filter((s) => s.kind === 'speech');
}

/** Group paragraphs into windows: a maximal run of dialogue paragraphs,
    tolerating short narration paragraphs in between (they're skipped, not
    included in any window) but ending the window at a long one. */
function groupWindows(paras: ParagraphEvidence[]): ParagraphEvidence[][] {
  const windows: ParagraphEvidence[][] = [];
  let current: ParagraphEvidence[] = [];
  for (const p of paras) {
    if (p.kind === 'dialogue') {
      current.push(p);
      continue;
    }
    if (p.end - p.start >= NARRATION_BREAK_LENGTH && current.length) {
      windows.push(current);
      current = [];
    }
    // short narration: doesn't break the window and isn't part of it either
  }
  if (current.length) windows.push(current);
  return windows;
}

/** Resolve `pendingPronoun` speech spans within one window, then fill any
    still-unanchored turns by A/B/A/B parity in a clean two-party window. */
function resolveWindow(speech: SpanEvidence[], roster: WindowRoster, firstPersonId: string | null): void {
  // Participants at window entry: the distinct speakers already anchored by
  // a name-bearing tag. Pronoun resolution grows this set as it resolves;
  // alternation reads the final anchored set, never the raw participant one.
  const participants = new Set<string>();
  for (const s of speech) if (s.speaker) participants.add(s.speaker.characterId);

  for (const s of speech) {
    const pending = (s as PendingSpan).pendingPronoun;
    if (!pending || s.speaker) continue;
    if (pending === 'first') {
      if (firstPersonId) {
        s.speaker = { characterId: firstPersonId, source: 'tag-pronoun' };
        participants.add(firstPersonId);
      }
      continue;
    }
    const matches = [...participants].filter((id) => roster[id] === pending);
    if (matches.length === 1) {
      s.speaker = { characterId: matches[0], source: 'tag-pronoun' };
      participants.add(matches[0]);
    }
    // zero or multiple gender-compatible participants: ambiguous, leave unanchored
  }

  const anchoredIds = new Set(speech.filter((s) => s.speaker).map((s) => s.speaker!.characterId));
  if (anchoredIds.size !== 2) return; // no alternation fill outside a clean two-party window

  const [a, b] = [...anchoredIds];
  const firstAnchorIndex = speech.findIndex((s) => s.speaker);
  const firstAnchorId = speech[firstAnchorIndex].speaker!.characterId;
  const evenId = firstAnchorIndex % 2 === 0 ? firstAnchorId : firstAnchorId === a ? b : a;
  const oddId = evenId === a ? b : a;
  const expectedFor = (i: number): string => (i % 2 === 0 ? evenId : oddId);

  const consistent = speech.every((s, i) => !s.speaker || s.speaker.characterId === expectedFor(i));
  if (!consistent) return; // an anchored turn disagrees with the alternation parity: never force a guess

  for (const [i, s] of speech.entries()) {
    if (!s.speaker) s.speaker = { characterId: expectedFor(i), source: 'alternation' };
  }
}

/** Stamp `windowId`/`turnIndex` on every speech span, resolve `pendingPronoun`
    spans, and fill clean two-party turns by alternation. Mutates `paras` in
    place and returns the same array. */
export function resolveWindows(
  paras: ParagraphEvidence[],
  roster: WindowRoster,
  firstPersonId: string | null,
): ParagraphEvidence[] {
  const windows = groupWindows(paras);
  for (const [windowId, window] of windows.entries()) {
    const speech = window.flatMap(speechSpansOf);
    speech.forEach((s, turnIndex) => {
      s.windowId = windowId;
      s.turnIndex = turnIndex;
    });
    resolveWindow(speech, roster, firstPersonId);
  }
  return paras;
}
