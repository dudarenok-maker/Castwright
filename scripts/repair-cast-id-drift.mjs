#!/usr/bin/env node
/*
 * repair-cast-id-drift.mjs — #2040 Wave 3 Task 18
 *
 * Offline repair pass for the id-drift damage already on disk (spec §4.7,
 * docs/superpowers/specs/2026-08-01-cast-character-identity-design.md).
 * `characterId` is LLM free text used as the join key between `cast.json`,
 * the analysis cache (`server/handoff/cache/{manuscriptId}.json`) and each
 * chapter's frozen `<slug>.segments.json`. When the analyzer re-slugs a
 * character (or `cast-create.ts` mints a different-separator id), the join
 * breaks and old renders end up orphaned relative to the live cast — some
 * silently narrator-substituted at render time, some rendered correctly
 * under an id that has since moved.
 *
 * This script does NOT touch cast.json (read-only against it in every
 * mode) and does NOT re-render anything. It only:
 *   1. finds every orphaned characterId per book (frozen segments AND the
 *      analysis cache),
 *   2. ranks candidate live characters for each orphan,
 *   3. for the two auto-record tiers only (§4.2), writes a
 *      `cast-id-history.json` alias (`from -> to`) so every read site that
 *      already consults the resolver (`server/src/store/cast-resolve.ts`)
 *      picks the orphaned id back up, and
 *   4. emits a re-render list — book, chapter, orphaned id, segment count,
 *      approximate affected duration — for a human to act on separately.
 *
 * Auto-record tiers (mirrors spec §4.2 EXACTLY — this script does not
 * invent a third matcher):
 *   Tier A — byte-identical normalised display name (via the server's own
 *            `normaliseForMatch`), exactly one candidate on each side.
 *   Tier B — byte-identical normalised id (via the server's own
 *            `normaliseIdKey`), exactly one candidate on each side.
 * A segment orphan that Tier A/B-matches a LIVE cast id would already have
 * resolved through `buildCastResolver`'s own normalised-id tier and so
 * never reaches this script's orphan set at all — Tier B only has bite
 * here for a cache-only orphan that was never rendered. Anything else
 * (including every book's `cast.json.bak.*` name and the frozen
 * `characterSnapshots` tone/gender/ageRange/attributes signal) is a
 * RANKING signal only, surfaced for a human decision, never auto-applied.
 *
 * Snapshot-consistency guard (beyond the two tiers, found while grounding
 * this script against the real workspace — see the paired report): a
 * reserved fold-bucket id (`unknown-male`/`unknown-female`) can be reused
 * for several DIFFERENT named characters across a book's chapters (the
 * analyzer's own per-chapter cast detection does this — confirmed on
 * Exile, where the cache names `unknown-male` Timkin/Brant/Dwarf/Rex/Lord
 * Cassius across five different chapters). A single bak-file name is only
 * safe to auto-record book-wide when every rendered occurrence of that id
 * actually used the SAME voice — checked by comparing gender/ageRange/
 * voiceEngine/voiceId across every `characterSnapshots` entry the id
 * carries. A genuine conflict downgrades an otherwise-Tier-A match to
 * report-only.
 *
 * This script reuses the server's own id-resolution logic rather than
 * re-implementing it (#2040 Wave 3 review already caught one Critical
 * caused by two independent matchers disagreeing) — it dynamically
 * imports `buildCastResolver`, `normaliseForMatch`, `normaliseIdKey`,
 * `loadCastIdHistory`/`retireCharacterId` and `loadSegmentsFiles` straight
 * from the COMPILED server (`server/dist/**`), never from `server/src`.
 * That means **`cd server && npm run build` (or the root `npm run build`)
 * must have been run first** — the script fails loud with that exact
 * instruction if `server/dist` is missing.
 *
 * DRY RUN BY DEFAULT — prints the plan and exits without touching disk.
 * `--apply` writes. `--apply` refuses outright if a server answers
 * `/api/health` on the configured port: this script writes
 * `cast-id-history.json` out-of-process, which no in-process lock covers
 * (spec §10).
 *
 * Env:
 *   BASE                 workspace root (overrides everything)
 *   WORKSPACE_DIR        workspace root (same var the server's .env uses)
 *   AUDIOBOOK_WORKSPACE  workspace root
 *   default              <home>/AudiobookWorkspace
 *   CACHE_DIR            analysis-cache root — default `<repo>/server/handoff/cache`.
 *                        IMPORTANT: that directory is git-ignored and
 *                        per-checkout (`.gitignore:94`), so a worktree's own
 *                        copy holds only whatever ran analysis THERE. Point
 *                        this at the checkout that actually ran the book's
 *                        analysis (commonly the primary checkout) when
 *                        repairing from a worktree, or cache-orphan
 *                        detection silently sees nothing.
 *   PORT                 port the --apply liveness probe checks (default 8080,
 *                        matches server/src/index.ts's own default).
 *
 * Usage:
 *   node scripts/repair-cast-id-drift.mjs                       # dry run
 *   node scripts/repair-cast-id-drift.mjs --apply                # write
 *   CACHE_DIR="C:/Claude/Projects/Audiobook-Generator/server/handoff/cache" \
 *     node scripts/repair-cast-id-drift.mjs
 *
 * Tests: `npm run test:hooks` (node:test over scripts/tests/*.test.mjs) —
 *   NOT `npm run test:scripts`, which only runs Pester `.Tests.ps1` files
 *   and never touches a `.test.mjs`. The test file imports only this
 *   script's own exported pure helpers, never `server/dist` — so the unit
 *   tests run with no build step, even though `main()` needs one.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Pure helpers (unit tested directly — see scripts/tests/repair-cast-id-drift.test.mjs)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

/** Render seconds as `Nm SSs` (or `SSs` under a minute). Pure formatter used
 *  only for the human-readable report. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

/** Build an id -> name index from a list of `{id, name}` pairs (drawn from
 *  the analysis cache's `stage1.characters` + every `chapterCast[*]` entry,
 *  or from a book's `cast.json.bak.*` files' `characters` arrays).
 *
 *  Ambiguity is judged POST-normalisation (`normaliseFn`, always the real
 *  `normaliseForMatch` in production — see the module doc comment for why
 *  this is a parameter rather than an import): if two DISTINCT normalised
 *  names are seen for the same id, that id is marked ambiguous and its
 *  `name` becomes `undefined` — same principle as `buildCastResolver`'s own
 *  ambiguity maps (a tie means "stop", not "guess"). This is exactly the
 *  shape that caught Exile's cache reusing `unknown-male` for five
 *  different named characters across chapters (Timkin/Brant/Dwarf/Rex/Lord
 *  Cassius) — see the module doc comment. */
export function buildNameIndex(entries, normaliseFn) {
  const seenNormalised = new Map(); // id -> Set<normalisedName>
  const firstRawName = new Map(); // id -> first raw name seen
  for (const entry of entries) {
    const id = entry?.id;
    const name = entry?.name;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) continue;
    const norm = normaliseFn(name);
    if (!norm) continue;
    if (!seenNormalised.has(id)) {
      seenNormalised.set(id, new Set());
      firstRawName.set(id, name);
    }
    seenNormalised.get(id).add(norm);
  }
  const index = new Map();
  for (const [id, normSet] of seenNormalised) {
    const ambiguous = normSet.size > 1;
    index.set(id, {
      name: ambiguous ? undefined : firstRawName.get(id),
      ambiguous,
      distinctNames: [...normSet],
    });
  }
  return index;
}

/** Tier A (spec §4.2): find the single live cast character whose normalised
 *  display name equals `normaliseFn(candidateName)`. Returns `undefined` on
 *  no match OR a tie (more than one live character shares the normalised
 *  name) — the same "a tie means stop" rule `buildCastResolver` and
 *  `remapFreshToPriorIds` both already apply; this function must not
 *  reintroduce a looser one. */
export function resolveTierAName(candidateName, liveCast, normaliseFn) {
  if (!candidateName) return undefined;
  const target = normaliseFn(candidateName);
  if (!target) return undefined;
  const matches = liveCast.filter((c) => typeof c.name === 'string' && normaliseFn(c.name) === target);
  return matches.length === 1 ? matches[0].id : undefined;
}

/** Tier B (spec §4.2): find the single live cast character whose id
 *  normalises (via `normaliseIdFn`, the real `normaliseIdKey` in
 *  production) to the same key as `orphanId`. Same tie-means-stop rule as
 *  `resolveTierAName`. In production this only has bite for a cache-only
 *  orphan: a SEGMENT orphan that would Tier-B-match a live id has already
 *  resolved through `buildCastResolver`'s own normalised-id tier before it
 *  ever reaches this script's orphan set (confirmed against the real
 *  workspace — see the paired report). */
export function resolveTierBId(orphanId, liveCast, normaliseIdFn) {
  const target = normaliseIdFn(orphanId);
  const matches = liveCast.filter((c) => normaliseIdFn(c.id) === target);
  return matches.length === 1 ? matches[0].id : undefined;
}

/** True when every non-empty `characterSnapshots` entry gathered for one
 *  orphaned id (across however many chapters it rendered in) is consistent
 *  enough to trust that they are all the SAME rendered voice: any two
 *  defined `voiceId`s must be equal, and any two defined `gender` /
 *  `ageRange` / `voiceEngine` values must be equal. Vacuously true for 0 or
 *  1 snapshots — nothing to conflict with.
 *
 *  This is the guard that stops a book-wide alias being recorded for a
 *  reserved fold-bucket id whose chapters actually rendered DIFFERENT
 *  people under the same shared id — see the module doc comment. Verified
 *  moot (never fires) for the six real Tier-A candidates found in the
 *  #2040 workspace survey — Exile's `unknown-male`/`unknown-female` and
 *  Unlocked's `unknown-male` each render one consistent voice across every
 *  chapter they appear in, despite the cache's own per-chapter name churn. */
export function snapshotsConsistent(snapshots) {
  const nonEmpty = snapshots.filter(Boolean);
  if (nonEmpty.length < 2) return true;
  const fields = ['voiceId', 'gender', 'ageRange', 'voiceEngine'];
  for (const field of fields) {
    const values = new Set(nonEmpty.map((s) => s[field]).filter((v) => v !== undefined && v !== null));
    if (values.size > 1) return false;
  }
  return true;
}

/** Advisory-only ranking (spec §4.7: "use those to rank" — never auto-
 *  applied, see the two-tier auto-record rule above). Scores each live
 *  candidate against one orphan `characterSnapshot` (tone/gender/ageRange/
 *  attributes — the signal a frozen segments orphan carries even with no
 *  name) using cast.json's own per-character fields:
 *
 *    - gender:      +40 exact match / -40 defined-and-different. The
 *                    single strongest signal available — a wrong-gender
 *                    voice is the worst kind of misattribution a human
 *                    reviewer could accept by mistake.
 *    - ageRange:     +20 exact match / -10 defined-and-different. Softer
 *                    penalty than gender: age buckets are coarse (the
 *                    analyzer's own four-way enum) and a near-miss (teen
 *                    vs adult) is a much smaller error than a wrong voice.
 *    - attributes:   +up to 20, scaled by Jaccard similarity of the two
 *                    (lower-cased) attribute sets. Descriptive-word lists
 *                    drift run to run (stochastic sampling), so this is a
 *                    soft signal, not a tier — capped at the same weight
 *                    as ageRange rather than gender.
 *    - tone:         +up to 20, scaled by 1 - (RMS distance / 100) across
 *                    whichever of warmth/pace/authority/emotion both sides
 *                    define. Each field is a 0-100 scale (toneSchema), so
 *                    RMS distance is naturally bounded ~0-100.
 *
 *  cast.json's own field is `ttsEngine`, not `voiceEngine` — the two are
 *  the same concept under different names on either side of the join
 *  (`characterSnapshots[id].voiceEngine` vs a live character's
 *  `ttsEngine`); not scored (no clean signal either way — a character's
 *  configured engine can differ from what a given render actually used,
 *  per the fe-16 fallback-engine stamp), but the map is documented here so
 *  the asymmetry isn't mistaken for an oversight.
 *
 *  Returns the top `topN` candidates (default 3) sorted by score
 *  descending, `{ liveId, liveName, score, why }`. Reserved ids
 *  (`reservedIds`, e.g. narrator + the two fold buckets) are never
 *  suggested — they're not a "who actually said this line" answer. */
export function rankSnapshotCandidates(snapshot, liveCast, reservedIds, topN = 3) {
  if (!snapshot) return [];
  const pool = liveCast.filter((c) => !reservedIds.has(c.id));
  const scored = pool.map((c) => {
    let score = 0;
    const why = [];
    if (snapshot.gender && c.gender) {
      if (snapshot.gender === c.gender) {
        score += 40;
        why.push('gender match');
      } else {
        score -= 40;
        why.push('gender mismatch');
      }
    }
    if (snapshot.ageRange && c.ageRange) {
      if (snapshot.ageRange === c.ageRange) {
        score += 20;
        why.push('ageRange match');
      } else {
        score -= 10;
        why.push('ageRange mismatch');
      }
    }
    if (Array.isArray(snapshot.attributes) && Array.isArray(c.attributes) && snapshot.attributes.length && c.attributes.length) {
      const a = new Set(snapshot.attributes.map((s) => String(s).toLowerCase()));
      const b = new Set(c.attributes.map((s) => String(s).toLowerCase()));
      let inter = 0;
      for (const x of a) if (b.has(x)) inter += 1;
      const union = a.size + b.size - inter;
      const jaccard = union === 0 ? 0 : inter / union;
      if (jaccard > 0) {
        score += jaccard * 20;
        why.push(`attributes overlap ${Math.round(jaccard * 100)}%`);
      }
    }
    if (snapshot.tone && c.tone) {
      const fields = ['warmth', 'pace', 'authority', 'emotion'];
      let sumSq = 0;
      let n = 0;
      for (const f of fields) {
        if (typeof snapshot.tone[f] === 'number' && typeof c.tone[f] === 'number') {
          sumSq += (snapshot.tone[f] - c.tone[f]) ** 2;
          n += 1;
        }
      }
      if (n > 0) {
        const dist = Math.sqrt(sumSq / n);
        const sim = Math.max(0, 1 - dist / 100);
        score += sim * 20;
        if (sim > 0.5) why.push('tone similar');
      }
    }
    return { liveId: c.id, liveName: c.name, score, why };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/** The core planning step for one book — pure, no I/O. Given already-loaded
 *  plain data, decides for every orphaned id whether to auto-record a
 *  `cast-id-history.json` alias (Tier A / Tier B, snapshot-consistency
 *  guard applied), or report it for a human, or skip it (already recorded,
 *  or explicitly rejected by the user — #2040 Task 17's `rejected` list).
 *
 *  `deps.normaliseForMatch` / `deps.normaliseIdKey` are always the real
 *  server functions in production (dynamically imported from
 *  `server/dist` in `main()`); tests inject their own stand-ins so this
 *  function's OWN logic (ambiguity handling, tier precedence, the
 *  snapshot-consistency downgrade) is verifiable with no build step — see
 *  the module doc comment's Tests section. `deps.reservedIds` mirrors
 *  `NARRATOR_CHARACTER_IDS` + the two fold-bucket ids (imported for real in
 *  `main()`): an alias is never auto-recorded ONTO a reserved id — that
 *  would misattribute a real, now-dead character's segments onto a shared
 *  slot instead of a specific person. */
export function planBookRepairs(input, deps) {
  const { liveCast, history, cacheNameIndex, bakNameIndex, orphans } = input;
  const { normaliseForMatch, normaliseIdKey, reservedIds } = deps;

  const liveIds = new Set(liveCast.map((c) => c.id));
  const rejectedSet = new Set(history.rejected ?? []);
  const supersededBy = history.supersededBy ?? {};

  const allIds = new Set([...cacheNameIndex.keys(), ...bakNameIndex.keys(), ...orphans.keys()]);

  const autoRecord = [];
  const reportOnly = [];
  const skipped = [];

  for (const id of allIds) {
    if (liveIds.has(id)) continue; // not an orphan at all

    if (rejectedSet.has(id)) {
      skipped.push({ id, reason: 'rejected', detail: 'user explicitly rejected this reconciliation (Task 17 banner)' });
      continue;
    }
    if (id in supersededBy) {
      skipped.push({ id, reason: 'already-recorded', detail: `cast-id-history.json already maps this to "${supersededBy[id]}"` });
      continue;
    }

    const orphan = orphans.get(id) ?? { segments: 0, chapters: [], snapshots: [] };
    const bak = bakNameIndex.get(id);
    const cache = cacheNameIndex.get(id);

    // Bak-file name outranks the cache (spec §4.7: "stronger still"), but
    // only when it is itself unambiguous — an id ambiguous WITHIN its own
    // source is never trusted, regardless of what the other source says.
    const nameCandidate = bak && !bak.ambiguous ? bak.name : cache && !cache.ambiguous ? cache.name : undefined;
    const nameSource = bak && !bak.ambiguous ? 'cast.json.bak.*' : cache && !cache.ambiguous ? 'analysis cache' : undefined;

    let matchedId;
    let tier;
    let evidence;

    if (nameCandidate) {
      const tierAMatch = resolveTierAName(nameCandidate, liveCast, normaliseForMatch);
      if (tierAMatch && !reservedIds.has(tierAMatch)) {
        matchedId = tierAMatch;
        tier = 'A';
        const liveName = liveCast.find((c) => c.id === tierAMatch)?.name;
        evidence = `${nameSource} name "${nameCandidate}" == live "${liveName}" (${tierAMatch})`;
      }
    }
    if (!matchedId) {
      const tierBMatch = resolveTierBId(id, liveCast, normaliseIdKey);
      if (tierBMatch && !reservedIds.has(tierBMatch)) {
        matchedId = tierBMatch;
        tier = 'B';
        evidence = `id "${id}" normalises the same as live id "${tierBMatch}"`;
      }
    }

    if (matchedId) {
      if (!snapshotsConsistent(orphan.snapshots)) {
        reportOnly.push({
          id,
          segments: orphan.segments,
          chapters: orphan.chapters,
          reason: `name-matched "${matchedId}" (${evidence}) but the rendered characterSnapshots disagree ` +
            `across chapters — this id was reused for more than one voice; needs per-chapter human review`,
          candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
        });
        continue;
      }
      autoRecord.push({ id, to: matchedId, tier, evidence, segments: orphan.segments, chapters: orphan.chapters });
      continue;
    }

    const reasonParts = [];
    if (bak?.ambiguous) reasonParts.push(`cast.json.bak.* names this id ${bak.distinctNames.length} different things (${bak.distinctNames.join(', ')})`);
    if (cache?.ambiguous) reasonParts.push(`analysis cache names this id ${cache.distinctNames.length} different things (${cache.distinctNames.join(', ')})`);
    if (nameCandidate) reasonParts.push(`nearest name "${nameCandidate}" (${nameSource}) does not exactly match any live cast member`);
    if (reasonParts.length === 0) reasonParts.push('no display name found for this id in the analysis cache or any cast.json.bak.*');

    reportOnly.push({
      id,
      segments: orphan.segments,
      chapters: orphan.chapters,
      reason: reasonParts.join('; '),
      candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
    });
  }

  return { autoRecord, reportOnly, skipped };
}

/** Flatten one book's orphan-id -> chapter map into the re-render list's
 *  row shape (book, chapter, orphaned id, segment count, approximate
 *  affected duration) — spec §4.7's closing requirement. Includes EVERY
 *  orphaned segment regardless of whether an alias was auto-recorded for
 *  it: recording the alias fixes downstream metadata/attribution, not the
 *  audio bytes already on disk, so whether to re-render is always a
 *  separate call (spec §4.7's own words) — pure, no filtering. */
export function buildRerenderRows(bookLabel, orphans) {
  const rows = [];
  for (const [id, orphan] of orphans) {
    for (const ch of orphan.chapters) {
      rows.push({
        book: bookLabel,
        chapterId: ch.chapterId,
        chapterTitle: ch.chapterTitle,
        id,
        segments: ch.segments,
        durationSec: ch.durationSec,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// I/O — everything below touches the filesystem or the network.
// ---------------------------------------------------------------------------

function resolveWorkspaceDir() {
  return (
    (process.env.BASE && path.resolve(process.env.BASE)) ||
    (process.env.WORKSPACE_DIR && path.resolve(process.env.WORKSPACE_DIR)) ||
    (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
    path.join(os.homedir(), 'AudiobookWorkspace')
  );
}

function resolveCacheDir() {
  return process.env.CACHE_DIR
    ? path.resolve(process.env.CACHE_DIR)
    : path.join(REPO_ROOT, 'server', 'handoff', 'cache');
}

const readJsonSync = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/* 3-level author/series/title walk — the same convention
   `repair-linked-character-attributes.mjs` and every other workspace-wide
   fs-direct repair script already use for `WORKSPACE_DIR/books`. */
function collectBooks(workspaceDir) {
  const booksRoot = path.join(workspaceDir, 'books');
  const books = [];
  if (!fs.existsSync(booksRoot)) return books;
  const dirs = (p) =>
    fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  for (const author of dirs(booksRoot)) {
    for (const series of dirs(path.join(booksRoot, author))) {
      for (const title of dirs(path.join(booksRoot, author, series))) {
        const bookDir = path.join(booksRoot, author, series, title);
        const audiobookDir = path.join(bookDir, '.audiobook');
        const cast = readJsonSync(path.join(audiobookDir, 'cast.json'));
        const state = readJsonSync(path.join(audiobookDir, 'state.json'));
        if (!cast?.characters || !state?.chapters) continue;
        books.push({
          bookDir,
          audiobookDir,
          label: `${author} / ${series} / ${state.title ?? title}`,
          cast,
          state,
        });
      }
    }
  }
  return books;
}

function collectBakNameEntries(audiobookDir) {
  const entries = [];
  let files;
  try {
    files = fs.readdirSync(audiobookDir).filter((f) => f.startsWith('cast.json.bak'));
  } catch {
    return entries;
  }
  for (const f of files) {
    const bak = readJsonSync(path.join(audiobookDir, f));
    for (const c of bak?.characters ?? []) {
      if (typeof c?.id === 'string' && typeof c?.name === 'string') entries.push({ id: c.id, name: c.name });
    }
  }
  return entries;
}

function readAnalysisCache(cacheDir, manuscriptId) {
  if (!manuscriptId) return null;
  // Deliberately a plain read, not the server's `loadAnalysisCache` — that
  // function hardcodes CACHE_DIR relative to its own compiled location with
  // no override, which would defeat this script's CACHE_DIR env var (see
  // the module doc comment on why that override matters). This is a data
  // read, not a matching decision, so it does not fall under the
  // "don't duplicate the resolver" rule.
  const p = path.join(cacheDir, `${manuscriptId}.json`);
  return readJsonSync(p);
}

function cacheEntriesOf(cache) {
  const entries = [];
  for (const c of cache?.stage1?.characters ?? []) {
    if (typeof c?.id === 'string' && typeof c?.name === 'string') entries.push({ id: c.id, name: c.name });
  }
  for (const list of Object.values(cache?.chapterCast ?? {})) {
    for (const c of list ?? []) {
      if (typeof c?.id === 'string' && typeof c?.name === 'string') entries.push({ id: c.id, name: c.name });
    }
  }
  return entries;
}

function probeHealth(port) {
  return new Promise((resolveP) => {
    const req = http.get({ host: 'localhost', port, path: '/api/health', timeout: 4000 }, (res) => {
      res.resume();
      resolveP(res.statusCode !== undefined);
    });
    req.on('error', () => resolveP(false));
    req.on('timeout', () => {
      req.destroy();
      resolveP(false);
    });
  });
}

async function loadServerModules() {
  const need = [
    'server/dist/store/cast-resolve.js',
    'server/dist/store/cast-id-history.js',
    'server/dist/util/character-id.js',
    'server/dist/util/text-match.js',
    'server/dist/audio/segments-io.js',
    'server/dist/analyzer/narrator-identity.js',
    'server/dist/analyzer/fold-minor-cast.js',
  ];
  for (const rel of need) {
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
      throw new Error(
        `Missing compiled server module: ${rel}\n` +
          `This script reuses the server's own id-resolution logic (buildCastResolver, ` +
          `normaliseForMatch, normaliseIdKey, retireCharacterId, loadSegmentsFiles) rather ` +
          `than re-implementing it. Run "cd server && npm run build" (or the root ` +
          `"npm run build") first, then re-run this script.`,
      );
    }
  }
  const [castResolve, castIdHistory, characterId, textMatch, segmentsIo, narratorIdentity, foldMinorCast] =
    await Promise.all([
      import('../server/dist/store/cast-resolve.js'),
      import('../server/dist/store/cast-id-history.js'),
      import('../server/dist/util/character-id.js'),
      import('../server/dist/util/text-match.js'),
      import('../server/dist/audio/segments-io.js'),
      import('../server/dist/analyzer/narrator-identity.js'),
      import('../server/dist/analyzer/fold-minor-cast.js'),
    ]);
  return {
    buildCastResolver: castResolve.buildCastResolver,
    loadCastIdHistory: castIdHistory.loadCastIdHistory,
    retireCharacterId: castIdHistory.retireCharacterId,
    castIdHistoryPath: castIdHistory.castIdHistoryPath,
    normaliseIdKey: characterId.normaliseIdKey,
    normaliseForMatch: textMatch.normaliseForMatch,
    loadSegmentsFiles: segmentsIo.loadSegmentsFiles,
    reservedIds: new Set([...narratorIdentity.NARRATOR_CHARACTER_IDS, foldMinorCast.MALE_BUCKET_ID, foldMinorCast.FEMALE_BUCKET_ID]),
  };
}

/* Walk every rendered segments file for a book and collect, per orphaned
   characterId (i.e. `resolver.resolve(characterId)` misses), the segment
   count / per-chapter breakdown (with an approximate affected duration
   summed from each segment's own startSec/endSec) / every non-empty
   characterSnapshot seen. Uses the REAL resolver — never re-derives "does
   this id resolve" locally. */
async function collectSegmentOrphans(bookDir, chapters, cast, history, mods) {
  const resolver = mods.buildCastResolver(cast.characters, {
    supersededBy: history.supersededBy ?? {},
    rejected: history.rejected ?? [],
  });
  const segs = await mods.loadSegmentsFiles(bookDir, chapters);
  const orphans = new Map(); // id -> { segments, chapters: [{chapterId,chapterTitle,segments,durationSec}], snapshots: [] }
  for (const seg of segs) {
    const perChapterCount = new Map(); // id -> count
    const perChapterDuration = new Map(); // id -> seconds
    for (const s of seg.segments ?? []) {
      const id = s.characterId;
      if (typeof id !== 'string') continue;
      const resolution = resolver.resolve(id);
      if (resolution) continue; // resolves (exact/history/normalised) — not an orphan
      perChapterCount.set(id, (perChapterCount.get(id) ?? 0) + 1);
      if (typeof s.startSec === 'number' && typeof s.endSec === 'number') {
        perChapterDuration.set(id, (perChapterDuration.get(id) ?? 0) + Math.max(0, s.endSec - s.startSec));
      }
    }
    for (const [id, count] of perChapterCount) {
      if (!orphans.has(id)) orphans.set(id, { segments: 0, chapters: [], snapshots: [] });
      const entry = orphans.get(id);
      entry.segments += count;
      entry.chapters.push({
        chapterId: seg.chapterId,
        chapterTitle: seg.chapterTitle,
        segments: count,
        durationSec: perChapterDuration.get(id) ?? 0,
      });
      const snapshot = seg.characterSnapshots?.[id];
      if (snapshot) entry.snapshots.push(snapshot);
    }
  }
  return orphans;
}

function backupCastIdHistory(historyPath) {
  if (!fs.existsSync(historyPath)) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = `${historyPath}.bak.id-drift-${stamp}`;
  fs.copyFileSync(historyPath, backupPath);
  return backupPath;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const workspaceDir = resolveWorkspaceDir();
  const cacheDir = resolveCacheDir();
  const port = Number(process.env.PORT ?? 8080);

  console.log('=== #2040 Wave 3 cast id-drift repair pass ===');
  console.log(`mode: ${apply ? 'APPLY (writing cast-id-history.json)' : 'DRY RUN (no writes)'}`);
  console.log(`workspace: ${workspaceDir}`);
  console.log(`cache dir: ${cacheDir}`);
  console.log(`  (git-ignored + per-checkout — override with CACHE_DIR if this book's analysis ran elsewhere)`);

  if (apply) {
    const reachable = await probeHealth(port);
    if (reachable) {
      console.error(
        `\nRefusing --apply: a server answered http://localhost:${port}/api/health. ` +
          `This script writes cast-id-history.json out-of-process, which no in-process lock ` +
          `covers (spec §10) — stop the server, or run against a different PORT.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const mods = await loadServerModules();
  const books = collectBooks(workspaceDir);
  console.log(`books scanned: ${books.length}\n`);

  let totalAuto = 0;
  let totalAutoSegments = 0;
  let totalReport = 0;
  let totalReportSegments = 0;
  let totalSkipped = 0;
  const allRerenderRows = [];
  const pendingWrites = []; // { bookDir, historyPath, autoRecord }

  for (const book of books) {
    const history = await mods.loadCastIdHistory(book.bookDir);
    const chapters = book.state.chapters.map((c) => ({ id: c.id, slug: c.slug, title: c.title }));

    const segmentOrphans = await collectSegmentOrphans(book.bookDir, chapters, book.cast, history, mods);
    // attach chapterTitle from state.chapters (segments.json's own chapterTitle
    // can be stale/absent on older renders)
    const titleById = new Map(chapters.map((c) => [c.id, c.title]));
    for (const orphan of segmentOrphans.values()) {
      for (const ch of orphan.chapters) {
        if (!ch.chapterTitle) ch.chapterTitle = titleById.get(ch.chapterId) ?? `chapter ${ch.chapterId}`;
      }
    }

    const cache = readAnalysisCache(cacheDir, book.state.manuscriptId);
    const cacheNameIndex = buildNameIndex(cacheEntriesOf(cache), mods.normaliseForMatch);
    const bakNameIndex = buildNameIndex(collectBakNameEntries(book.audiobookDir), mods.normaliseForMatch);

    const plan = planBookRepairs(
      {
        liveCast: book.cast.characters,
        history,
        cacheNameIndex,
        bakNameIndex,
        orphans: segmentOrphans,
      },
      { normaliseForMatch: mods.normaliseForMatch, normaliseIdKey: mods.normaliseIdKey, reservedIds: mods.reservedIds },
    );

    const rerenderRows = buildRerenderRows(book.label, segmentOrphans);
    allRerenderRows.push(...rerenderRows);

    if (plan.autoRecord.length === 0 && plan.reportOnly.length === 0 && plan.skipped.length === 0) continue;

    console.log(`--- ${book.label} ---`);
    if (plan.autoRecord.length) {
      console.log('  AUTO-RECORD (Tier A/B):');
      for (const a of plan.autoRecord) {
        console.log(`    ${a.id} -> ${a.to}  [Tier ${a.tier}] ${a.evidence}`);
        if (a.segments) console.log(`      ${a.segments} rendered segment(s) carry this id`);
        totalAuto += 1;
        totalAutoSegments += a.segments;
      }
    }
    if (plan.reportOnly.length) {
      console.log('  REPORTED (needs a human decision):');
      for (const r of plan.reportOnly) {
        console.log(`    ${r.id} (${r.segments} segment(s) across ${r.chapters.length} chapter(s))`);
        console.log(`      ${r.reason}`);
        if (r.candidates.length) {
          const top = r.candidates
            .slice(0, 3)
            .map((c) => `${c.liveName ?? c.liveId} (${c.liveId}, score ${c.score.toFixed(0)})`)
            .join('; ');
          console.log(`      ranked candidates: ${top}`);
        }
        totalReport += 1;
        totalReportSegments += r.segments;
      }
    }
    if (plan.skipped.length) {
      console.log('  SKIPPED:');
      for (const sItem of plan.skipped) {
        console.log(`    ${sItem.id} — ${sItem.reason}: ${sItem.detail}`);
        totalSkipped += 1;
      }
    }
    console.log('');

    if (plan.autoRecord.length) {
      pendingWrites.push({ bookDir: book.bookDir, historyPath: mods.castIdHistoryPath(book.bookDir), autoRecord: plan.autoRecord });
    }
  }

  if (allRerenderRows.length) {
    console.log('--- Re-render list (book / chapter / orphaned id / segments / ~duration) ---');
    for (const row of allRerenderRows) {
      console.log(
        `  ${row.book} | ch${row.chapterId} "${row.chapterTitle}" | ${row.id} | ${row.segments} seg | ~${formatDuration(row.durationSec)}`,
      );
    }
    console.log('');
  }

  console.log('--- Summary ---');
  console.log(`books scanned: ${books.length}`);
  console.log(`auto-recordable aliases: ${totalAuto} (${totalAutoSegments} segment(s))${apply ? '' : ' — dry run, nothing written'}`);
  console.log(`reported for human decision: ${totalReport} id(s) / ${totalReportSegments} segment(s)`);
  console.log(`skipped (already recorded / rejected): ${totalSkipped}`);
  console.log(`re-render candidates: ${allRerenderRows.length} chapter row(s)`);

  if (apply && pendingWrites.length) {
    console.log('\nWriting cast-id-history.json aliases...');
    for (const w of pendingWrites) {
      const backupPath = backupCastIdHistory(w.historyPath);
      if (backupPath) console.log(`  backed up ${w.historyPath} -> ${backupPath}`);
      for (const a of w.autoRecord) {
        await mods.retireCharacterId(w.bookDir, a.id, a.to);
        console.log(`  recorded ${a.id} -> ${a.to} (${w.bookDir})`);
      }
    }
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
  });
}
