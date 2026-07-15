import type { NeedsAnswer } from '../../lib/api';

export const NEEDS_QUESTION = 'Do you want expressive and/or multilingual audio?';

export function needsAnswerLabel(answer: NeedsAnswer): string {
  return answer === 'expressive-or-multilingual'
    ? 'Yes — expressive and/or non-English'
    : 'No — simple English narration';
}

export const RECOMMENDED_BADGE = 'Recommended for you';

const DISPLAY: Record<'kokoro' | 'qwen' | 'coqui', string> = {
  kokoro: 'Kokoro',
  qwen: 'Qwen3-TTS',
  coqui: 'Coqui XTTS v2',
};
export function engineDisplayName(id: 'kokoro' | 'qwen' | 'coqui'): string {
  return DISPLAY[id];
}
