import type { LangNormalizer } from './types.js';
import { en } from './lang/en.js';
import { es } from './lang/es.js';

const REGISTRY: Record<string, LangNormalizer> = { en, es };

export function getNormalizer(langCode: string): LangNormalizer | undefined {
  return REGISTRY[langCode];
}
