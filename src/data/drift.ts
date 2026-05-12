import type { DriftEvent } from '../lib/types';

export const VOICE_DRIFT_EVENTS: DriftEvent[] = [
  {
    id: 'd1', characterId: 'eliza', chapterId: 7,
    severity: 'severe', factor: 'register',
    factorLabel: 'Vocabulary register',
    description: "Eliza's register here doesn't match her established defiant working-class register from chapters 1–6. The chapter reads more formal — likely an artefact of recent manuscript edits.",
    metrics: { current: 32, expected: 65, unit: 'informality' },
    detected: '2 hr ago', suggestedAction: 'regenerate_chapter',
  },
  {
    id: 'd2', characterId: 'halloran', chapterId: 5,
    severity: 'moderate', factor: 'pace',
    factorLabel: 'Pace',
    description: "22% faster than character average. Halloran's hallmark slow command feels rushed in this chapter.",
    metrics: { current: 188, expected: 154, unit: 'words / min' },
    detected: '1 hr ago', suggestedAction: 'regenerate_chapter',
  },
  {
    id: 'd3', characterId: 'marcus', chapterId: 4,
    severity: 'mild', factor: 'warmth',
    factorLabel: 'Warmth',
    description: "Slightly cooler than Marcus's profile. Within tolerance — worth a listen if the chapter sounds off.",
    metrics: { current: 68, expected: 80, unit: 'warmth score' },
    detected: '30 min ago', suggestedAction: 'review',
  },
];
