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
 *   Tier B — id-shape match via the server's own `buildCastResolver`'s
 *            `'normalised-id'` tier (built here with EMPTY history, so
 *            only id-shape counts, no aliasing) — NOT a hand-rolled
 *            `normaliseIdKey` comparison; see `resolveTierBId`'s doc
 *            comment for why a second matcher with its own tie rule was a
 *            real bug caught in review round 1.
 * A segment orphan that Tier A/B-matches a LIVE cast id would already have
 * resolved through `buildCastResolver`'s own normalised-id tier and so
 * never reaches this script's orphan set at all — Tier B only has
 * theoretical bite here for a cache-only orphan that was never rendered,
 * and even then (review round 1, Important 2 below) a cache-only match
 * never auto-records anyway. Anything else (including every book's
 * `cast.json.bak.*` name and the frozen `characterSnapshots`
 * tone/gender/ageRange/attributes signal) is a RANKING signal only,
 * surfaced for a human decision, never auto-applied.
 *
 * THREE additional guards, beyond the two tiers, gate auto-record — the
 * first round of independent review found the first tier-A/B pass alone
 * was not safe (two Criticals: see git history / the paired report for
 * the full account):
 *
 *   1. **Reserved-source refusal.** A reserved fold-bucket id
 *      (`unknown-male`/`unknown-female`) is NEVER auto-recorded book-wide
 *      as a SOURCE, whatever the evidence looks like — plan 122's own
 *      invariant (`fold-minor-cast.ts:349-354`): the bucket is a
 *      many-to-one shared slot by construction, several different real
 *      people can render under it across one book's chapters, never a
 *      single renamed character. (Confirmed on Exile: the cache names
 *      `unknown-male` Timkin/Brant/Dwarf/Rex/Lord Cassius across five
 *      different chapters; a single bak-file "Timkin" snapshot is real
 *      evidence for ONE occurrence, not license to alias the whole id.)
 *   2. **Cross-source ambiguity veto.** If EITHER the analysis cache OR
 *      any `cast.json.bak.*` names an id more than one distinct thing,
 *      NEITHER source may auto-record it — an ambiguous source is direct
 *      evidence the id was reused, and a different, unambiguous source
 *      does not erase that evidence.
 *   3. **Zero-segment scoping (Important 2).** A name/id match against an
 *      id with NO rendered segments (cache-only, never rendered) is
 *      report-only — this pass repairs on-disk damage, it does not mint
 *      pre-emptive, unreviewed guesses about characters who have never
 *      spoken a rendered line.
 *
 * A fourth guard predates round 1 and is still real, just insufficient
 * alone: **snapshot consistency** (see `snapshotsConsistent`'s own doc
 * comment) downgrades a name match to report-only when the rendered
 * `characterSnapshots` disagree across the chapters the id appears in.
 *
 * This script reuses the server's own id-resolution logic rather than
 * re-implementing it (#2040 Wave 3 review already caught one Critical
 * caused by two independent matchers disagreeing — round 1 of THIS
 * script's own review caught a second instance, in `resolveTierBId`; see
 * its doc comment) — it dynamically imports `buildCastResolver`,
 * `normaliseForMatch`, `loadCastIdHistory`/`retireCharacterId` and
 * `loadSegmentsFiles` straight from the COMPILED server (`server/dist/**`),
 * never from `server/src`.
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
 *                        detection silently sees nothing FOR THAT BOOK — and,
 *                        worse, the cross-source ambiguity veto (guard 2
 *                        below) degrades with it: an empty cache index reads
 *                        as "confirmed unambiguous", not "unknown", so a
 *                        book with no cache evidence can auto-record on
 *                        bak-only evidence alone even if the (unseen) cache
 *                        would have vetoed it. Round-2 review made this
 *                        fail-closed: the script counts every scanned book
 *                        whose cache file is missing, fails to parse, OR
 *                        parses but names zero characters (#2093 residual 1,
 *                        widened by independent-review Critical C1 — a
 *                        present-but-corrupt file, or one that validly
 *                        parses but names nobody, both used to read as
 *                        "available"; it now requires the file to exist,
 *                        parse, AND supply at least one name/id entry, via
 *                        `isCacheAvailable`) and prints that count
 *                        (`booksMissingCache`) in the summary every run —
 *                        but (owner-decided policy, review round 2,
 *                        2026-08-05) that count no longer by itself refuses
 *                        `--apply`. Per-book, `planBookRepairs`'s
 *                        `cacheAvailable` gate still withholds every
 *                        auto-record for a book with unusable cache
 *                        evidence, unconditionally — that safety property
 *                        is unchanged. What DOES refuse the whole `--apply`
 *                        run is `booksWithheldForMissingCache`: the count of
 *                        books where that per-book gate actually withheld a
 *                        REAL auto-record candidate, not merely "this book's
 *                        cache happens to be unusable" — a book with no
 *                        cache evidence and nothing that would have
 *                        auto-recorded anyway (e.g. zero orphaned ids) has
 *                        nothing at stake and must not veto every other
 *                        book's run. See `main()`'s `booksMissingCache` /
 *                        `booksWithheldForMissingCache` and
 *                        `planBookRepairs`'s `cacheAvailable` gate /
 *                        `withheldForMissingCache` return field.
 *   PORT                 loopback port the --apply liveness probe checks (default
 *                        8080, matches server/src/index.ts's own default).
 *                        #2090: the probe also covers this port's own
 *                        auto-rebind range (port..port+19, matching
 *                        listenWithAutoRebind's default maxAttempts) — a
 *                        server that started while PORT was held and
 *                        rebound to PORT+N is otherwise invisible.
 *   LAN_HTTPS_PORT       LAN HTTPS port the --apply liveness probe ALSO checks
 *                        (default 8443, matches server/src/index.ts's own
 *                        default) — npm run dev:lan / start:lan listens here
 *                        too, and is otherwise invisible to the probe.
 *                        Same auto-rebind-range coverage as PORT above.
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
import net from 'node:net';
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

/** Tier B (spec §4.2): does `orphanId` resolve to a live cast id purely
 *  through id-shape normalisation? `resolver` is the server's OWN
 *  `buildCastResolver(liveCast, { supersededBy: {}, rejected: [] })`
 *  (built once per book in `planBookRepairs`, not once per orphan id) —
 *  delegated to rather than re-implemented.
 *
 *  Review round 1: the original version of this function was a SECOND
 *  matcher — `liveCast.filter(c => normaliseIdKey(c.id) === target).length
 *  === 1` — with a tie rule that DIVERGES from the real one.
 *  `cast-resolve.ts:74`'s `put()` only calls two DIFFERENT live ids
 *  sharing a normalised key ambiguous (nulls the slot); two array entries
 *  that happen to carry the IDENTICAL id string are the same character,
 *  not a collision (`m.get(k)?.id !== c.id`). The hand-rolled version
 *  could not make that distinction and would have wrongly refused a
 *  legitimate match on a cast.json with a duplicate row — exactly the
 *  "two independent matchers disagree" defect class #2040 Wave 3 review
 *  already caught once on this issue, reintroduced inside the very script
 *  meant to fix it.
 *
 *  Only `'normalised-id'` counts as a Tier B match: `'exact'` can't fire
 *  (the caller only asks about ids that already failed to resolve live),
 *  and `'history'`/`'normalised-history'` can't fire because `resolver` is
 *  built with an EMPTY history on purpose — Tier B is id-shape only, no
 *  aliasing involved. */
export function resolveTierBId(orphanId, resolver) {
  const resolution = resolver.resolve(orphanId);
  return resolution?.via === 'normalised-id' ? resolution.character.id : undefined;
}

/** True when every non-empty `characterSnapshots` entry gathered for one
 *  orphaned id (across however many chapters it rendered in) AGREES on
 *  every field it actually DEFINES: any two defined `voiceId`s must be
 *  equal, and any two defined `gender` / `ageRange` / `voiceEngine` values
 *  must be equal. Vacuously true for 0 or 1 snapshots, and — this matters —
 *  also vacuously true when a field is simply ABSENT everywhere it's
 *  compared (undefined/null values are filtered out before the conflict
 *  check, so "nobody said anything" can never disagree with itself).
 *
 *  Review round 1, Critical 1: this is NOT a sufficient guard against a
 *  reserved fold-bucket id being reused for different real characters
 *  across a book's chapters — it is a necessary one, but the bucket's own
 *  snapshot is generic ({gender, ageRange, voiceEngine} only, no `voiceId`
 *  most of the time), so several DIFFERENT people rendered under the same
 *  shared bucket id read as "consistent" here precisely because their
 *  snapshots carry no identifying information to disagree ON. Confirmed
 *  against the real workspace: Exile's `unknown-male` snapshots at ch7/33/
 *  60 carry no `voiceId` at all, so this function alone says "consistent"
 *  even though the cache separately shows the id spans Timkin/Rex/an
 *  unnamed third chapter. The corrected design does NOT rely on this
 *  function alone for the reserved-bucket hazard — see the module doc
 *  comment's guard 1 (reserved-source refusal), which is the actual fix.
 *  This function remains real and load-bearing for a DIFFERENT, narrower
 *  case: a non-reserved id whose occurrences carry conflicting NAMED
 *  signal (e.g. two chapters stamp two different `voiceId`s), which the
 *  reserved-id/ambiguity guards don't cover. */
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
 *  `cast-id-history.json` alias, or report it for a human, or skip it
 *  (already recorded, or explicitly rejected by the user — #2040 Task 17's
 *  `rejected` list). Returns `{ autoRecord, reportOnly, skipped,
 *  withheldForMissingCache }` — the last is a COUNT (owner-decided policy,
 *  review round 2, 2026-08-05), not a boolean or a re-derivation of
 *  `!cacheAvailable`: it only increments when an id actually reached and
 *  passed guards 1/2 (a real Tier A/B match, not reserved, not
 *  cross-source-ambiguous) and was THEN withheld solely because
 *  `cacheAvailable` was false. A book can have `cacheAvailable: false` and
 *  `withheldForMissingCache === 0` at the same time — e.g. a book whose
 *  cache parses but names nobody, and which simply has no orphaned id that
 *  would have matched anything anyway; that book has nothing at stake and
 *  `main()` must not let it veto every other book's `--apply` run. This is
 *  the signal `main()` gates the global `--apply` refusal on, not the
 *  broader "this book's cache is unusable" fact (which stays reported, via
 *  `booksMissingCache`, but no longer gates).
 *
 *  Auto-record requires ALL of: Tier A or Tier B match, the id is not a
 *  reserved id (guard 1), neither source is ambiguous for this id (guard
 *  2), the id has at least one rendered segment (guard 3), and every
 *  rendered `characterSnapshots` entry for the id agrees (guard 4,
 *  `snapshotsConsistent`) — see the module doc comment for why round 1
 *  found guard 4 alone insufficient and added the other three.
 *
 *  `deps.normaliseForMatch` and `deps.buildCastResolver` are always the
 *  real server functions in production (dynamically imported from
 *  `server/dist` in `main()`); tests inject their own stand-ins so this
 *  function's OWN logic (ambiguity handling, tier precedence, the four
 *  guards) is verifiable with no build step — see the module doc comment's
 *  Tests section. `deps.reservedIds` mirrors `NARRATOR_CHARACTER_IDS` + the
 *  two fold-bucket ids (imported for real in `main()`), checked on BOTH
 *  the source id (guard 1) and the matched target (a match is never
 *  auto-recorded ONTO a reserved id either — that would misattribute a
 *  real, now-dead character's segments onto a shared slot instead of a
 *  specific person) — both checks go through `normalisedReservedIds`
 *  (#2093 residual 4: the target-side checks used to be a raw
 *  `reservedIds.has(...)`, so a live cast row whose id had drifted to a
 *  case/separator variant of a reserved bucket id, e.g. `Unknown_Male`,
 *  stayed an eligible alias TARGET even though guard 1 already normalises
 *  the SOURCE side the same way).
 *
 *  `input.cacheAvailable` defaults to `false` (#2093 residual 3) — the same
 *  fail-closed posture as every other guard here: an omitted flag reads as
 *  "unknown, refuse", not "confirmed available". The one production caller
 *  (`main()`) always passes it explicitly, computed from whether the book's
 *  analysis-cache file exists AND parses (see `main()`'s `cacheAvailable`
 *  and the module doc comment's `CACHE_DIR` entry) — this default is a
 *  safety net for any future caller that forgets to. */
export function planBookRepairs(input, deps) {
  const { liveCast, history, cacheNameIndex, bakNameIndex, orphans, cacheAvailable = false, autoReconciled } = input;
  const { normaliseForMatch, buildCastResolver, reservedIds, normaliseIdKey } = deps;

  const liveIds = new Set(liveCast.map((c) => c.id));
  const rejectedSet = new Set(history.rejected ?? []);
  const supersededBy = history.supersededBy ?? {};
  // Tier B's own resolver — id-shape only, empty history on purpose (see
  // resolveTierBId's doc comment). Built once per book, not once per id.
  const idOnlyResolver = buildCastResolver(liveCast, { supersededBy: {}, rejected: [] });
  // Round-2 review, guard 1 (MINOR): the reserved-id check below must catch a
  // case/separator-drifted spelling of a reserved bucket id — `unknown_male`,
  // `Unknown-Male` — precisely the drift class #2040 exists to catch, and the
  // raw string comparison this used to be would miss it. Normalised once per
  // book, not once per id, using the same `normaliseIdKey` the server's own
  // `buildCastResolver` id-shape tier uses — NOT a second, hand-rolled
  // comparator (that would reintroduce the exact "two independent matchers"
  // hazard `resolveTierBId`'s own doc comment already fixed once).
  const normalisedReservedIds = new Set([...reservedIds].map((r) => normaliseIdKey(r)));

  const allIds = new Set([...cacheNameIndex.keys(), ...bakNameIndex.keys(), ...orphans.keys()]);

  const autoRecord = [];
  const reportOnly = [];
  const skipped = [];
  // Owner-decided policy (2026-08-05, review round 2): a book with NO cache
  // evidence is safe to leave entirely alone if it has nothing this pass
  // would otherwise have auto-recorded — the missing-cache gate right below
  // (`!cacheAvailable`) only ever fires for an id that ALREADY passed guard
  // 1/2 and found a Tier A/B match, i.e. a real would-be auto-record this
  // book's blind ambiguity veto can't vouch for. Counting THAT event
  // specifically (not merely "this book's cacheAvailable is false") is what
  // lets `main()` refuse `--apply` only for a book with something at stake,
  // instead of one blind-but-empty book (e.g. a real *Unlocked* cache that
  // parses but names nobody, and which currently has zero orphaned ids to
  // begin with) vetoing every other book in the workspace.
  let withheldForMissingCache = 0;

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

    // --- review round 1, Critical 1, guard 1: a reserved id (narrator +
    // the two fold buckets) is NEVER auto-recorded book-wide as a SOURCE,
    // whatever the evidence looks like. Plan 122's own invariant
    // (fold-minor-cast.ts:349-354): a bucket id is a shared MANY-TO-ONE
    // slot by construction — several different real people can render
    // under it across a book's chapters — never a single renamed
    // character, so a book-wide `from -> to` alias is a category error
    // regardless of how clean a single chapter's name evidence looks.
    // (Round 1's repro: Exile's `unknown-male` bak snapshot names ONE
    // occurrence "Timkin", but the cache separately shows the SAME id
    // also rendered as Rex and an unnamed third chapter — auto-recording
    // would have silently routed Rex's lines onto Timkin's voice.)
    if (normalisedReservedIds.has(normaliseIdKey(id))) {
      const evidence = [];
      if (bak?.name) evidence.push(`cast.json.bak.* names one occurrence "${bak.name}"`);
      if (cache?.name) evidence.push(`analysis cache names one occurrence "${cache.name}"`);
      if (bak?.ambiguous) evidence.push(`cast.json.bak.* actually names it ${bak.distinctNames.length} different things (${bak.distinctNames.join(', ')})`);
      if (cache?.ambiguous) evidence.push(`analysis cache actually names it ${cache.distinctNames.length} different things (${cache.distinctNames.join(', ')})`);
      reportOnly.push({
        id,
        segments: orphan.segments,
        chapters: orphan.chapters,
        reason:
          `"${id}" is a reserved fold-bucket/narrator id — a shared slot several different characters can render ` +
          `under across a book (plan 122, fold-minor-cast.ts:349-354), so it is never auto-recorded book-wide ` +
          `regardless of evidence` + (evidence.length ? `; ${evidence.join('; ')}` : ''),
        candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
      });
      continue;
    }

    // --- review round 1, Critical 1, guard 2: cross-source ambiguity
    // veto. An unambiguous source must not "win" over an ambiguous one for
    // the SAME id — an ambiguous source is direct evidence the id was
    // reused, and that evidence does not go away just because a DIFFERENT
    // source happens to be clean. Vetoes BOTH tiers (not just the
    // name-based Tier A): a reused id is unsafe to alias book-wide
    // regardless of which signal produced the candidate.
    const ambiguousSources = [];
    if (bak?.ambiguous) ambiguousSources.push({ source: 'cast.json.bak.*', names: bak.distinctNames });
    if (cache?.ambiguous) ambiguousSources.push({ source: 'analysis cache', names: cache.distinctNames });

    if (ambiguousSources.length > 0) {
      reportOnly.push({
        id,
        segments: orphan.segments,
        chapters: orphan.chapters,
        reason:
          ambiguousSources
            .map((a) => `${a.source} names this id ${a.names.length} different things (${a.names.join(', ')})`)
            .join('; ') + ' — an ambiguous source vetoes an auto-record from EITHER source for this id',
        candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
      });
      continue;
    }

    // Both remaining sources (if present) are individually unambiguous —
    // bak outranks cache (spec §4.7: "stronger still").
    const nameCandidate = bak ? bak.name : cache ? cache.name : undefined;
    const nameSource = bak ? 'cast.json.bak.*' : cache ? 'analysis cache' : undefined;

    let matchedId;
    let tier;
    let evidence;

    if (nameCandidate) {
      const tierAMatch = resolveTierAName(nameCandidate, liveCast, normaliseForMatch);
      // #2093 residual 4: normalised, not raw-string — a live cast row whose
      // id drifted to a case/separator variant of a reserved bucket id
      // (`Unknown_Male`) must still be refused as an alias TARGET, the same
      // way guard 1 already refuses it as a SOURCE (`normalisedReservedIds`
      // built once above, shared by both checks below).
      if (tierAMatch && !normalisedReservedIds.has(normaliseIdKey(tierAMatch))) {
        matchedId = tierAMatch;
        tier = 'A';
        const liveName = liveCast.find((c) => c.id === tierAMatch)?.name;
        evidence = `${nameSource} name "${nameCandidate}" == live "${liveName}" (${tierAMatch})`;
      }
    }
    if (!matchedId) {
      const tierBMatch = resolveTierBId(id, idOnlyResolver);
      // #2093 residual 4 (same normalisation, Tier B side). In practice this
      // branch is defensive rather than independently reachable: a Tier B
      // match means `id` itself normalises the same as `tierBMatch`, so an
      // orphan id that could ever land here would already have tripped
      // guard 1's SOURCE-side reserved check (same normaliser, same key) —
      // kept for symmetry with the Tier A check above, not because a live
      // repro exists.
      if (tierBMatch && !normalisedReservedIds.has(normaliseIdKey(tierBMatch))) {
        matchedId = tierBMatch;
        tier = 'B';
        evidence = `id "${id}" normalises the same as live id "${tierBMatch}"`;
      }
    }

    if (matchedId) {
      // --- round-2 review, Important 1: fail-closed cache-availability
      // gate. Guard 2 (the cross-source ambiguity veto, above) can only see
      // an id as ambiguous through `cacheNameIndex` — if this book's
      // analysis-cache file was never found (missing `CACHE_DIR`, a fresh
      // worktree with no cache of its own), `cacheNameIndex` is silently
      // EMPTY, not "confirmed unambiguous". That is exactly the gap that
      // would have re-opened the bak-unambiguous x cache-ambiguous cell the
      // Critical fix closed — so a match is never auto-recorded for a book
      // whose cache evidence is missing, no matter how clean the bak-only
      // evidence looks. `cacheAvailable` is computed once per book (main())
      // from whether the file both exists AND parses (#2093 residual 1 —
      // see `main()`'s own comment on this), not from whether this
      // PARTICULAR id happens to appear in it.
      if (!cacheAvailable) {
        withheldForMissingCache += 1;
        reportOnly.push({
          id,
          segments: orphan.segments,
          chapters: orphan.chapters,
          reason: `name/id-matched "${matchedId}" (${evidence}) but this book's analysis-cache file was not ` +
            `found — the cross-source ambiguity veto (guard 2) cannot rule out cache ambiguity without it, so ` +
            `auto-record is withheld until CACHE_DIR points at the checkout that ran this book's analysis`,
          candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
        });
        continue;
      }
      // --- guard 4 (pre-existing, still real — see snapshotsConsistent's
      // own doc comment for its narrowed scope post round-1).
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
      // --- review round 1, Important 2, guard 3: scope auto-record to
      // actual on-disk damage. A match with zero rendered segments has
      // nothing to repair today — recording it anyway would be a durable,
      // unreviewed GUESS about a character who has never spoken a
      // rendered line in this book, with no wrong audio on disk to
      // justify it and no reviewer in the loop (spec §4.7 scopes this
      // pass to REPAIR, not pre-emptive cache-only aliasing).
      if (orphan.segments === 0) {
        // --- round-2 review, MINOR finding 4: `orphan.segments === 0` also
        // covers an id that DOES have real rendered segments but was never
        // added to `orphans` because it already auto-reconciles through the
        // resolver's own normalised-id tier (the Cast banner already shows
        // it under "auto-reconciled", not "needs your decision"). Reporting
        // that case with the same "zero rendered segments / no damage to
        // repair" wording is FALSE — it contradicts the banner and inflates
        // the reported segment total with a phantom zero. `autoReconciled`
        // (built alongside `orphans` in `collectSegmentOrphans`) carries the
        // real count and target for exactly this case; only ids genuinely
        // absent from BOTH maps (truly never rendered) get the original
        // reason.
        const reconciled = autoReconciled?.get(id);
        if (reconciled) {
          // #2093 residual 5 incidental fix: this used to hardcode "via the
          // normalised-id tier" — accurate while `autoReconciled` only ever
          // captured that one tier, but no longer accurate now that it also
          // captures 'normalised-history' matches (see
          // `buildOrphansFromSegments`'s doc comment). Worded generically
          // rather than threading the specific `via` value through, since
          // both tiers mean the same thing here: "already resolves live,
          // nothing to repair."
          reportOnly.push({
            id,
            segments: reconciled.segments,
            chapters: [],
            reason: `name/id-matched "${matchedId}" (${evidence}) but this id already auto-reconciles to ` +
              `"${reconciled.resolvedTo}" via a normalised-match tier at render time (${reconciled.segments} real ` +
              `rendered segment(s) already carry the reconciled voice, per the Cast banner's auto-reconciled ` +
              `section) — already fixed, no separate alias needed`,
            candidates: [],
          });
        } else {
          reportOnly.push({
            id,
            segments: 0,
            chapters: [],
            reason: `name/id-matched "${matchedId}" (${evidence}) but this id has zero rendered segments — no ` +
              `damage to repair, so this pass does not pre-emptively alias a never-rendered id`,
            candidates: [],
          });
        }
        continue;
      }
      autoRecord.push({ id, to: matchedId, tier, evidence, segments: orphan.segments, chapters: orphan.chapters });
      continue;
    }

    const reasonParts = [];
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

  return { autoRecord, reportOnly, skipped, withheldForMissingCache };
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

/** #2093 residual 2: `main()`'s global `--apply` refusal — extracted to a
 *  pure decision. **Renamed and re-scoped (owner-decided policy, review
 *  round 2, 2026-08-05):** originally `shouldRefuseApplyForMissingCache`,
 *  gated on ANY scanned book lacking cache evidence (`booksMissingCache >
 *  0`) — but that let one book with unusable cache evidence and NOTHING to
 *  repair (e.g. a real book whose cache validly parses but names nobody,
 *  and which has zero orphaned ids to begin with) veto `--apply` for every
 *  OTHER book in the workspace too, which inverted the point of this pass:
 *  it exists to unblock a real repair run, not add a new way to block one
 *  that was never at risk. Gated instead on `booksWithheldForMissingCache`
 *  — the count of books where `planBookRepairs` actually withheld a real
 *  auto-record candidate specifically because `cacheAvailable` was false
 *  (see `planBookRepairs`'s own `withheldForMissingCache` doc comment). The
 *  safety property is unchanged: `planBookRepairs`'s per-book
 *  `cacheAvailable` gate already guarantees no alias is EVER auto-recorded
 *  for a book whose ambiguity veto is blind, whether or not this global
 *  refusal fires — this function only decides whether the WHOLE run stops
 *  dead or merely proceeds around a book with genuinely nothing at stake.
 *  `booksMissingCache` stays reported in the summary (an operator-visible
 *  fact worth knowing), it just no longer gates.
 *
 *  Scope correction (independent review I3, 2026-08-05, carried over):
 *  this makes the DECISION itself directly unit testable; it does NOT make
 *  `main()`'s WIRING of that decision (that it's actually called with the
 *  right arguments, and that `main()` actually exits 1 on `true`)
 *  testable — `main` isn't exported (it needs `server/dist` built; see the
 *  module doc comment's Tests section), so that wiring remains verified
 *  only by the live dry run. */
export function shouldRefuseApplyForWithheldAutoRecord(apply, booksWithheldForMissingCache) {
  return apply === true && booksWithheldForMissingCache > 0;
}

/** Formats one `reportOnly` row for the console listing (main()). Extracted
 *  as a pure function so its "(N segment(s) across M chapter(s))" suffix is
 *  directly testable — #2093 residual 5 (cosmetic): the auto-reconciled
 *  report branch (`planBookRepairs`'s `autoReconciled` case) has real
 *  rendered segments but an empty `chapters` array (no per-chapter
 *  breakdown is tracked for that tier), so the OLD unconditional suffix
 *  printed the self-contradicting "N segment(s) across 0 chapter(s))" —
 *  a real segment count can never be split across zero chapters. The
 *  chapter-count clause is omitted entirely when `chapters` is empty,
 *  rather than guessing a count. */
export function formatReportRowSummary(r) {
  return r.chapters.length > 0
    ? `${r.id} (${r.segments} segment(s) across ${r.chapters.length} chapter(s))`
    : `${r.id} (${r.segments} segment(s))`;
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

/** Exported (#2093 residual 1) so the fix below — `cacheAvailable` gated on
 *  this function's return value, not mere file existence — is directly unit
 *  testable against a real, deliberately corrupt file on disk, with no
 *  `server/dist` build needed (see the module doc comment's Tests section;
 *  `main()` itself stays unexported/untestable that way). */
export function readAnalysisCache(cacheDir, manuscriptId) {
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

/** #2093 residual 1: does this book's analysis-cache file exist on disk?
 *  Existence ONLY — deliberately weaker than `isCacheAvailable` below.
 *  Retained solely so `main()`'s per-book diagnostic line can tell an
 *  operator "no file at all" apart from "file present but failed to parse"
 *  (the corrupt-file case `isCacheAvailable` also refuses on); it must
 *  never again be the thing that GATES `cacheAvailable` — that was exactly
 *  the fail-open bug: a present-but-corrupt file read as "exists" here even
 *  though `readAnalysisCache` already swallowed the parse failure to
 *  `null`, so the empty `cacheNameIndex` built from that `null` looked
 *  "confirmed unambiguous" to guard 2 instead of "unknown". */
function analysisCacheFileExists(cacheDir, manuscriptId) {
  if (typeof manuscriptId !== 'string' || !manuscriptId) return false;
  return fs.existsSync(path.join(cacheDir, `${manuscriptId}.json`));
}

/** #2093 residual 1 fix (widened by independent-review Critical C1,
 *  2026-08-05): the actual `cacheAvailable` gate. A book's analysis-cache
 *  evidence counts as available only when the file EXISTS, PARSES, **and
 *  names at least one character** — not merely "exists and parses" (that
 *  narrower check was C1's own finding: guard 2, the cross-source
 *  ambiguity veto, doesn't consume "it parsed", it consumes
 *  `cacheEntriesOf(cache)`, and BOTH `stage1.characters` and `chapterCast`
 *  are OPTIONAL per the schema — `server/src/store/analysis-cache.ts:69-77`
 *  — so a validly-parsing cache that names nobody used to pass this gate,
 *  produce an EMPTY `cacheNameIndex`, and leave guard 2 exactly as blind as
 *  a missing file would, without `booksMissingCache` ever counting it.
 *  Measured against the real workspace's cache dir: 76 files parse, 0 are
 *  unparseable, and **10 parse with zero character entries** — one of them
 *  a real book (*Unlocked*, `mns_dLurz4I544`) that also carries bak-only
 *  name evidence guard 2 must not treat as uncontested without the cache's
 *  corroboration/veto. All three refusal states — missing, unparseable,
 *  parses-but-names-nobody — now read the same way here; `main()`'s
 *  diagnostic line still distinguishes them for the operator (see its own
 *  comment). */
export function isCacheAvailable(cacheDir, manuscriptId) {
  const cache = readAnalysisCache(cacheDir, manuscriptId);
  return cache !== null && cacheEntriesOf(cache).length > 0;
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

/** Conservative liveness probe for `--apply` (spec §10): a server holding
 *  this port writes `cast-id-history.json` out-of-process, with no
 *  in-process lock to arbitrate against this script. The stakes cut the
 *  OPPOSITE way from `start-app-prod.mjs`'s own `probeServed` (where
 *  "ambiguous" -> "assume down, try to start anyway" only costs a
 *  duplicate start attempt): here "ambiguous" must mean "assume up,
 *  refuse" — review round 1, Important 1. A raw TCP connect (not an HTTP
 *  GET) so both the plain-HTTP port and the LAN HTTPS port can be probed
 *  the same way with no TLS/self-signed-cert handling needed — this is a
 *  "is anything listening" check, not a health check.
 *
 *  Resolves `true` (refused — safe) ONLY when the socket's own `'error'`
 *  event fires with `code === 'ECONNREFUSED'` — whether that lands
 *  immediately or takes a while, there is no elapsed-time check on it, only
 *  a race against the 4s `timeout` below. Every other outcome — a completed
 *  `'connect'`, the `'timeout'` event winning that race, `ECONNRESET`,
 *  `EACCES`, `EHOSTUNREACH`, any other error code — resolves `false` (NOT
 *  refused, i.e. "possibly live, refuse the write"). A server that is
 *  running but unresponsive within the timeout window (mid-generation, a
 *  blocked event loop, a model load) must not read as absent just because
 *  it missed the window.
 *
 *  **M6 (independent review, 2026-08-05): the default host is `127.0.0.1`,
 *  NOT `'localhost'`.** `'localhost'` is a hostname Node resolves at
 *  connect time, and on Windows can resolve `::1` (IPv6 loopback) before
 *  `127.0.0.1` — so an IPv4-only server would answer on `127.0.0.1` while
 *  this probe's `::1` connection collects a clean `ECONNREFUSED` and reads
 *  "safe", with a live server actually listening. Verified against
 *  `server/src/bind-host.ts`'s `selectBindHost`: the server's default plain-
 *  HTTP bind (no `BIND_HOST`/`HOST` override, the mode `PORT`/8080 targets)
 *  is literally `'127.0.0.1'`, and its LAN-HTTPS bind (`LAN_HTTPS_PORT`/8443)
 *  is `'0.0.0.0'` (all interfaces, which includes `127.0.0.1`) — so probing
 *  `127.0.0.1` explicitly is correct for both configured ports, not a
 *  narrowing. Deliberately NOT also probing `::1` in parallel: on an
 *  IPv6-less box (or one with IPv6 disabled) that would resolve `ENETUNREACH`
 *  for every run, and under this probe's own fail-closed rule (only a
 *  definitive `ECONNREFUSED` counts as safe) that would make `--apply`
 *  refuse unconditionally, everywhere, forever — a worse failure mode than
 *  the narrow, Windows-specific, dual-stack-server gap this leaves: an
 *  IPv6-ONLY server (no IPv4 listener at all) is still invisible to this
 *  probe. Not exploitable via `selectBindHost` above (neither of its two
 *  outputs is IPv6-only), so this residual is real only for a server
 *  started some other way that binds `::1` exclusively. */
function probePortRefused(port, host = '127.0.0.1') {
  return new Promise((resolveP) => {
    const socket = net.connect({ host, port, timeout: 4000 });
    socket.once('connect', () => {
      socket.destroy();
      resolveP(false); // something answered — definitely not refused
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolveP(false); // ambiguous — treat as reachable, not refused
    });
    socket.once('error', (err) => {
      resolveP(err.code === 'ECONNREFUSED');
    });
  });
}

/** How many ports past a configured start port a `listenWithAutoRebind`
 *  server (srv-60, `server/src/crash-logging.ts`) can land on after an
 *  EADDRINUSE — one less than its own `maxAttempts` default of 20
 *  (`opts.maxAttempts ?? 20`; that default isn't itself an exported
 *  constant this script could import, so this mirrors it — keep the two in
 *  sync if that default ever changes). #2090: a server that started while
 *  the configured port (8080 / 8443) was held, and rebound to port+N, was
 *  invisible to a probe that only checked the exact configured port. Both
 *  `PORT`/`LAN_HTTPS_PORT` go through `listenWithAutoRebind` in
 *  `server/src/index.ts`, so both need the widened probe below. */
// Exported so scripts/tests/repair-cast-id-drift.test.mjs can size its own
// fixtures off the real value instead of a hardcoded, driftable copy of 20.
export const AUTO_REBIND_RANGE = 20;

/** Probes every port a `listenWithAutoRebind` server could be bound to
 *  starting from `startPort` (spec §10 / #2090) — the exact configured port
 *  plus every port its own EADDRINUSE rebind could have walked up to.
 *  Reuses `probePortRefused` per candidate port, so it inherits the SAME
 *  fail-closed rule per port (only a definitive `ECONNREFUSED` counts as
 *  "safe"; a timeout, `ENOTFOUND`, `EHOSTUNREACH`, or a non-HTTP listener
 *  all refuse). All `AUTO_REBIND_RANGE` candidates are probed IN PARALLEL,
 *  not serially — the documented answer to "what happens if the range
 *  probe is slow": since every probe races its own independent 4s
 *  `timeout` and they all run concurrently, the WHOLE range probe still
 *  costs at most ~4s wall-clock, not `AUTO_REBIND_RANGE` timeouts stacked
 *  up — and a slow/ambiguous outcome for even one candidate port still
 *  makes the range probe as a whole read as "possibly live, refuse" (a
 *  timeout resolves `false` = not refused, same as today), so there is no
 *  way for the widened range to become LESS fail-closed than the original
 *  single-port probe by taking longer. Returns every port in the range
 *  that did NOT resolve a clear `ECONNREFUSED` — an empty array means every
 *  candidate gave a definitive "nothing is listening". */
export async function probePortRangeRefused(startPort, host = '127.0.0.1') {
  const ports = Array.from({ length: AUTO_REBIND_RANGE }, (_, i) => startPort + i);
  const results = await Promise.all(ports.map((p) => probePortRefused(p, host)));
  return ports.filter((_, i) => !results[i]);
}

async function loadServerModules() {
  const need = [
    'server/dist/store/cast-resolve.js',
    'server/dist/store/cast-id-history.js',
    'server/dist/util/text-match.js',
    'server/dist/util/character-id.js',
    'server/dist/audio/segments-io.js',
    'server/dist/analyzer/narrator-identity.js',
    'server/dist/analyzer/fold-minor-cast.js',
  ];
  for (const rel of need) {
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
      throw new Error(
        `Missing compiled server module: ${rel}\n` +
          `This script reuses the server's own id-resolution logic (buildCastResolver, ` +
          `normaliseForMatch, retireCharacterId, loadSegmentsFiles) rather than re-implementing ` +
          `it. Run "cd server && npm run build" (or the root "npm run build") first, then ` +
          `re-run this script.`,
      );
    }
  }
  // NOTE: `util/character-id.js` (normaliseIdKey) is imported ONLY for
  // planBookRepairs's guard 1 (reserved-id membership test, round-2 review) —
  // review round 1 removed the last direct caller because `resolveTierBId`
  // used to re-derive its own id-shape TIE rule from it; it still delegates
  // tier-B matching to `buildCastResolver` rather than a hand-rolled
  // comparator (see that function's doc comment for why the old version was
  // a second matcher with a divergent tie rule). Reusing the same normaliser
  // for a plain Set-membership check is not that hazard — there is no tie
  // rule to diverge on.
  const [castResolve, castIdHistory, textMatch, characterId, segmentsIo, narratorIdentity, foldMinorCast] = await Promise.all([
    import('../server/dist/store/cast-resolve.js'),
    import('../server/dist/store/cast-id-history.js'),
    import('../server/dist/util/text-match.js'),
    import('../server/dist/util/character-id.js'),
    import('../server/dist/audio/segments-io.js'),
    import('../server/dist/analyzer/narrator-identity.js'),
    import('../server/dist/analyzer/fold-minor-cast.js'),
  ]);
  return {
    buildCastResolver: castResolve.buildCastResolver,
    loadCastIdHistory: castIdHistory.loadCastIdHistory,
    retireCharacterId: castIdHistory.retireCharacterId,
    castIdHistoryPath: castIdHistory.castIdHistoryPath,
    normaliseForMatch: textMatch.normaliseForMatch,
    normaliseIdKey: characterId.normaliseIdKey,
    loadSegmentsFiles: segmentsIo.loadSegmentsFiles,
    reservedIds: new Set([...narratorIdentity.NARRATOR_CHARACTER_IDS, foldMinorCast.MALE_BUCKET_ID, foldMinorCast.FEMALE_BUCKET_ID]),
  };
}

/** Pure core of `collectSegmentOrphans` (#2093 residual 6). Given already-
 *  loaded segments-file records (`segs`, the shape `mods.loadSegmentsFiles`
 *  returns) and a resolver (the real `buildCastResolver` result in
 *  production, a fake with the same `.resolve()` contract in tests), walks
 *  every rendered segment and buckets it into `orphans` (the resolver
 *  misses entirely — per-chapter breakdown, approximate affected duration
 *  from each segment's own startSec/endSec, every non-empty
 *  characterSnapshot) or `autoReconciled` (the resolver hits via EITHER
 *  id-shape tier — round-2 review, MINOR finding 4, widened by residual 5
 *  below).
 *
 *  Exported so the producer half of the auto-reconciled map — previously
 *  proven only by a live dry run against the real workspace, since
 *  `planBookRepairs`'s own tests only ever injected a fake `autoReconciled`
 *  map — has a direct unit test with no fs/`server/dist` dependency (see
 *  the module doc comment's Tests section). `collectSegmentOrphans` itself
 *  stays the thin I/O wrapper that loads `segs` and calls this.
 *
 *  #2093 residual 5: `resolution.via === 'normalised-id'` used to be the
 *  ONLY tier counted as "already reconciles" — but `cast-resolve.ts`'s own
 *  `'normalised-history'` tier (a normalised match through a RECORDED
 *  alias, not just id-shape) is exactly the same "already fixed, no damage
 *  here" case, and was missing. An id that only resolves that way used to
 *  fall through to `orphans.get(id) ?? { segments: 0, ... }` in
 *  `planBookRepairs` and get the misleading "zero rendered segments — no
 *  damage to repair" reason instead of "already auto-reconciles" — the
 *  same contradiction-with-the-Cast-banner shape round-2 already fixed once
 *  for the id-shape tier, reopened here for the alias tier. */
export function buildOrphansFromSegments(segs, resolver) {
  const orphans = new Map(); // id -> { segments, chapters: [{chapterId,chapterTitle,segments,durationSec}], snapshots: [] }
  const autoReconciled = new Map(); // id -> { segments, resolvedTo }
  for (const seg of segs) {
    const perChapterCount = new Map(); // id -> count
    const perChapterDuration = new Map(); // id -> seconds
    for (const s of seg.segments ?? []) {
      const id = s.characterId;
      if (typeof id !== 'string') continue;
      const resolution = resolver.resolve(id);
      if (resolution) {
        if (resolution.via === 'normalised-id' || resolution.via === 'normalised-history') {
          const entry = autoReconciled.get(id) ?? { segments: 0, resolvedTo: resolution.character.id };
          entry.segments += 1;
          autoReconciled.set(id, entry);
        }
        continue; // resolves (exact/history/normalised) — not an orphan
      }
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
  return { orphans, autoReconciled };
}

async function collectSegmentOrphans(bookDir, chapters, cast, history, mods) {
  const resolver = mods.buildCastResolver(cast.characters, {
    supersededBy: history.supersededBy ?? {},
    rejected: history.rejected ?? [],
  });
  const segs = await mods.loadSegmentsFiles(bookDir, chapters);
  return buildOrphansFromSegments(segs, resolver);
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
  const lanPort = Number(process.env.LAN_HTTPS_PORT ?? 8443);

  console.log('=== #2040 Wave 3 cast id-drift repair pass ===');
  console.log(`mode: ${apply ? 'APPLY (writing cast-id-history.json)' : 'DRY RUN (no writes)'}`);
  console.log(`workspace: ${workspaceDir}`);
  console.log(`cache dir: ${cacheDir}`);
  console.log(`  (git-ignored + per-checkout — override with CACHE_DIR if this book's analysis ran elsewhere)`);

  if (apply) {
    // #2090: probes the WHOLE auto-rebind range (the configured port plus
    // every port `listenWithAutoRebind` could have walked up to on
    // EADDRINUSE), not just the exact configured port — a server that
    // started while 8080/8443 was held, and rebound to port+N, used to be
    // invisible to this probe.
    console.log(
      `probing 127.0.0.1:${port}-${port + AUTO_REBIND_RANGE - 1} (HTTP, incl. auto-rebind range) and ` +
        `127.0.0.1:${lanPort}-${lanPort + AUTO_REBIND_RANGE - 1} (LAN HTTPS, incl. auto-rebind range) for a ` +
        `live server...`,
    );
    const [httpNotRefused, lanNotRefused] = await Promise.all([
      probePortRangeRefused(port),
      probePortRangeRefused(lanPort),
    ]);
    const notRefused = [...httpNotRefused, ...lanNotRefused];
    if (notRefused.length) {
      console.error(
        `\nRefusing --apply: port(s) ${notRefused.join(', ')} did not return a clear ECONNREFUSED — treating as ` +
          `possibly-live (spec §10: this script writes cast-id-history.json out-of-process, no in-process lock ` +
          `covers it; a slow-but-alive server — mid-generation, a blocked event loop, loading a model — must ` +
          `refuse, not read as absent just because it missed the probe window, and a rebound server on any port ` +
          `in the auto-rebind range must refuse the same as one on the exact configured port). Stop the server ` +
          `on ${port}-${port + AUTO_REBIND_RANGE - 1} (and LAN HTTPS ${lanPort}-${lanPort + AUTO_REBIND_RANGE - 1} ` +
          `if running), or point PORT/LAN_HTTPS_PORT elsewhere.`,
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
  let booksMissingCache = 0;
  // Owner-decided policy, review round 2: the count that actually gates
  // `--apply` (see shouldRefuseApplyForWithheldAutoRecord's doc comment) —
  // books where planBookRepairs withheld a REAL auto-record candidate for
  // the missing-cache reason, not merely books whose cache happens to be
  // unusable. `withheldBookLabels` makes the refusal message name the
  // specific book(s) an operator needs to act on, rather than just a count.
  let booksWithheldForMissingCache = 0;
  const withheldBookLabels = [];
  const allRerenderRows = [];
  const pendingWrites = []; // { bookDir, historyPath, autoRecord }

  for (const book of books) {
    const history = await mods.loadCastIdHistory(book.bookDir);
    const chapters = book.state.chapters.map((c) => ({ id: c.id, slug: c.slug, title: c.title }));

    const { orphans: segmentOrphans, autoReconciled } = await collectSegmentOrphans(book.bookDir, chapters, book.cast, history, mods);
    // attach chapterTitle from state.chapters (segments.json's own chapterTitle
    // can be stale/absent on older renders)
    const titleById = new Map(chapters.map((c) => [c.id, c.title]));
    for (const orphan of segmentOrphans.values()) {
      for (const ch of orphan.chapters) {
        if (!ch.chapterTitle) ch.chapterTitle = titleById.get(ch.chapterId) ?? `chapter ${ch.chapterId}`;
      }
    }

    // Round-2 review, Important 1: the cross-source ambiguity veto (guard 2
    // in planBookRepairs) can only see cache ambiguity through this file —
    // a MISSING, UNPARSEABLE, or (#2093 residual 1, widened by
    // independent-review Critical C1) VALIDLY-PARSING-BUT-NAMES-NOBODY
    // cache file must never silently read as "confirmed unambiguous".
    // `cacheAvailable` is a per-book fact — does the file exist, parse, AND
    // supply usable evidence — computed independently of whether THIS
    // book's cache happens to name any of its orphaned ids specifically.
    // Gated on `isCacheAvailable` (exists+parses+non-empty), not
    // `analysisCacheFileExists` (exists only, which read a
    // present-but-corrupt OR present-but-empty file as "available" — the
    // exact fail-open shape the round-2 fix closed one level up, reopened
    // here twice).
    const cacheAvailable = isCacheAvailable(cacheDir, book.state.manuscriptId);
    if (!cacheAvailable) booksMissingCache += 1;
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
        cacheAvailable,
        autoReconciled,
      },
      {
        normaliseForMatch: mods.normaliseForMatch,
        buildCastResolver: mods.buildCastResolver,
        reservedIds: mods.reservedIds,
        normaliseIdKey: mods.normaliseIdKey,
      },
    );

    if (plan.withheldForMissingCache > 0) {
      booksWithheldForMissingCache += 1;
      withheldBookLabels.push(`${book.label} (${plan.withheldForMissingCache} id(s))`);
    }

    const rerenderRows = buildRerenderRows(book.label, segmentOrphans);
    allRerenderRows.push(...rerenderRows);

    if (plan.autoRecord.length === 0 && plan.reportOnly.length === 0 && plan.skipped.length === 0) continue;

    console.log(`--- ${book.label} ---`);
    if (!cacheAvailable) {
      // #2093 residual 1, widened by independent-review Critical C1:
      // distinguish all THREE refusal states for the operator — "no file at
      // all", "file present but failed to parse", and "file present, parses
      // fine, but names zero characters" — even though `isCacheAvailable`
      // now refuses all three identically. `cache` (read above, in scope
      // here) already tells us whether it parsed; `analysisCacheFileExists`
      // (a diagnostic-only helper, never the gate) distinguishes the two
      // parse-failure sub-cases. `cacheAvailable === false` here always
      // means one of these three, never a fourth case.
      let desc, suffix;
      if (cache === null) {
        const fileExists = analysisCacheFileExists(cacheDir, book.state.manuscriptId);
        desc = fileExists ? 'analysis-cache file exists but failed to parse' : 'no analysis-cache file found';
        suffix = fileExists ? ' is not valid JSON' : ' does not exist';
      } else {
        desc = 'analysis-cache file parses but names zero characters';
        suffix = ' has no usable stage1.characters or chapterCast entries';
      }
      console.log(
        `  (! ${desc} for this book — ${path.join(cacheDir, `${book.state.manuscriptId ?? '<no manuscriptId>'}.json`)}` +
          `${suffix}. ` +
          `The cross-source ambiguity veto cannot see cache evidence for this book, so auto-record is withheld ` +
          `for every matched id below until CACHE_DIR points at the checkout that ran this book's analysis.)`,
      );
    }
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
        console.log(`    ${formatReportRowSummary(r)}`);
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
  // Owner-decided policy, review round 2 (2026-08-05): these are now TWO
  // distinct numbers, only one of which gates --apply — printed together,
  // explicitly labelled, so neither reads as the other.
  console.log(
    `books missing analysis-cache evidence: ${booksMissingCache}` +
      (booksMissingCache
        ? ' — the cross-source ambiguity veto cannot see cache evidence for these books, so no auto-record can ' +
          'be recorded for a matched id in them; informational only, does NOT by itself block --apply (see below)'
        : ''),
  );
  console.log(
    `books with an auto-record withheld for missing cache evidence: ${booksWithheldForMissingCache}` +
      (booksWithheldForMissingCache
        ? ` — THIS is what blocks --apply: ${withheldBookLabels.join('; ')}`
        : ' — --apply is not blocked by cache evidence'),
  );

  // Round-2 review, Important 1 (original): refuse --apply outright when a
  // scanned book's blind ambiguity veto actually had something at stake.
  // Re-scoped by owner-decided policy, review round 2 (2026-08-05): the
  // ORIGINAL version of this refusal fired on ANY book missing cache
  // evidence (booksMissingCache > 0), which let one book with unusable
  // cache evidence and NOTHING to repair veto every other book's --apply
  // run — inverting the point of this pass. planBookRepairs's per-book
  // cacheAvailable gate already guarantees no alias is EVER auto-recorded
  // for a book whose ambiguity veto is blind (see its own doc comment) —
  // that safety property does not depend on this global refusal at all.
  // This refusal now fires only when withholding actually happened
  // (booksWithheldForMissingCache > 0), so a blind-but-empty book no longer
  // blocks a run it was never going to affect.
  if (shouldRefuseApplyForWithheldAutoRecord(apply, booksWithheldForMissingCache)) {
    console.error(
      `\nRefusing --apply: ${booksWithheldForMissingCache} scanned book(s) had a real auto-record candidate ` +
        `withheld because their analysis-cache evidence is unusable at CACHE_DIR (${cacheDir}): ` +
        `${withheldBookLabels.join('; ')}. The cross-source ambiguity veto (guard 2) can only see an id as ` +
        `ambiguous through the cache — unusable cache evidence makes every matched id in that book look ` +
        `unambiguous whether or not it actually is, silently re-opening the exact bak-unambiguous x ` +
        `cache-ambiguous cell the reserved-source/ambiguity-veto fix exists to close. Point CACHE_DIR at the ` +
        `checkout that actually ran these books' analysis (see the module doc comment) and re-run — the dry run ` +
        `above must report "books with an auto-record withheld for missing cache evidence: 0" before --apply is ` +
        `safe. (A nonzero "books missing analysis-cache evidence" count alone does NOT block --apply — only a ` +
        `book with a real withheld candidate does.)`,
    );
    process.exitCode = 1;
    return;
  }

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
