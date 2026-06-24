import type { LangNormalizer } from './types.js';
import { en } from './lang/en.js';
import { es } from './lang/es.js';
import { ru } from './lang/ru.js';
import { fr } from './lang/fr.js';

const REGISTRY: Record<string, LangNormalizer> = { en, es, ru, fr };

export function getNormalizer(langCode: string): LangNormalizer | undefined {
  return REGISTRY[langCode];
}
