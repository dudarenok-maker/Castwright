import type { LangNormalizer } from './types.js';
import { en } from './lang/en.js';
import { es } from './lang/es.js';
import { ru } from './lang/ru.js';

const REGISTRY: Record<string, LangNormalizer> = { en, es, ru };

export function getNormalizer(langCode: string): LangNormalizer | undefined {
  return REGISTRY[langCode];
}
