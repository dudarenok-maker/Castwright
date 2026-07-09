import type { LanguageConventions } from '../types.js';
import { ru } from './ru.js';
import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { de } from './de.js';

const TABLES: Record<string, LanguageConventions> = { ru, en, es, fr, de };

/** Normalizes 'ru-RU' → 'ru'. Returns null when the language has no table —
    callers treat null as "engine disabled, current behaviour". */
export function conventionsFor(language: string | undefined | null): LanguageConventions | null {
  if (!language) return null;
  return TABLES[language.toLowerCase().split(/[-_]/u)[0]] ?? null;
}
