import type { AnalysisPhase } from '../lib/types';

export const ANALYSIS_PHASES: AnalysisPhase[] = [
  { id: 0, label: 'Detecting characters',    detail: 'Named-entity extraction, dialogue attribution, speaker resolution.',         duration: 2200 },
  { id: 1, label: 'Parsing and attribution', detail: 'Splitting chapters into sentences and labelling each with its speaker.',     duration: 2400 },
  { id: 2, label: 'Matching library',        detail: 'Reconciling against voices from your previous books.',                       duration: 1500 },
];
