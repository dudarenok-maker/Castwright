import { z } from 'zod';

export const LabelledChapterSchema = z.object({
  chapterText: z.string(),
  lines: z.array(
    z.object({
      text: z.string(),
      speakerId: z.string(),
    })
  ),
  // Optional cross-chapter opener context for the script-review pass (Task 8
  // capture). Pinned to the route's PriorExchange shape so the fixture value
  // threads straight into runReviewOverChapter.
  priorExchange: z
    .object({
      turns: z.array(
        z.object({ speakerId: z.string(), speakerName: z.string(), text: z.string() })
      ),
    })
    .optional(),
});

export type LabelledChapter = z.infer<typeof LabelledChapterSchema>;

export function parseLabelledChapter(json: unknown): LabelledChapter {
  return LabelledChapterSchema.parse(json);
}
