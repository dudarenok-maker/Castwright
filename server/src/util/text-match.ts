/* Text-normalization helpers shared by the evidence-verifier (analysis.ts)
   and the cross-book voice matcher (voice-match.ts). Kept in one place so
   typography drift (smart quotes, em-dashes, ellipses) is handled the same
   way everywhere. */

/** Strip leading and trailing characters matching `edge` (a single-char class)
    via a linear two-pointer scan. The trailing-anchored `[…]+$` regex form is
    polynomial-redos (per-start-position backtracking); a single-char `.test`
    per edge has no backtracking, so this is O(n). */
export function stripEdges(s: string, edge: RegExp): string {
  let a = 0,
    b = s.length;
  while (a < b && edge.test(s[a])) a++;
  while (b > a && edge.test(s[b - 1])) b--;
  return s.slice(a, b);
}

export function normaliseForMatch(s: string): string {
  return stripEdges(
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[—–]/g, '-')
      .replace(/…/g, '...'),
    /[\s"'`]/,
  ).replace(/\s+/g, ' ');
}

/** Strip trailing terminal-sentence punctuation (`.,;:!?`) from an already-
    normalised candidate quote. Used by the verifier's tier-2 match to
    bridge "model wrote `.`, source wrote `,` because a dialogue tag
    follows" — the dominant false-positive pattern on Gemini and the
    qwen3.5 family. */
export function stripTerminalSentencePunct(s: string): string {
  return s.replace(/[.,;:!?]+$/, '');
}

/** Split a normalised candidate quote into sentence-shaped segments on
    internal `[.!?]+` followed by whitespace; strip terminal punct from
    each. Segments shorter than `minLen` (default 8) are filtered out —
    fragments like "yeah" or "no" appear so often in any source that
    matching on them gives almost no evidence-of-authenticity signal. */
export function splitSentenceSegments(s: string, minLen = 8): string[] {
  return s
    .split(/[.!?]+\s+/)
    .map(stripTerminalSentencePunct)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length >= minLen);
}

/** Split on CLAUSE punctuation — comma / semicolon / colon as well as
    sentence-final `.!?` — followed by whitespace. Used as a looser fallback
    for the "interrupting dialogue tag" stitch: source writes
    `"If I douse the fire," Oduvan said, "I lose the weld..."` and the model
    returns the two halves rejoined by the comma the tag replaced, all within
    a SINGLE sentence — so splitSentenceSegments yields one fragment and can't
    fire. `minLen` is higher (default 12) than the sentence splitter because
    comma-delimited clauses are shorter and more common, so the floor guards
    against two unrelated short fragments coincidentally co-occurring. */
export function splitClauseSegments(s: string, minLen = 12): string[] {
  return s
    .split(/[,;:.!?]+\s+/)
    .map(stripTerminalSentencePunct)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length >= minLen);
}

export type QuoteMatchTier = 'verbatim' | 'terminal_punct' | 'segments';

/** Three-tier substring match for evidence quotes against an already-
    normalised source.

    1. **verbatim**       — pure `String.includes` on the normalised candidate.
    2. **terminal_punct** — retry after stripping trailing `.,;:!?`.
                            Handles the model writing `extinct.` where the
                            source has `extinct,` (closing comma before a
                            dialogue tag).
    3. **segments**       — split the candidate on sentence-final punctuation
                            and require EVERY surviving segment (≥ 8 chars,
                            and ≥ 2 segments overall) to appear in source.
                            Handles "stitched" dialogue where the model
                            joined two same-speaker utterances and dropped
                            the narration tag between them.

    Returns `null` when no tier passes — the verifier then drops the quote
    and the ledger records the reason. */
export function matchQuoteInSource(norm: string, normalisedSource: string): QuoteMatchTier | null {
  if (norm.length === 0) return null;
  if (normalisedSource.includes(norm)) return 'verbatim';

  const trimmed = stripTerminalSentencePunct(norm);
  if (trimmed.length > 0 && trimmed !== norm && normalisedSource.includes(trimmed)) {
    return 'terminal_punct';
  }

  const segments = splitSentenceSegments(norm);
  if (segments.length >= 2 && segments.every((seg) => normalisedSource.includes(seg))) {
    return 'segments';
  }

  /* Interrupting-tag fallback — split on clause punctuation so a stitch that
     happened MID-sentence (the dialogue tag interrupted one sentence rather
     than sitting between two) can still verify when every clause is a real
     contiguous run in the source. */
  const clauses = splitClauseSegments(norm);
  if (clauses.length >= 2 && clauses.every((seg) => normalisedSource.includes(seg))) {
    return 'segments';
  }

  return null;
}

/* Token set for fuzzy name matching: lowercase, split on whitespace + a few
   common name punctuation marks, drop single-letter tokens (initials,
   particles like "de", "le" that produce noisy matches across unrelated
   names). "Marlow Halden" → {marlow, halden}; "Marlow" → {marlow}; Jaccard of
   the two = 1/2. */
export function nameTokens(name: string): Set<string> {
  return new Set(
    normaliseForMatch(name)
      .split(/[\s\-_'.]+/)
      .filter((t) => t.length >= 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
