import type { CharacterOutput } from '../handoff/schemas.js';
import { normaliseForMatch } from '../util/text-match.js';

/** Combine `incoming` into `existing` in place — the exact field logic
    mergeRosterChapter uses, factored out so the dedup pass agrees with it. */
export function mergeCharacterFields(existing: CharacterOutput, incoming: CharacterOutput): void {
  if (incoming.description && (!existing.description || incoming.description.length > existing.description.length)) {
    existing.description = incoming.description;
  }
  if (incoming.tone) existing.tone = { ...existing.tone, ...incoming.tone };
  if (incoming.attributes?.length) {
    const seen = new Set(existing.attributes ?? []);
    const next = [...(existing.attributes ?? [])];
    for (const a of incoming.attributes) if (!seen.has(a)) { next.push(a); seen.add(a); }
    existing.attributes = next;
  }
  if (incoming.evidence?.length) {
    const seen = new Set((existing.evidence ?? []).map((e) => normaliseForMatch(e.quote)));
    const next = [...(existing.evidence ?? [])];
    for (const e of incoming.evidence) {
      const norm = normaliseForMatch(e.quote);
      if (norm.length > 0 && !seen.has(norm)) { next.push({ ...e }); seen.add(norm); }
    }
    existing.evidence = next;
  }
  if (!existing.gender && incoming.gender) existing.gender = incoming.gender;
  if (!existing.ageRange && incoming.ageRange) existing.ageRange = incoming.ageRange;
  const aliasCandidates = [incoming.name, ...(incoming.aliases ?? [])];
  const seen = new Set<string>([
    existing.name.trim().toLowerCase(),
    ...(existing.aliases ?? []).map((a) => a.trim().toLowerCase()),
  ]);
  const nextAliases = [...(existing.aliases ?? [])];
  for (const cand of aliasCandidates) {
    const key = cand.trim().toLowerCase();
    if (key.length > 0 && !seen.has(key)) { nextAliases.push(cand); seen.add(key); }
  }
  if (nextAliases.length) existing.aliases = nextAliases;
}
