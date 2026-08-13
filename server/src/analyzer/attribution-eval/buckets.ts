export type EvidenceFamily =
  | 'tag' | 'pronoun' | 'alternation' | 'unanchored' | 'narration'
  | 'dash-convention' | 'lumped' | 'unaligned' | 'other';

export function evidenceFamily(reason: string): EvidenceFamily {
  if (reason.startsWith('tag-')) return 'tag';
  if (reason.startsWith('pronoun-')) return 'pronoun';
  if (reason.startsWith('alt-')) return 'alternation';
  if (reason.startsWith('unanchored')) return 'unanchored';
  if (reason.startsWith('narration')) return 'narration';
  // #2253 — the dialogue-convention invariant: the language's turn marker
  // contradicted the (parser-degraded) structural evidence.
  if (reason.startsWith('dash-line-')) return 'dash-convention';
  if (reason === 'lumped') return 'lumped';
  if (reason === 'unaligned') return 'unaligned';
  return 'other';
}
