import type { LangNormalizer } from './types.js';
import { en } from './lang/en.js';

const REGISTRY: Record<string, LangNormalizer> = { en };

export function getNormalizer(langCode: string): LangNormalizer | undefined {
  return REGISTRY[langCode];
}
