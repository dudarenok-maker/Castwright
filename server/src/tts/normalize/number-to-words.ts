import type { LangNormalizer } from './types.js';
import { en } from './lang/en.js';
import { es } from './lang/es.js';
import { ru } from './lang/ru.js';
import { fr } from './lang/fr.js';
import { de } from './lang/de.js';

const REGISTRY: Record<string, LangNormalizer> = { en, es, ru, fr, de };

export function getNormalizer(langCode: string): LangNormalizer | undefined {
  return REGISTRY[langCode];
}
