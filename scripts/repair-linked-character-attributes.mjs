#!/usr/bin/env node
/*
 * repair-linked-character-attributes.mjs
 *
 * Backfill for the "a recurring character has barely any quotes / attributes in
 * some books" gap — the data side of the cross-book link carry-over fix.
 *
 * Symptom: the SAME person appears across several series books, but in one or
 * more of them the row is thin or empty — e.g. The Floodmark's "Dame Linnet" was
 * carried in from the roster with 0 of its own detected lines, so its profile
 * (representative quotes, attributes, description, tone) is blank even though
 * the canonical character in earlier books is rich. Cause: until
 * cast-link-prior.ts learned to carry the profile over, reuse/linking unified
 * only the VOICE + name aliases, never the profile content.
 *
 * What this does: it groups every cast member into cross-book IDENTITY CLUSTERS
 * and, for each cluster that spans 2+ books, tops up the THIN copies from the
 * rich siblings — targeted specifically at the multi-book rows that have low /
 * empty quotes or attributes. Not just `matchedFrom`-linked rows: any reused row
 * sharing a canonical voiceId (the plan-122 link path) and the canonical/origin
 * rows themselves are all pulled into the same cluster.
 *
 * Clustering (a character A and B are the same identity when):
 *   - they share the same NON-EMPTY voiceId within the SAME (author, series)
 *     — series-scoped so a generic id like "narrator" in two DIFFERENT series
 *     is never merged; OR
 *   - A.matchedFrom points at B (or vice-versa).
 * Union-find over both edge kinds gives the transitive closure.
 *
 * Merge rules:
 *   - evidence / attributes — the cluster UNION is poured into a member ONLY
 *     when that member is THIN on that field (count < LOW_QUOTES / LOW_ATTRS,
 *     default 5). A rich copy is left exactly as it is — we top up the sparse
 *     rows, never inflate a full one to the union of every book.
 *   - description / tone / gender / ageRange — FILL-IF-MISSING per member from
 *     the cluster's canonical (longest description, merged tone, first gender /
 *     age). A member's own non-empty scalar is never clobbered.
 *   - The NARRATOR is skipped — its sampled narration isn't a casting signal and
 *     clustering it just unions hundreds of lines into noise.
 *
 * Idempotent: a member already at/above the bar (or already holding the union)
 * is left untouched.
 *
 * DRY RUN BY DEFAULT — prints the planned writes and exits without touching
 * disk. Pass --apply to write each changed cast.json (a .bak is written first).
 *
 * Env:
 *   BASE                 workspace root (overrides everything)
 *   WORKSPACE_DIR        workspace root (same var the server's .env uses)
 *   AUDIOBOOK_WORKSPACE  workspace root
 *   default              <home>/AudiobookWorkspace
 *   LOW_QUOTES           thin-quote bar (default 5) — fill members below it
 *   LOW_ATTRS            thin-attribute bar (default 5)
 *
 * Usage:
 *   node scripts/repair-linked-character-attributes.mjs                       # dry run
 *   node scripts/repair-linked-character-attributes.mjs --apply               # write
 *   BASE="C:/AudiobookWorkspace" node scripts/repair-linked-character-attributes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');

/* A member is "thin" on a list field when its count is below this bar — only
   then does the cluster union get poured in. Keeps the backfill targeted at the
   genuinely-empty/sparse copies (the reported symptom) instead of inflating an
   already-rich row to the union of every book. Tune via env. */
const LOW_QUOTES = Number(process.env.LOW_QUOTES ?? 5);
const LOW_ATTRS = Number(process.env.LOW_ATTRS ?? 5);

const BASE =
  (process.env.BASE && path.resolve(process.env.BASE)) ||
  (process.env.WORKSPACE_DIR && path.resolve(process.env.WORKSPACE_DIR)) ||
  (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
  path.join(os.homedir(), 'AudiobookWorkspace');

const BOOKS_ROOT = path.join(BASE, 'books');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/* Mirror of server normaliseForMatch for evidence-quote dedup: lowercase,
   fold smart quotes, strip non-alphanumerics, collapse whitespace. */
const normaliseQuote = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/* Union evidence lists, first-arg-first, dedup on normalised quote. */
function mergeEvidence(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      const norm = normaliseQuote(e?.quote);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ ...e });
    }
  }
  return out.length ? out : undefined;
}

/* Union string lists, first-arg-first, lower-case dedup. */
function unionStrings(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const s of Array.isArray(list) ? list : []) {
      const key = String(s ?? '')
        .trim()
        .toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out.length ? out : undefined;
}

const evidenceKeys = (e) =>
  new Set((Array.isArray(e) ? e : []).map((x) => normaliseQuote(x?.quote)).filter(Boolean));

const sameStringSet = (a, b) => {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i += 1) if (A[i] !== B[i]) return false;
  return true;
};

/* Walk BOOKS_ROOT (author / series / title), collecting every confirmed book's
   .audiobook dir + author/series + cast. */
function collectBooks() {
  const books = [];
  if (!fs.existsSync(BOOKS_ROOT)) {
    console.error(`[repair] BOOKS_ROOT does not exist: ${BOOKS_ROOT}`);
    console.error('         Pass BASE=... or WORKSPACE_DIR=... pointing at your workspace.');
    return books;
  }
  const dirs = (p) =>
    fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  for (const author of dirs(BOOKS_ROOT)) {
    for (const series of dirs(path.join(BOOKS_ROOT, author))) {
      for (const title of dirs(path.join(BOOKS_ROOT, author, series))) {
        const audiobookDir = path.join(BOOKS_ROOT, author, series, title, '.audiobook');
        const cast = readJson(path.join(audiobookDir, 'cast.json'));
        const state = readJson(path.join(audiobookDir, 'state.json'));
        if (!cast?.characters || !state?.bookId) continue;
        books.push({
          bookId: state.bookId,
          title: state.title ?? title,
          author: state.author ?? author,
          series: state.series ?? series,
          castPath: path.join(audiobookDir, 'cast.json'),
          cast,
        });
      }
    }
  }
  return books;
}

/* ---- tiny union-find over global character keys `${bookId}::${charId}` ---- */
function makeUnionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union, parent };
}

function main() {
  console.log(`[repair] workspace: ${BASE}`);
  console.log(`[repair] mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

  const books = collectBooks();
  if (!books.length) return;

  /* Index every character by its global key, and the book it belongs to. */
  const charByKey = new Map(); // key -> { book, char }
  const keyExists = (bookId, charId) => charByKey.has(`${bookId}::${charId}`);
  for (const book of books) {
    for (const c of book.cast.characters) {
      charByKey.set(`${book.bookId}::${c.id}`, { book, char: c });
    }
  }

  const uf = makeUnionFind();
  /* Edge 1: same (author, series) + same non-empty voiceId. */
  const voiceBuckets = new Map(); // `${author}::${series}::${voiceId}` -> [keys]
  for (const [key, { book, char }] of charByKey) {
    if (!char.voiceId) continue;
    const bk = `${book.author} ${book.series} ${char.voiceId}`;
    if (!voiceBuckets.has(bk)) voiceBuckets.set(bk, []);
    voiceBuckets.get(bk).push(key);
  }
  for (const keys of voiceBuckets.values()) {
    for (let i = 1; i < keys.length; i += 1) uf.union(keys[0], keys[i]);
  }
  /* Edge 2: matchedFrom points at another known character. */
  for (const [key, { char }] of charByKey) {
    const mf = char.matchedFrom;
    if (mf?.bookId && mf?.characterId && keyExists(mf.bookId, mf.characterId)) {
      uf.union(key, `${mf.bookId}::${mf.characterId}`);
    }
  }

  /* Gather components. */
  const components = new Map(); // root -> [keys]
  for (const key of charByKey.keys()) {
    const root = uf.find(key);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(key);
  }

  const touchedBooks = new Set();
  const changedChars = [];

  for (const keys of components.values()) {
    if (keys.length < 2) continue;
    const members = keys.map((k) => charByKey.get(k));
    const distinctBooks = new Set(members.map((m) => m.book.bookId));
    if (distinctBooks.size < 2) continue; // only multi-book identities

    /* Cluster union / canonical scalars. */
    const unionEvidence = mergeEvidence(...members.map((m) => m.char.evidence));
    const unionAttributes = unionStrings(...members.map((m) => m.char.attributes));
    const canonicalDescription = members
      .map((m) => m.char.description)
      .filter((d) => d && String(d).trim())
      .sort((a, b) => String(b).length - String(a).length)[0];
    const canonicalTone = members.reduce(
      (acc, m) => (m.char.tone ? { ...acc, ...m.char.tone } : acc),
      undefined,
    );
    const canonicalGender = members.map((m) => m.char.gender).find(Boolean);
    const canonicalAgeRange = members.map((m) => m.char.ageRange).find(Boolean);

    for (const { book, char: c } of members) {
      /* Narrator isn't a cast identity whose quote sample matters for design;
         clustering it just unions hundreds of narration lines into noise. */
      if (c.role === 'narrator' || c.id === 'narrator') continue;

      /* List fields union in ONLY when this member is thin on that field —
         a rich copy is left exactly as it is. Scalars still fill-if-missing
         below regardless, since those are gap-fills, not inflation. */
      const quotesThin = evidenceKeys(c.evidence).size < LOW_QUOTES;
      const attrsThin = (c.attributes?.length ?? 0) < LOW_ATTRS;
      const mergedEvidence = quotesThin ? mergeEvidence(c.evidence, unionEvidence) : c.evidence;
      const mergedAttributes = attrsThin
        ? unionStrings(c.attributes, unionAttributes)
        : c.attributes;
      const mergedDescription =
        c.description && String(c.description).trim() ? c.description : canonicalDescription;
      const mergedTone =
        c.tone || canonicalTone ? { ...(canonicalTone ?? {}), ...(c.tone ?? {}) } : undefined;
      const mergedGender = c.gender ?? canonicalGender;
      const mergedAgeRange = c.ageRange ?? canonicalAgeRange;

      const beforeQuotes = evidenceKeys(c.evidence).size;
      const afterQuotes = evidenceKeys(mergedEvidence).size;
      const evidenceChanged = beforeQuotes !== afterQuotes;
      const attrsChanged = !sameStringSet(c.attributes, mergedAttributes);
      const descChanged = (c.description ?? undefined) !== (mergedDescription ?? undefined);
      const genderChanged = (c.gender ?? undefined) !== (mergedGender ?? undefined);
      const ageChanged = (c.ageRange ?? undefined) !== (mergedAgeRange ?? undefined);
      const toneChanged = JSON.stringify(c.tone ?? null) !== JSON.stringify(mergedTone ?? null);

      if (
        !evidenceChanged &&
        !attrsChanged &&
        !descChanged &&
        !genderChanged &&
        !ageChanged &&
        !toneChanged
      ) {
        continue; // already complete
      }

      const parts = [];
      if (evidenceChanged) parts.push(`quotes ${beforeQuotes}→${afterQuotes}`);
      if (attrsChanged)
        parts.push(`attributes ${c.attributes?.length ?? 0}→${mergedAttributes?.length ?? 0}`);
      if (descChanged) parts.push('description');
      if (toneChanged) parts.push('tone');
      if (genderChanged) parts.push('gender');
      if (ageChanged) parts.push('ageRange');
      console.log(`  ✎ ${book.title} / ${c.name}  [${parts.join(', ')}]`);

      if (mergedEvidence !== undefined) c.evidence = mergedEvidence;
      if (mergedAttributes !== undefined) c.attributes = mergedAttributes;
      if (mergedDescription !== undefined) c.description = mergedDescription;
      if (mergedTone !== undefined) c.tone = mergedTone;
      if (mergedGender !== undefined) c.gender = mergedGender;
      if (mergedAgeRange !== undefined) c.ageRange = mergedAgeRange;

      touchedBooks.add(book.bookId);
      changedChars.push(`${book.title} / ${c.name}`);
    }
  }

  let writtenBooks = 0;
  for (const book of books) {
    if (!touchedBooks.has(book.bookId)) continue;
    writtenBooks += 1;
    if (APPLY) {
      fs.copyFileSync(book.castPath, `${book.castPath}.bak`);
      fs.writeFileSync(book.castPath, `${JSON.stringify(book.cast, null, 2)}\n`, 'utf8');
      console.log(`  → wrote ${book.castPath} (.bak saved)`);
    }
  }

  console.log(
    `\n[repair] ${changedChars.length} cast member(s) across ${writtenBooks} book(s) ${
      APPLY ? 'updated' : 'would be updated'
    } (multi-book identities only).`,
  );
  if (!APPLY && changedChars.length > 0) console.log('[repair] Re-run with --apply to write.');
}

main();
