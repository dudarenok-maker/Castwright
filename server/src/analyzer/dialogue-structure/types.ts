export type EvidenceSource = 'tag-name' | 'tag-pronoun' | 'alternation' | 'unanchored';

export interface SpanEvidence {
  kind: 'speech' | 'tag' | 'narration';
  /** absolute offsets into the chapter body */
  start: number;
  end: number;
  /** set on speech spans only. `strength: 'weak'` marks a low-confidence
      tag-name (a beat-only quote-gap reclassification) that Wave 3 lets the
      model contest; absence = strong (the immutable tag-name invariant). */
  speaker?: { characterId: string; source: EvidenceSource; strength?: 'weak' };
  windowId?: number;
  turnIndex?: number;
}

export interface ParagraphEvidence {
  start: number;
  end: number;
  kind: 'dialogue' | 'narration';
  spans: SpanEvidence[];
}

export interface LanguageConventions {
  language: string;
  /** paragraph-start markers that open a dialogue paragraph (null = quote-only language) */
  dialogueOpen: RegExp | null;
  /** ordered open/close quote pairs for embedded speech */
  quotePairs: Array<[string, string]>;
  /** lowercase stems: a tag clause must contain one to count as a tag */
  speechVerbStems: string[];
  /** action-beat stems that also anchor a speaker ("— Да, — кивнул Антон") */
  beatVerbStems: string[];
  nameStemmer: (lowerToken: string) => string;
  minStemLength: number;
  pronouns: { firstPerson: RegExp | null; male: RegExp | null; female: RegExp | null };
  /** English-only opt-in: post-verb names preceded by one of these are the
      ADDRESSEE, not the speaker (`he said to Valkyrie`). PRESENCE of this field
      opts the language into subject-position tag resolution (findSubjectName);
      absence → legacy first-match (findRosterName), byte-identical. Closed set —
      never include `from`/`of` (they precede real inverted subjects). */
  addresseePrepositions?: string[];
  /** Coordinating conjunctions introducing a bystander clause after the verb
      (`a voice said and Valkyrie turned`). */
  tagClauseConjunctions?: string[];
}

export type DecisionBucket = 'confirmed' | 'corrected' | 'flagged' | 'lumped';

export interface EngineReport {
  language: string | null;
  alignedPct: number;
  confirmed: number;
  corrected: number;
  flagged: number;
  lumped: number;
  escalated: number;
  escalationAccepted: number;
  /** true when alignment fell below the floor and correction was disabled */
  flagOnly: boolean;
}
