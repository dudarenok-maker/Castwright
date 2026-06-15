/* Collapses the per-book series-cast roster into one entry per unique
   character before it is fed to the Phase 0a per-chapter prompt and
   surfaced in the analysing view's "Carried in from prior books in this
   series" pill.

   The producer (scanSeriesCharacters) emits one record per character
   per prior book in the same (author, series) — so a regular like
   Wren Sparrow contributes N rows across N prior books. The pill's
   count and the prompt both want unique characters, not raw rows.

   The Profile Drawer's manual continuity-link picker
   (server/src/routes/series-roster.ts) DOES want the per-book list
   (the user picks a specific source-book entry to fold a duplicate
   into), so dedup runs at the analyser route only — not in the
   producer.

   Match rule mirrors the prompt template's own description
   (server/src/routes/analysis.ts: "match by name or alias
   (case-insensitive, ignoring punctuation)"): two records merge if
   their normalised name OR any normalised alias overlaps. Implemented
   as union-find so alias chains link transitively across books (Book A
   stores name "Wren", Book B stores alias "Wren Sparrow" on a
   character named "Foster" — both should collapse into one group). */

import type { LibraryCharacterRecord } from './library-cast-scan.js';
import { normaliseNameKey } from '../util/safe-id.js';

export interface DedupedSeriesPriorEntry {
  id: string;
  name?: string;
  aliases?: string[];
  /** Carried for parity with the SeriesPriorCharacter shape consumed by
      the Phase 0a prompt. LibraryCastCharacter has no `description`
      field today (library-cast-scan strips it), so this is reserved for
      a future per-character bio without forcing a downstream rename. */
  description?: string;
  /** Ordered, de-duplicated list of every prior-book title that
      contributed a record to this merged entry. The Phase 0a prompt
      renders this as provenance so the model can disambiguate when a
      character spans multiple sibling books. */
  fromBookTitles?: string[];
}

/* Plan 219: shared Unicode-exact key — preserves Cyrillic (was `[^a-z0-9]`,
   which erased it → no cross-book dedup for non-Latin casts). */
function normaliseToken(s: string | undefined): string {
  return normaliseNameKey(s);
}

/* Collect every token that identifies a record — its name plus each
   alias, all normalised. Empty/whitespace-only entries are dropped so
   they don't act as false bridges between unrelated characters. */
function tokensFor(record: LibraryCharacterRecord): string[] {
  const out: string[] = [];
  const n = normaliseToken(record.character.name);
  if (n) out.push(n);
  for (const a of record.character.aliases ?? []) {
    const t = normaliseToken(a);
    if (t) out.push(t);
  }
  return out;
}

export function dedupSeriesPrior(
  records: LibraryCharacterRecord[],
): DedupedSeriesPriorEntry[] {
  if (records.length === 0) return [];

  /* Union-find over record indices. Two records share a root when any
     of their normalised tokens collide. */
  const parent = records.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    /* Path compression. */
    let cur = i;
    while (parent[cur] !== r) {
      const next = parent[cur];
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    /* Lower index wins as root so first-occurrence wins the group key
       at the end — deterministic and stable across runs. */
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  /* First pass: every token → first record index that produced it.
     Subsequent records sharing that token union into the same group. */
  const tokenOwner = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    for (const tok of tokensFor(records[i])) {
      const prior = tokenOwner.get(tok);
      if (prior === undefined) {
        tokenOwner.set(tok, i);
      } else {
        union(prior, i);
      }
    }
  }

  /* Second pass: walk records in original order; the first record in
     each group becomes the canonical entry. Subsequent records merge
     their aliases + bookTitle into it. Keeping original-order walks
     preserves deterministic id/name picks: oldest book in the scan
     wins. */
  const grouped = new Map<number, DedupedSeriesPriorEntry>();
  /* Track per-group alias tokens so unions don't reintroduce dups. */
  const aliasTokensByGroup = new Map<number, Set<string>>();
  /* Track per-group bookTitles likewise so the same book name only
     appears once even if a book has two cast rows that merged. */
  const bookTitlesByGroup = new Map<number, Set<string>>();

  for (let i = 0; i < records.length; i++) {
    const root = find(i);
    const rec = records[i];
    const char = rec.character;
    if (!grouped.has(root)) {
      /* Canonical entry — first record in this group. */
      const aliases: string[] = [];
      const aliasTokens = new Set<string>();
      /* Skip a name-equal alias on the canonical entry; redundant for
         the model and inflates the prompt. */
      const nameToken = normaliseToken(char.name);
      for (const a of char.aliases ?? []) {
        const t = normaliseToken(a);
        if (!t || t === nameToken || aliasTokens.has(t)) continue;
        aliasTokens.add(t);
        aliases.push(a);
      }
      const titles: string[] = [];
      const titleSet = new Set<string>();
      if (rec.bookTitle && !titleSet.has(rec.bookTitle)) {
        titleSet.add(rec.bookTitle);
        titles.push(rec.bookTitle);
      }
      grouped.set(root, {
        id: char.id,
        name: char.name,
        aliases: aliases.length ? aliases : undefined,
        fromBookTitles: titles.length ? titles : undefined,
      });
      aliasTokensByGroup.set(root, aliasTokens);
      bookTitlesByGroup.set(root, titleSet);
      continue;
    }
    /* Subsequent record in an existing group — merge fields in. */
    const entry = grouped.get(root)!;
    const aliasTokens = aliasTokensByGroup.get(root)!;
    const titleSet = bookTitlesByGroup.get(root)!;

    /* Promote this record's name to an alias on the canonical entry if
       it differs from the canonical name (case/punct-insensitive). The
       analyzer prompt should learn that "Foster" maps to the
       "Wren"-rooted entry. */
    const canonicalNameTok = normaliseToken(entry.name);
    const thisNameTok = normaliseToken(char.name);
    if (thisNameTok && thisNameTok !== canonicalNameTok && !aliasTokens.has(thisNameTok)) {
      aliasTokens.add(thisNameTok);
      const aliases = entry.aliases ?? [];
      aliases.push(char.name!);
      entry.aliases = aliases;
    }
    for (const a of char.aliases ?? []) {
      const t = normaliseToken(a);
      if (!t || t === canonicalNameTok || aliasTokens.has(t)) continue;
      aliasTokens.add(t);
      const aliases = entry.aliases ?? [];
      aliases.push(a);
      entry.aliases = aliases;
    }
    if (rec.bookTitle && !titleSet.has(rec.bookTitle)) {
      titleSet.add(rec.bookTitle);
      const titles = entry.fromBookTitles ?? [];
      titles.push(rec.bookTitle);
      entry.fromBookTitles = titles;
    }
  }

  /* Return groups in the order their canonical record appeared in the
     input, which matches the producer's book-walk order — keeps the
     pill's first-three-names list stable across runs. */
  const out: DedupedSeriesPriorEntry[] = [];
  const emitted = new Set<number>();
  for (let i = 0; i < records.length; i++) {
    const root = find(i);
    if (emitted.has(root)) continue;
    emitted.add(root);
    out.push(grouped.get(root)!);
  }
  return out;
}
