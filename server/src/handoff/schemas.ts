/* Zod schemas validating the JSON drops produced by the cowork skills.
   Shapes mirror the OpenAPI Character / Chapter / Sentence definitions. */

import { z } from 'zod';

export const toneSchema = z.object({
  warmth:    z.number().int().min(0).max(100).optional(),
  pace:      z.number().int().min(0).max(100).optional(),
  authority: z.number().int().min(0).max(100).optional(),
  emotion:   z.number().int().min(0).max(100).optional(),
}).strict();

export const evidenceSchema = z.object({
  quote: z.string(),
  note:  z.string().optional(),
}).strict();

export const characterSchema = z.object({
  id:          z.string().min(1),
  name:        z.string().min(1),
  role:        z.string().min(1),
  color:       z.string().min(1),
  lines:       z.number().int().nonnegative().optional(),
  scenes:      z.number().int().nonnegative().optional(),
  attributes:  z.array(z.string()).optional(),
  tone:        toneSchema.optional(),
  description: z.string().optional(),
  evidence:    z.array(evidenceSchema).optional(),
  voiceState:  z.enum(['generated', 'tuned', 'reused', 'locked']).optional(),
  matchedFrom: z.object({
    bookTitle:  z.string(),
    confidence: z.number().min(0).max(1),
  }).nullable().optional(),
}).strict();

export const chapterStub = z.object({
  id:    z.number().int().positive(),
  title: z.string().min(1),
});

export const stage1Schema = z.object({
  characters: z.array(characterSchema).min(1),
  chapters:   z.array(chapterStub).min(1),
}).strict();

export const sentenceSchema = z.object({
  id:          z.number().int().positive(),
  chapterId:   z.number().int().positive(),
  characterId: z.string().min(1),
  text:        z.string().min(1),
  confidence:  z.number().min(0).max(1).optional(),
}).strict();

export const stage2Schema = z.object({
  sentences: z.array(sentenceSchema).min(1),
}).strict();

export type Stage1Output = z.infer<typeof stage1Schema>;
export type Stage2Output = z.infer<typeof stage2Schema>;
export type CharacterOutput = z.infer<typeof characterSchema>;
export type SentenceOutput = z.infer<typeof sentenceSchema>;
