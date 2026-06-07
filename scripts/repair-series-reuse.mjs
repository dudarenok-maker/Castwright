#!/usr/bin/env node
/* Maintenance tool — series cross-book reuse backfill (one-time / dev-only).
 *
 * Auto "reuse" (the voice-match pipeline) and manual "link" (link-prior) both
 * stamp `matchedFrom` + a unified `voiceId` on a recurring character so it
 * reads "Reused" and shares the prior book's designed voice. Characters that
 * predate those flows (or were linked before `matchedFrom` persisted — see
 * PR #301) carry no `matchedFrom`, so the Reused badge + merge-picker
 * "already linked" suppression never fire.
 *
 * For each series, this links every character in book N (N>1) that recurs by
 * name/alias OR by its stable write key (`voiceId ?? id`) to its EARLIEST-book
 * counterpart: stamps `matchedFrom` + unifies `voiceId` (+ `voiceState:'reused'`
 * unless tuned/locked), via PUT /state (slice `cast`) — the same durable
 * end-state a manual link / auto-reuse produces. Read-only unless `--apply`.
 *
 * The stable-key arm mirrors the analysis-time linker's stable-key pass
 * (server/src/workspace/series-reuse-link.ts): a character that keeps its
 * deterministic key across books IS the same voice even when the analyzer
 * renamed it to a label with zero name-token overlap (the narrator
 * "Narrator" -> "Author" case the name/alias arm can't see).
 *
 * Skips: characters that already have `matchedFrom`; pairs the user marked
 * `notLinkedTo`; the unknown-male / unknown-female buckets (per-book, never
 * reused).
 *
 * Usage:
 *   node scripts/repair-series-reuse.mjs           # dry run (no writes)
 *   node scripts/repair-series-reuse.mjs --apply   # write cast.json via PUT
 * Env: BASE (default http://localhost:8080). Requires the dev server running.
 * Back up first (the casts are mutated): copy each book's cast via
 * GET /api/books/:id/state before applying.
 */
const BASE = process.env.BASE ?? 'http://localhost:8080';
const APPLY = process.argv.includes('--apply');

const norm = (s) => (s ?? '').trim().toLowerCase();
const SKIP_IDS = new Set(['unknown-male', 'unknown-female']);
const surfaceForms = (c) => [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean);
/* Stable cross-book write key — the same `voiceId ?? id` the TTS pipeline and
   the server's applyOverrideToCastFiles key on. An exact match is definitive
   (same voice), independent of how the analyzer named the character. */
const keyOf = (c) => c.voiceId ?? c.id;

const lib = await (await fetch(`${BASE}/api/library`)).json();

for (const author of lib.authors) {
  for (const series of author.series) {
    const books = [...series.books].sort(
      (a, b) => (a.seriesPosition ?? 999) - (b.seriesPosition ?? 999),
    );
    if (books.length < 2) continue;

    const casts = [];
    for (const b of books) {
      const st = await (
        await fetch(`${BASE}/api/books/${encodeURIComponent(b.bookId)}/state`)
      ).json();
      casts.push({ book: b, characters: st.cast?.characters ?? [] });
    }

    console.log(`\n=== SERIES: ${series.name} (${books.length} books) ===`);
    const byBook = new Map();

    for (let i = 1; i < casts.length; i += 1) {
      const { book, characters } = casts[i];
      for (const c of characters) {
        if (SKIP_IDS.has(c.id) || c.matchedFrom) continue;
        const forms = new Set(surfaceForms(c));
        let origin = null;
        for (let j = 0; j < i && !origin; j += 1) {
          const ob = casts[j].book;
          for (const oc of casts[j].characters) {
            if (SKIP_IDS.has(oc.id)) continue;
            const notLinked = (c.notLinkedTo ?? []).some(
              (p) => p.bookId === ob.bookId && p.characterId === oc.id,
            );
            if (notLinked) continue;
            /* Name/alias overlap, or an exact stable-key match (catches a
               recurring character the analyzer renamed past name recognition). */
            if (surfaceForms(oc).some((f) => forms.has(f)) || keyOf(oc) === keyOf(c)) {
              origin = { book: ob, char: oc };
              break;
            }
          }
        }
        if (!origin) continue;
        if (!byBook.has(book.bookId)) byBook.set(book.bookId, { book, links: [] });
        byBook.get(book.bookId).links.push({
          charId: c.id,
          charName: c.name,
          fromBookId: origin.book.bookId,
          fromCharId: origin.char.id,
          fromBookTitle: origin.book.title,
          voiceId: origin.char.voiceId ?? origin.char.id,
        });
      }
    }

    let total = 0;
    for (const { book, links } of byBook.values()) {
      console.log(`  ${book.title}: ${links.length} links`);
      for (const l of links) {
        console.log(`    ${l.charName} (${l.charId}) → ${l.fromBookTitle}/${l.fromCharId}  voiceId=${l.voiceId}`);
      }
      total += links.length;
    }
    console.log(`  TOTAL proposed links in series: ${total}`);

    if (APPLY && total) {
      for (const { book, links } of byBook.values()) {
        const cast = casts.find((c) => c.book.bookId === book.bookId);
        const map = new Map(links.map((l) => [l.charId, l]));
        const next = cast.characters.map((c) => {
          const l = map.get(c.id);
          if (!l) return c;
          const out = {
            ...c,
            voiceId: l.voiceId,
            matchedFrom: {
              bookId: l.fromBookId,
              characterId: l.fromCharId,
              bookTitle: l.fromBookTitle,
              confidence: 1,
            },
          };
          if (c.voiceState !== 'locked' && c.voiceState !== 'tuned') out.voiceState = 'reused';
          return out;
        });
        const res = await fetch(`${BASE}/api/books/${encodeURIComponent(book.bookId)}/state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slice: 'cast', patch: { characters: next } }),
        });
        console.log(`  [apply] ${book.title}: PUT ${res.status}`);
      }
    }
  }
}
console.log(APPLY ? '\nAPPLIED.' : '\nDRY RUN (no writes). Re-run with --apply to write.');
