import { z } from 'zod';

export const RosterSnapshotSchema = z.object({
  characters: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      gender: z.enum(['male', 'female', 'neutral']).optional(),
      aliases: z.array(z.string()).optional(),
      canonicalId: z.string().optional(),
    })
  ),
});

export type RosterSnapshot = z.infer<typeof RosterSnapshotSchema>;

export function parseRosterSnapshot(json: unknown): RosterSnapshot {
  return RosterSnapshotSchema.parse(json);
}
