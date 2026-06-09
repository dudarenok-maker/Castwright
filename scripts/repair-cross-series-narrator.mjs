#!/usr/bin/env node
/* Maintenance tool — clear cross-series generic-role (narrator) reuse links
 * (one-time / dev-only).
 *
 * Before the confirm-screen matcher was series-scoped
 * (server/src/routes/voice-match.ts), a narrator matched against EVERY book's
 * narrator library-wide — every book carries a "narrator" under the same
 * deterministic id, so the exact-name match fired across unrelated series and
 * the tie was broken by arbitrary scan order. `applyVoiceMatches` then
 * persisted that bad link to cast.json. The forward-fix stops NEW bad matches
 * but can't retroactively clear what's already on disk (pruneStaleReuseLinks
 * only runs at analysis time), so this backfill clears the stale data.
 *
 * For each book, every generic-role character (id 'narrator', or a name that
 * normalises to 'narrator') whose `matchedFrom` points to a DIFFERENT
 * author+series — or to a book that no longer exists — has its link reverted
 * to a fresh voice, mirroring the server's clearStaleLink: drop matchedFrom +
 * matchFactors always; for a pure 'reused' row, also revert voiceId -> id,
 * voiceState -> 'generated', and drop the denormalised override voice +
 * voiceStyle + ttsEngine. A tuned/locked narrator keeps its user-owned voice
 * and only loses the dead badge.
 *
 * Same-series narrator reuse is LEFT intact — that's legitimate continuity the
 * analysis-time linker (series-reuse-link.ts) owns.
 *
 * Usage:
 *   node scripts/repair-cross-series-narrator.mjs           # dry run (no writes)
 *   node scripts/repair-cross-series-narrator.mjs --apply   # write cast.json via PUT
 * Env: BASE (default http://localhost:8080). Requires the dev server running,
 * AND already running the series-scoped voice-match fix — otherwise re-opening
 * a book's confirm view will re-stamp the link you just cleared. Back up first
 * (the casts are mutated): GET /api/books/:id/state per book.
 */
const BASE = process.env.BASE ?? 'http://localhost:8080';
const APPLY = process.argv.includes('--apply');

const norm = (s) => (s ?? '').trim().toLowerCase();
/* Generic role-names — mirror server/src/routes/voice-match.ts isGenericRole. */
const GENERIC_ROLE_IDS = new Set(['narrator']);
const isGenericRole = (c) => GENERIC_ROLE_IDS.has(c.id) || norm(c.name) === 'narrator';

const lib = await (await fetch(`${BASE}/api/library`)).json();

/* bookId -> { author, series, title } across the WHOLE library, so a link's
   target can be resolved to its (author, series) regardless of which series
   we're currently walking. */
const meta = new Map();
for (const author of lib.authors ?? []) {
  for (const series of author.series ?? []) {
    for (const b of series.books ?? []) {
      meta.set(b.bookId, { author: author.name, series: series.name, title: b.title });
    }
  }
}

let totalCleared = 0;

for (const author of lib.authors ?? []) {
  for (const series of author.series ?? []) {
    for (const book of series.books ?? []) {
      const st = await (
        await fetch(`${BASE}/api/books/${encodeURIComponent(book.bookId)}/state`)
      ).json();
      const characters = st.cast?.characters ?? [];

      const clears = [];
      const next = characters.map((c) => {
        if (!isGenericRole(c) || !c.matchedFrom?.bookId) return c;
        const target = meta.get(c.matchedFrom.bookId);
        const sameSeries =
          !!target && target.author === author.name && target.series === series.name;
        if (sameSeries) return c; // legitimate same-series narrator reuse — keep
        clears.push({
          charId: c.id,
          charName: c.name,
          target: target ? `${target.series} / ${c.matchedFrom.characterId}` : '(missing book)',
        });
        /* Mirror clearStaleLink (series-reuse-link.ts). */
        const out = { ...c };
        delete out.matchedFrom;
        delete out.matchFactors;
        if (c.voiceState === 'reused') {
          out.voiceId = c.id;
          out.voiceState = 'generated';
          delete out.overrideTtsVoices;
          delete out.voiceStyle;
          delete out.ttsEngine;
        }
        return out;
      });

      if (clears.length === 0) continue;
      console.log(`\n=== ${author.name} / ${series.name} / ${book.title} ===`);
      for (const cl of clears) {
        console.log(`  CLEAR ${cl.charName} (${cl.charId}) → was linked to ${cl.target}`);
      }
      totalCleared += clears.length;

      if (APPLY) {
        const res = await fetch(`${BASE}/api/books/${encodeURIComponent(book.bookId)}/state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slice: 'cast', patch: { characters: next } }),
        });
        console.log(`  [apply] PUT ${res.status}`);
      }
    }
  }
}

console.log(`\nTOTAL cross-series narrator links ${APPLY ? 'cleared' : 'to clear'}: ${totalCleared}`);
console.log(APPLY ? 'APPLIED.' : 'DRY RUN (no writes). Re-run with --apply to write.');
