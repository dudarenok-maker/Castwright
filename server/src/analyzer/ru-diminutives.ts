import { normaliseNameKey } from '../util/safe-id.js';

/* Curated Russian diminutive↔canonical groups. Each group is a set of name
   forms (canonical + diminutives) that denote the same given name. `multiGender`
   marks groups whose forms span male AND female canonicals (Саша→Александр/
   Александра) — those need a stricter gender gate downstream. NOT exhaustive;
   extend from real corpus data. NO transliteration, NO edit-distance. */
interface DimGroup {
  base: string;
  forms: string[];
  multiGender: boolean;
}

const GROUPS: DimGroup[] = [
  { base: 'ольга', forms: ['Ольга', 'Оля', 'Оленька'], multiGender: false },
  { base: 'софья', forms: ['Софья', 'Соня'], multiGender: false },
  { base: 'дмитрий', forms: ['Дмитрий', 'Дима', 'Митя'], multiGender: false },
  { base: 'екатерина', forms: ['Екатерина', 'Катя', 'Катюша'], multiGender: false },
  { base: 'михаил', forms: ['Михаил', 'Миша'], multiGender: false },
  { base: 'мария', forms: ['Мария', 'Маша', 'Маня'], multiGender: false },
  { base: 'антон', forms: ['Антон', 'Антоша'], multiGender: false },
  { base: 'светлана', forms: ['Светлана', 'Света'], multiGender: false },
  { base: 'борис', forms: ['Борис', 'Боря'], multiGender: false },
  { base: 'александр', forms: ['Александр', 'Александра', 'Саша', 'Саня', 'Шура'], multiGender: true },
  { base: 'евгений', forms: ['Евгений', 'Евгения', 'Женя'], multiGender: true },
  { base: 'валентин', forms: ['Валентин', 'Валентина', 'Валя'], multiGender: true },
  // …extend as real Russian books surface more (keep single-gender vs multiGender accurate).
];

const BY_KEY = new Map<string, { base: string; multiGender: boolean }>();
for (const g of GROUPS) {
  for (const f of g.forms) {
    BY_KEY.set(normaliseNameKey(f), { base: g.base, multiGender: g.multiGender });
  }
}

/** Canonical base for a name if it is a known canonical or diminutive; else null. */
export function diminutiveCanonical(name: string): { base: string; multiGender: boolean } | null {
  return BY_KEY.get(normaliseNameKey(name)) ?? null;
}
