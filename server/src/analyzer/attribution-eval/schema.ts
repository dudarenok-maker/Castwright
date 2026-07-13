import { z } from 'zod';

export const LabelledChapterSchema = z.object({
  chapterText: z.string(),
  lines: z.array(
    z.object({
      text: z.string(),
      speakerId: z.string(),
    })
  ),
});

export type LabelledChapter = z.infer<typeof LabelledChapterSchema>;

export function parseLabelledChapter(json: unknown): LabelledChapter {
  return LabelledChapterSchema.parse(json);
}
