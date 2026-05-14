/* Text-normalization helpers shared by the evidence-verifier (analysis.ts)
   and the cross-book voice matcher (voice-match.ts). Kept in one place so
   typography drift (smart quotes, em-dashes, ellipses) is handled the same
   way everywhere. */

export function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ');
}

/* Token set for fuzzy name matching: lowercase, split on whitespace + a few
   common name punctuation marks, drop single-letter tokens (initials,
   particles like "de", "le" that produce noisy matches across unrelated
   names). "Marlow Halden" → {Marlow, Halden}; "Marlow" → {Marlow}; Jaccard of
   the two = 1/2. */
export function nameTokens(name: string): Set<string> {
  return new Set(
    normaliseForMatch(name)
      .split(/[\s\-_'.]+/)
      .filter(t => t.length >= 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
