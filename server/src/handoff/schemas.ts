/* Zod schemas validating the JSON drops produced by the cowork skills.
   Shapes mirror the OpenAPI Character / Chapter / Sentence definitions. */

import { z } from 'zod';

export const toneSchema = z
  .object({
    warmth: z.number().int().min(0).max(100).optional(),
    pace: z.number().int().min(0).max(100).optional(),
    authority: z.number().int().min(0).max(100).optional(),
    emotion: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const evidenceSchema = z
  .object({
    quote: z.string(),
    note: z.string().optional(),
  })
  .strict();

export const characterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    color: z.string().min(1),
    lines: z.number().int().nonnegative().optional(),
    scenes: z.number().int().nonnegative().optional(),
    attributes: z.array(z.string()).optional(),
    /* Alternate names for this character, accumulated when the user merges
     a duplicate roster entry. Persisted for the voice matcher to pick up
     the same person across books in a series. */
    aliases: z.array(z.string()).optional(),
    /* Cross-book pairs this character has been explicitly marked as NOT
     the same person — e.g. teenage Sophie vs adult Sophie. Written
     symmetrically by POST /:bookId/cast/:characterId/not-linked-to.
     Optional + additive so older cast.json files keep validating. Plan 101. */
    notLinkedTo: z
      .array(
        z
          .object({
            bookId: z.string().min(1),
            characterId: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    tone: toneSchema.optional(),
    /* Optional voice-shaping hints. The skill prompt asks for these so the
     TTS picker doesn't have to scrape pronouns out of the description. Kept
     optional so previously cached analyses still validate. */
    gender: z.enum(['male', 'female', 'neutral']).optional(),
    ageRange: z.enum(['child', 'teen', 'adult', 'elderly']).optional(),
    description: z.string().optional(),
    /* Natural-language voice-design persona (plan 108). Generated per
       character by Gemini from the full profile + dialogue evidence and
       editable by the user; seeds the Qwen sidecar's bespoke voice-design
       flow. Optional + additive so existing cast.json files keep
       validating. */
    voiceStyle: z.string().optional(),
    evidence: z.array(evidenceSchema).optional(),
    voiceState: z.enum(['generated', 'tuned', 'reused', 'locked']).optional(),
    matchedFrom: z
      .object({
        bookTitle: z.string(),
        confidence: z.number().min(0).max(1),
      })
      .nullable()
      .optional(),
    /* How Phase 0a found this character. `'dialogue'` (default): the analyzer
       observed a verbatim utterance attributed to them. `'narrator-mention'`:
       the analyzer saw them named by narration with a role/relationship
       marker ("his bodyguard, Grizel"; "Sandor, Sophie's goblin bodyguard")
       but no quoted dialogue. The minor-cast fold treats these differently
       — narrator-mention entries with a protected role survive the
       <3-lines threshold so canonical-but-rarely-quoted characters
       (bodyguards / mentors / family) stay on the roster instead of being
       silently bucketed into unknown-male/unknown-female. Field is
       optional + additive: existing analyses lack it (undefined treated
       as 'dialogue' by the fold). */
    detectionSource: z.enum(['dialogue', 'narrator-mention']).optional(),
  })
  .strict();

export const chapterStub = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
});

export const stage1Schema = z
  .object({
    characters: z.array(characterSchema).min(1),
    chapters: z.array(chapterStub).min(1),
  })
  .strict();

/* Per-chapter cast detection (Phase 0a). The route loops over chapters,
   each call returns the characters that appear in THIS chapter (new +
   recurring); the route merges them into a running roster and emits a
   `cast-update` SSE event after each merge. No `chapters` field — the
   parser's chapter list is already authoritative. */
export const stage1ChapterSchema = z
  .object({
    characters: z.array(characterSchema),
  })
  .strict();

export const sentenceSchema = z
  .object({
    id: z.number().int().positive(),
    chapterId: z.number().int().positive(),
    characterId: z.string().min(1),
    text: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const stage2Schema = z
  .object({
    sentences: z.array(sentenceSchema).min(1),
  })
  .strict();

/* Stage 2 now runs per-chapter — same shape, narrower scope. The route loops
   over chapters and concatenates the per-chapter sentence arrays. Keeping
   `stage2Schema` for backwards compat with any callers that still want the
   whole-manuscript shape (none today). */
export const stage2ChapterSchema = stage2Schema;

export type Stage1Output = z.infer<typeof stage1Schema>;
export type Stage1ChapterOutput = z.infer<typeof stage1ChapterSchema>;
export type Stage2Output = z.infer<typeof stage2Schema>;
export type Stage2ChapterOutput = z.infer<typeof stage2ChapterSchema>;
export type CharacterOutput = z.infer<typeof characterSchema>;
export type SentenceOutput = z.infer<typeof sentenceSchema>;
