export type EvidenceFamily =
  | 'tag' | 'pronoun' | 'alternation' | 'unanchored' | 'narration' | 'lumped' | 'unaligned' | 'other';

export function evidenceFamily(reason: string): EvidenceFamily {
  if (reason.startsWith('tag-')) return 'tag';
  if (reason.startsWith('pronoun-')) return 'pronoun';
  if (reason.startsWith('alt-')) return 'alternation';
  if (reason.startsWith('unanchored')) return 'unanchored';
  if (reason.startsWith('narration')) return 'narration';
  if (reason === 'lumped') return 'lumped';
  if (reason === 'unaligned') return 'unaligned';
  return 'other';
}
