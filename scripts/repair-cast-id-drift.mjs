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
 * #2107 (widened by owner decision, 2026-08-05): a segment orphan whose raw
 * characterId normalised-matches a LIVE cast id DOES still resolve through
 * `buildCastResolver`'s own `'normalised-id'` tier at collection time — but
 * that only proves no RENAME happened, not that the rendered bytes are
 * correct (`buildOrphansFromSegments`'s doc comment has the full argument
 * and the real counter-example, register row A32), so it lands in this
 * script's orphan set anyway rather than being silently excluded. Tier B
 * re-runs the same id-shape match with an EMPTY history and re-confirms the
 * same target, so it is this script's live path for auto-recording that
 * exact case — not merely theoretical bite for a cache-only orphan that was
 * never rendered, which (review round 1, Important 2 below) still never
 * auto-records regardless of tier. Anything else (including every book's
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
 *      does not erase that evidence. Both halves of this veto have their
 *      OWN availability gate protecting them (#2097/#2135): cache evidence
 *      that is missing, unparseable, or empty makes `cacheAvailable` false;
 *      bak evidence that exists but could not be read/parsed makes
 *      `bakAvailable` false (zero bak files, the normal case, does NOT —
 *      see `collectBakNameEntries`'s own doc comment). Either flag being
 *      false withholds every matched id in the book (`planBookRepairs`'s
 *      `cacheAvailable`/`bakAvailable` gates, both LAST in the guard chain
 *      — see that function's own doc comment) — the guard would otherwise
 *      read "evidence I could not read" as "evidence that says nothing",
 *      i.e. clean, when it should read as unknown.
 *   3. **Zero-segment scoping (Important 2).** A name/id match against an
 *      id with NO rendered segments (cache-only, never rendered) is
 *      report-only — this pass repairs on-disk damage, it does not mint
 *      pre-emptive, unreviewed guesses about characters who have never
 *      spoken a rendered line.
 *
 * A fourth guard predates round 1 and is still real, but **narrower than it
 * looks, and asymmetric in a way that matters** (#2134): **snapshot
 * consistency** (see `classifySnapshotEvidence`'s and `snapshotsConsistent`'s
 * own doc comments) downgrades a name match to report-only when the rendered
 * `characterSnapshots` disagree across the chapters the id appears in.
 * `characterSnapshots` is a FILE-level map written ONLY for an id that was
 * LIVE in `cast.json` at render time — for a drifted id (exactly what this
 * pass repairs), that key is never the orphaned id itself, so the lookup
 * finds nothing, `orphan.snapshots` comes back `[]`, and this guard used to
 * pass VACUOUSLY (`snapshotsConsistent([])` is trivially `true`) for exactly
 * the ids it exists to protect (register row A32's `the-torment`/
 * `lightning-dave`).
 *
 * `classifySnapshotEvidence` correctly names that "never found any evidence"
 * state 'no-evidence', distinct from "checked, agrees" — but a first-round
 * fix that turned 'no-evidence' into a VETO (withholding auto-record) was
 * itself wrong, caught by independent review with a decisive real-data
 * replay: snapshot ABSENCE for this population is not neutral, it is the
 * damage signal. A snapshot exists only for an id that was live at render
 * time, so **presence means the audio already rendered correctly**
 * (drift happened after the render, metadata-only fix) and **absence means
 * the narrator was substituted** (the actual A32 damage class this pass
 * exists to fix). Vetoing on absence therefore blocks exactly the aliases
 * that repair real damage and passes exactly the aliases that needed no
 * repair at all — replayed against the real workspace, it would have
 * blocked two of the three aliases the owner already applied and accepted
 * (register row A33: `mayrin`, `coalfall`) while letting the one
 * already-fine alias (`lady-alina`) through. A check that structurally
 * cannot pass for its own target population is not fail-closed protection;
 * it is the inverse of the vacuous `true` it replaced. So: 'no-evidence'
 * now flows through to auto-record, subject to every remaining guard, with
 * an honest annotation ("guard 4 not evaluable") on the row and console
 * line instead of a false claim of verification — 'conflict' is unaffected
 * and still downgrades to report-only. This guard, and the candidate
 * ranker downstream of it (`rankSnapshotCandidates`, whose own doc comment
 * has the full account), are genuinely load-bearing ONLY for a
 * non-reserved id whose snapshots exist but conflict — never for a
 * drifted id with no snapshot evidence at all, where they have nothing to
 * check and correctly say so rather than blocking or guessing. A
 * considered lookup change (resolving through the id's live resolution
 * instead of its raw spelling) was rejected: checked against the real
 * workspace, these ids have no snapshot entry under ANY spelling, so there
 * is nothing a smarter lookup would find. Also considered and rejected:
 * splitting the annotation-vs-veto question by Tier A vs Tier B — it would
 * restore only the `the-torment`-shaped case (Tier B, already resolves via
 * `'normalised-id'`) while still blocking every `mayrin`-shaped Tier A case,
 * where there is no id-shape fallback and the alias is the only mechanism
 * that reconnects the id. NOT because the Tier B case is low-stakes or a
 * no-op, the way an earlier version of this comment argued — #2107
 * (register row A32, `the-torment` itself) proved the opposite: a
 * `'normalised-id'` match resolves correctly today but says nothing about
 * whether the rendered bytes are correct, so recording the alias is real
 * work, not cosmetic promotion. The split stays rejected on its own
 * narrower merits — it would leave every Tier A case (the more common,
 * more damaging shape) still blocked.
 *
 * A fifth guard was added on top of these four, independently, by the
 * #2107 widening (Important 2, independent review, 2026-08-05) —
 * **current-resolution conflict veto**: widening #2107 to list a
 * `'normalised-id'` match as an orphan (spec: see
 * `buildOrphansFromSegments`'s doc comment) means an id that ALREADY
 * resolves live to one character can now also reach Tier A/B matching —
 * and Tier A (a NAME match) is tried before Tier B (the SAME id-shape
 * resolution), with nothing checking whether they agree. A stale cache
 * entry naming a different character can otherwise repoint real segments'
 * attribution onto the WRONG live character, durably (`'history'`
 * outranks `'normalised-id'` at resolve time once written). Before
 * trusting a Tier A/B match, this guard asks the SAME real resolver
 * `historyResolver` what `id` resolves to today — if that is
 * `'normalised-id'` to a DIFFERENT live character than the match found,
 * that is two evidence sources disagreeing, not a repair: report it for a
 * human, never write it. A genuine Tier B match can never trip this (Tier
 * B and the resolver's own `'normalised-id'` tier are the identical
 * computation over the same live cast); only Tier A can. Named "guard 5"
 * in the code, not "guard 4" — added after guard 4 existed, though it
 * happens to run before it (guard numbering here tracks when a guard was
 * added, not execution order; guard 3 already runs after guard 4 today).
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
 *   WORKSPACE_DIR        workspace root (same var the server's .env uses —
 *                        but this script does NOT read server/.env itself,
 *                        deliberately: it must be pointed at the workspace
 *                        explicitly, the same way CACHE_DIR is. #2108: a
 *                        bare invocation on a box whose real workspace is
 *                        configured only in server/.env silently falls
 *                        through to the <home>/AudiobookWorkspace default
 *                        below, scanning ZERO books — `--apply` now refuses
 *                        outright on a zero-book scan rather than reading
 *                        that as a clean, fully-examined workspace (see
 *                        `shouldRefuseApplyForEmptyScan`). Resolving
 *                        WORKSPACE_DIR from server/.env automatically was
 *                        considered and deliberately deferred — a design
 *                        call about where this script's own configuration
 *                        comes from, not a safety fix.
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
 *
 *                        #2135: bak evidence (`cast.json.bak.*`, read directly
 *                        from each book's own `.audiobook/` dir — no separate
 *                        env var, there is nowhere else it could live) has
 *                        the SAME fail-closed gate, `bakAvailable`, with a
 *                        DIFFERENT "unavailable" bar: zero bak files is the
 *                        NORMAL case (most books never accumulate one) and
 *                        leaves `bakAvailable` true; only a bak file that
 *                        EXISTS but could not be read or parsed sets it
 *                        false. See `collectBakNameEntries`'s own doc
 *                        comment for the full reasoning and
 *                        `planBookRepairs`'s `bakAvailable` gate /
 *                        `withheldForMissingBak` return field for the
 *                        per-book write-side consequence.
 *
 *                        #2097: a book whose `cast.json` and/or `state.json`
 *                        (found via `WORKSPACE_DIR`, above) are genuinely
 *                        MISSING — including the ordinary "`state.json`
 *                        present, `cast.json` not yet written" mid-import
 *                        shape, judged per file, not "neither file exists at
 *                        all" — is `collectBooks`'s legitimate
 *                        `'not-yet-analysed'` case and is merely logged. A
 *                        book where either file EXISTS but fails to parse or
 *                        validate is `'unreadable'` — evidence loss, not
 *                        absence — and
 *                        refuses `--apply` outright
 *                        (`shouldRefuseApplyForUnreadableBooks`): unlike the
 *                        cache/bak gates above, there is no config knob that
 *                        fixes an unreadable book by pointing elsewhere, and
 *                        this pass cannot scan it at all (no cast, no
 *                        chapter list), so it cannot rule out orphaned
 *                        segments sitting unprotected in it.
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
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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

/** #2134: `orphan.snapshots === []` is otherwise ambiguous between two
 *  different facts — "every rendered segment's `characterSnapshots` entry
 *  for this id agreed (or there were 0/1 to compare)" and "this id has
 *  rendered segments, but `characterSnapshots` is a FILE-level map written
 *  ONLY for an id that was LIVE in cast.json at RENDER time, so a drifted
 *  id's own segments never match under their own key at all" —
 *  `snapshotsConsistent([])` returns `true` for both, which lets guard 4
 *  pass VACUOUSLY for exactly the ids this pass exists to repair (register
 *  row A32's `the-torment`/`lightning-dave`: both have real rendered
 *  segments and zero snapshot entries, because their `characterSnapshots`
 *  keys are the pre-drift live ids `the_torment`/`lightning_dave`, never
 *  their own orphaned spelling).
 *
 *  This function is the SAME distinguishing test guard 3 (zero-segment
 *  scoping) already makes just below guard 4's call site — `orphan.segments
 *  > 0` — reused here for a narrower purpose: "there is real rendered
 *  damage, but zero snapshot evidence exists under this id's own key" is a
 *  DIFFERENT state than "there is genuinely nothing rendered at all" (that
 *  stays guard 3's job, unchanged), and a different state again from
 *  "checked, and it agrees" or "checked, and it conflicts" (both still
 *  `snapshotsConsistent`'s job). Four states in, three states out on
 *  purpose: 'no-evidence' is new; 'consistent'/'conflict' are
 *  `snapshotsConsistent`'s existing boolean, renamed to a string — `false`
 *  is not one of the three values this returns, so a caller can't reuse a
 *  loose truthy check across both this function and `snapshotsConsistent`;
 *  `'no-evidence'` is itself still truthy as a JS value, so a caller MUST
 *  compare against the literal string explicitly (`=== 'no-evidence'` /
 *  `=== 'conflict'` / `=== 'consistent'`), not merely test presence.
 *
 *  IMPORTANT (round 2, independent review, 2026-08-05) — what a caller does
 *  with 'no-evidence' is NOT "veto". `characterSnapshots` is written only
 *  for a LIVE id at render time, and by construction every id reaching this
 *  function via `planBookRepairs` is NOT a live id today (that is what
 *  makes it an orphan) — so for this population, snapshot ABSENCE is not
 *  neutral, it is anti-correlated with the very risk a veto would be meant
 *  to catch: presence means the id was live at render (audio already
 *  correct, drift happened after), absence means the narrator was
 *  substituted (the actual A32 damage class). A round-1 version of this fix
 *  turned 'no-evidence' into a veto and was wrong — replayed against the
 *  real workspace, it would have blocked *Заказ Коалфолла*'s `mayrin`/
 *  `coalfall` (two of the three aliases the owner already applied and
 *  accepted, register row A33) while letting the already-fine `lady-alina`
 *  alias through. See `planBookRepairs`'s guard 4 call site for the full
 *  account and what 'no-evidence' actually does now: flows through to
 *  auto-record with an honest annotation, never a block.
 *
 *  The considered alternative (issue #2134's option 1) was resolving the
 *  lookup through the id's own live resolution instead of its raw spelling —
 *  rejected: checked against the real workspace, the drifted ids this pass
 *  targets have NO snapshot entry under ANY spelling (not the orphaned id,
 *  not the id it resolves to today), so there is nothing a smarter lookup
 *  would find; worse, if it ever DID resolve to a snapshot, that snapshot
 *  would belong to a DIFFERENT character than the one guard 4 is asked
 *  about. Honesty about the gap, not a lookup change and not a veto, is the
 *  fix. */
export function classifySnapshotEvidence(orphan) {
  if (orphan.segments > 0 && orphan.snapshots.length === 0) return 'no-evidence';
  return snapshotsConsistent(orphan.snapshots) ? 'consistent' : 'conflict';
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
 *  suggested — they're not a "who actually said this line" answer.
 *
 *  #2134: this function returns `[]` immediately when `snapshot` is falsy
 *  (the `if (!snapshot) return [];` below) — `orphan.snapshots[0]` is
 *  `undefined` for two DIFFERENT reasons a caller reaches this function:
 *  (a) no name/id match was ever found for the id at all (the final,
 *  generic `reportOnly.push` at the bottom of `planBookRepairs`'s loop —
 *  `pool-player-2`/`silveny`/`sir-harding` on the real workspace are this
 *  shape, and none of them ever reaches `classifySnapshotEvidence`, since
 *  that only runs once a Tier A/B match exists), or (b) a match WAS found
 *  but `classifySnapshotEvidence(orphan) === 'no-evidence'` (round 2,
 *  independent review, 2026-08-05: this no longer means report-only by
 *  itself — see `planBookRepairs`'s guard 4 call site — an id in this
 *  shape may still reach `autoRecord`, just without a ranked-candidates
 *  line, since there is nothing to rank). Either way, there is no snapshot
 *  signal to score against, under any spelling (see
 *  `classifySnapshotEvidence`'s doc comment on why a smarter lookup
 *  wouldn't help either) — this is not a gap to close. The rows that DO
 *  get ranked candidates today are the reserved fold-bucket ids
 *  (`unknown-male`/`unknown-female`) guard 1 refuses outright — and the
 *  module doc comment's guard-1 paragraph already documents THAT snapshot
 *  as generic/non-discriminating. So: this function is real and
 *  load-bearing for the OTHER report-only shape — a non-reserved id whose
 *  snapshots exist but disagree (`classifySnapshotEvidence(orphan) ===
 *  'conflict'`) — never for an id with no evidence at all, matched or
 *  not. Documented here rather than "fixed" because there is nothing to fix:
 *  giving this function evidence
 *  it doesn't have would mean guessing, which is exactly what it exists
 *  not to do. */
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
 *  (already recorded, explicitly rejected id-wide by the user — #2040 Task
 *  17's LEGACY `rejected` list, still honoured unconditionally since those
 *  entries genuinely were recorded as "block every candidate" — or
 *  explicitly rejected against this specific candidate, #2092/#2089's
 *  `rejectedPairs`, checked once a candidate is known — see the guard below
 *  for why it can't run any earlier). Returns `{ autoRecord, reportOnly, skipped,
 *  withheldForMissingCache, withheldForMissingBak }` — the last two are
 *  COUNTS (owner-decided policy, review round 2, 2026-08-05, for cache;
 *  #2135, same policy applied to bak; ordering fixed by pre-merge review
 *  I2, 2026-08-05), not booleans or a re-derivation of `!cacheAvailable` /
 *  `!bakAvailable`: each only increments when an id would have reached
 *  `autoRecord.push` on its own evidence source alone — i.e. it already
 *  passed guard 1 (not reserved), guard 2 (not cross-source-ambiguous),
 *  guard 5 (current-resolution conflict, #2107 widening), guard 4
 *  (`classifySnapshotEvidence`, narrowed by #2134), AND guard 3 (>=1
 *  rendered segment) — and was refused SOLELY because `cacheAvailable` (or
 *  `bakAvailable`) was false. Both availability checks sit LAST in the
 *  guard chain for exactly this reason (I2, extended to bak by #2135): an
 *  id any earlier guard would have refused ANYWAY, cache/bak evidence or
 *  not, must not inflate either count — a single bak entry naming a
 *  retired, never-rendered id in a cache-blind book must not read as "a
 *  real auto-record was withheld here" when nothing was ever going to be
 *  auto-recorded for it. A book can have `cacheAvailable: false` and
 *  `withheldForMissingCache === 0` at the same time (same for bak) — e.g. a
 *  book whose cache parses but names nobody, and which simply has no
 *  orphaned id that would have matched (or reached) anything anyway; that
 *  book has nothing at stake and `main()` must not let it veto every other
 *  book's `--apply` run. These are the signals `main()` gates the global
 *  `--apply` refusal on, not the broader "this book's cache/bak is
 *  unusable" facts (which stay reported, via `booksMissingCache` and its
 *  bak equivalent, but no longer gate). The bak check runs BEFORE the cache
 *  check (bak outranks cache for guard 2, spec §4.7: "stronger still"), so
 *  an id withheld for both reasons at once is counted only under
 *  `withheldForMissingBak` — the two counts are mutually exclusive per id,
 *  never additive.
 *
 *  Auto-record requires ALL of: Tier A or Tier B match, the id is not a
 *  reserved id (guard 1), neither source is ambiguous for this id (guard
 *  2), the id has at least one rendered segment (guard 3), every rendered
 *  `characterSnapshots` entry found under the id's own key agrees (guard 4,
 *  `classifySnapshotEvidence` — narrowed by #2134 to also withhold on
 *  'no-evidence', not merely trust a vacuous `snapshotsConsistent([])`),
 *  and the id doesn't already resolve live to a DIFFERENT character (guard
 *  5, #2107 widening) — see the module doc comment for why round 1 found
 *  guard 4 alone insufficient and added the other three, and why the
 *  #2107 widening later added guard 5 on top.
 *
 *  `deps.normaliseForMatch` and `deps.buildCastResolver` are always the
 *  real server functions in production (dynamically imported from
 *  `server/dist` in `main()`); tests inject their own stand-ins so this
 *  function's OWN logic (ambiguity handling, tier precedence, the five
 *  guards) is verifiable with no build step — see the module doc comment's
 *  Tests section. `input.historyResolver` (built once per book, in
 *  `collectSegmentOrphans`, and threaded through `main()` — see the
 *  `historyResolver` local's own doc comment just below) drives guards
 *  `already-recorded` and 5; a test may omit it, but the default is
 *  fail-closed (I-A, independent review, 2026-08-05) — it builds the REAL
 *  resolver from `liveCast`/`history`, not "nothing resolves via history,
 *  nothing conflicts". `deps.reservedIds` mirrors `NARRATOR_CHARACTER_IDS` + the
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
 *  safety net for any future caller that forgets to.
 *
 *  `input.bakAvailable` (#2135) defaults to `false` too — same fail-closed
 *  reasoning, DIFFERENT real-world baseline: unlike cache (expected to
 *  exist for every analysed book), the overwhelmingly common case for bak
 *  is genuinely zero files, which `collectBakNameEntries` reports as
 *  `bakAvailable: true` (see its own doc comment — "no bak files" and
 *  "confirmed available" are the SAME state for bak, unlike for cache). A
 *  test that omits `bakAvailable` while asserting an auto-record must pass
 *  it explicitly (`bakAvailable: true`), the same as `cacheAvailable`. */
export function planBookRepairs(input, deps) {
  const {
    liveCast,
    history,
    cacheNameIndex,
    bakNameIndex,
    orphans,
    cacheAvailable = false,
    bakAvailable = false,
    // #2128 — ids buildOrphansFromSegments found affirmatively current via a
    // non-'exact' tier. Defaults to an empty Set so every existing caller
    // that predates this field (including this file's own pre-#2128 tests)
    // keeps its prior behaviour: no id is ever treated as "current" unless
    // the caller says so.
    currentNonExact = new Set(),
  } = input;
  const { normaliseForMatch, buildCastResolver, reservedIds, normaliseIdKey } = deps;

  const liveIds = new Set(liveCast.map((c) => c.id));
  const rejectedSet = new Set(history.rejected ?? []);
  // #2092/#2089 Task 9 (fix round 5, F6 — collapsed from an earlier
  // two-keyspace union that was strictly redundant) — pair-scoped successor
  // to `rejected`: `normalisedFrom -> Set<to>`. Only the normalised
  // keyspace is needed: the candidate this filter protects is
  // `resolveTierBId` below, which returns exclusively `via ===
  // 'normalised-id'` matches, so a raw `pair.from === id` match — which
  // normalises to the same key — is already covered by checking normalised
  // alone. Checked once a Tier A/B candidate is known (see below), NOT here
  // alongside the id-wide `rejectedSet` — the whole point of the pair scope
  // is that a rejection against ONE target must not withhold a DIFFERENT,
  // later target for the same orphaned id (spec: "X is not Y" is not "X is
  // not anyone").
  const rejectedTargetsByNormFrom = new Map();
  for (const pair of history.rejectedPairs ?? []) {
    const normFrom = normaliseIdKey(pair.from);
    if (!rejectedTargetsByNormFrom.has(normFrom)) rejectedTargetsByNormFrom.set(normFrom, new Set());
    rejectedTargetsByNormFrom.get(normFrom).add(pair.to);
  }
  // Tier B's own resolver — id-shape only, empty history on purpose (see
  // resolveTierBId's doc comment). Built once per book, not once per id.
  const idOnlyResolver = buildCastResolver(liveCast, { supersededBy: {}, rejected: [] });

  // Important 1 (independent review, 2026-08-05, on the earlier I2 fix): the
  // "already recorded" question — and, per Important 2 below, the "does
  // this id already resolve live" question — is a RESOLVER question, not
  // something to re-derive with a hand-built normalised map. A prior fix
  // (I2) closed a raw-vs-normalised gap in the already-recorded skip by
  // building `supersededByNormKey`, a SECOND normalised map answering "does
  // this id's normalised form appear ANYWHERE in supersededBy" — which
  // diverges from what `cast-resolve.ts`'s real resolver actually decides in
  // three ways: (a) a normalised COLLISION (two different `from` keys
  // normalising the same with different targets) is a deliberate `undefined`
  // in the real resolver (`cast-resolve.ts`'s `put()` nulls the slot) but a
  // last-wins guess in a `Map.set`; (b) the real resolver checks
  // `'normalised-id'` (against the LIVE cast) before `'normalised-history'`
  // (against the alias table) — a flat map has no such precedence, so it
  // can "already-record"-skip an id that is actually a live match today;
  // (c) the real resolver drops a history entry whose target is no longer a
  // live cast id at CONSTRUCTION time — a flat map built from raw
  // `supersededBy` entries does not. Every one of those divergences is a
  // FALSE SKIP: the id vanishes from both `autoRecord` and `reportOnly`,
  // exactly the under-reporting the #2107 widening exists to prevent.
  // `historyResolver` — built with the REAL `history` (unlike
  // `idOnlyResolver` above, which must stay empty-history) — is threaded in
  // from `main()`, which receives it from `collectSegmentOrphans` (which
  // already built one for this exact book); NOT reconstructed in the
  // production path, so there is only ever one real resolver instance per
  // book, never two that could drift apart.
  //
  // I-A (independent review, 2026-08-05, on the Important 1 fix above):
  // this used to default a MISSING resolver to `{ resolve: () => undefined
  // }` — fail-OPEN, the tenth instance of this wave's shape, one level up
  // from the one Important 1 just fixed. `undefined` from `.resolve()`
  // means both "asked, nothing resolves" AND "never asked" — and since this
  // function no longer reads `history.supersededBy` directly at all (that
  // was the whole point of Important 1), a caller that omits
  // `historyResolver` while still passing a fully populated `history` got
  // ZERO protection from either the already-recorded skip or guard 5, with
  // no error. Measured: omitting the resolver on the guard-5 probe fixture
  // (live `the_torment` + `timkin`, orphan `the-torment` 67 real segments,
  // cache names it "Timkin") auto-recorded a 67-segment durable repoint
  // onto the wrong character; with `history.supersededBy` also populated,
  // the already-recorded skip went silently dead too. Exactly the defect
  // `cacheAvailable`'s doc comment above already describes for a DIFFERENT
  // guard ("an omitted flag reads as 'unknown, refuse', not 'confirmed
  // available'") — this one just had the opposite posture. Fixed the same
  // way: default to building the REAL resolver from the args this function
  // already receives (`liveCast`, `history`, `deps.buildCastResolver`) —
  // the identical construction `collectSegmentOrphans` uses — so an omitted
  // `historyResolver` is a (redundant) optimisation for the production
  // path, never a silent correctness hole for any other caller.
  // Round 4 (independent review, 2026-08-05): this used to pass `history`
  // straight through — but `planBookRepairs` treats a PARTIAL history as a
  // supported shape (it defends `history.rejected ?? []` just above), while
  // the real `buildCastResolver` does `Object.entries(history.supersededBy)`
  // (`cast-resolve.ts`), which throws on `undefined`. So this fallback
  // explicitly defends every field `buildCastResolver` reads, unlike its
  // sibling construction in `collectSegmentOrphans` — that one passes
  // `history` UNMODIFIED (#2092/#2089 Task 9), which is correct there
  // because its only production caller (`main()`, via `loadCastIdHistory`)
  // always supplies the full, valid `CastIdHistory` shape; this fallback
  // cannot make that same assumption, since it exists specifically to cover
  // a caller — this function's OWN other, non-production callers, per this
  // whole doc paragraph's I-A finding — that might not. The two
  // constructions therefore look different on purpose: one trusts its
  // single caller's contract, the other can't. Latent today (production's
  // `loadCastIdHistory` always returns the full shape), and neither of the
  // test file's existing resolver stand-ins could have caught a missing
  // field either way: every test that passes a partial `history` and the
  // plain fake `deps.buildCastResolver` (`makeFakeResolver`) is safe only
  // because that fake never reads `history` at all, and every test that
  // uses the REAL-history-reading fake (`makeHistoryAwareFakeResolver`)
  // defends `supersededBy` internally — see the test file's own doc comment
  // on its dedicated round-4 regression test for the resolver stand-in that
  // actually proves this (one that mirrors the real, undefended
  // construction line).
  //
  // #2128, guard 3 (spine rule 2): the WHOLE loaded `CastIdHistory` goes in,
  // never a hand-built subset. Round 4's defended `{supersededBy, rejected,
  // rejectedPairs}` object above (removed by this change) was correct on the
  // day it was written and would have gone stale again the moment a new
  // optional field landed — which is exactly what #2128's `recordedAtSeq` is.
  // A subset that silently drops it makes every alias in the book read
  // 'unknown' forever.
  //
  // Still not a bare `buildCastResolver(liveCast, history)` pass-through:
  // `planBookRepairs` treats a PARTIAL history as a supported input shape
  // (`history: {}` appears throughout this file's own test suite; `history
  // .rejected ?? []` is already defended a few lines up), and the real
  // `buildCastResolver` does `Object.entries(history.supersededBy)` with no
  // internal defence — a `TypeError` on `undefined`. `historyForResolver`
  // below spreads the WHOLE `history` object FIRST, then overrides only the
  // one field `buildCastResolver` reads unconditionally with a safe
  // fallback — every field `history` carries, present or future, passes
  // through untouched, while `supersededBy` is guaranteed defined whether
  // `history` omits the key entirely OR carries it as an explicit
  // `undefined` (round-1 review, M7: a trailing `...history` spread, the
  // first version of this fix, is defeated by the latter shape — an
  // explicit `supersededBy: undefined` copies straight over a leading
  // default and reopens the exact `TypeError` this line exists to
  // prevent). `rejected`/`rejectedPairs` need no equivalent override here:
  // `buildCastResolver` itself already does `history.rejected ?? []` /
  // `history.rejectedPairs ?? []` internally (cast-resolve.ts) — defending
  // them again here would be exactly the hand-picked-subset shape this fix
  // exists to remove, just with more fields enumerated. Guarded against
  // silently narrowing back to a subset by
  // `cast-history-threading.guard.test.ts`'s Guard 3 (syntactic: no literal
  // at the call site) AND `repair-cast-id-drift.test.mjs`'s dedicated
  // "threads every field, not just the ones it defends" behavioural test
  // (round-1 review, I1 — Guard 3 cannot see this local at all, so nothing
  // previously pinned what this line actually threads through).
  const historyForResolver = { ...history, supersededBy: history.supersededBy ?? {} };
  const historyResolver = input.historyResolver ?? buildCastResolver(liveCast, historyForResolver);

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
  // would otherwise have auto-recorded — the missing-cache gate further
  // down (`!cacheAvailable`, last in the guard chain) only ever fires for
  // an id that ALREADY passed guard 1 (not reserved), guard 2 (not
  // cross-source-ambiguous), guard 5 (current-resolution conflict, #2107
  // widening), guard 4 (`snapshotsConsistent`), AND guard 3 (>=1 rendered
  // segment) and found a Tier A/B match — see this function's own doc
  // comment above for why that ordering is deliberate — i.e. a real
  // would-be auto-record this book's blind ambiguity veto can't vouch for.
  // Counting THAT event specifically (not merely "this book's
  // cacheAvailable is false") is what lets `main()` refuse `--apply` only
  // for a book with something at stake, instead of one blind-but-empty
  // book (e.g. a real *Unlocked* cache that parses but names nobody, and
  // which currently has zero orphaned ids to begin with) vetoing every
  // other book in the workspace.
  let withheldForMissingCache = 0;
  // #2135: same accounting as withheldForMissingCache, one guard below it —
  // see the bak-availability gate's own comment at its call site for why
  // bak sits ahead of cache in the guard order.
  let withheldForMissingBak = 0;

  for (const id of allIds) {
    if (liveIds.has(id)) continue; // not an orphan at all

    if (rejectedSet.has(id)) {
      skipped.push({ id, reason: 'rejected', detail: 'user explicitly rejected this reconciliation (Task 17 banner)' });
      continue;
    }
    // Important 1: "does an alias already cover this id" IS the question
    // `historyResolver`'s `'history'`/`'normalised-history'` tiers answer —
    // ask it, rather than re-deriving the decision (see the doc comment on
    // `historyResolver` above for why a hand-rolled second map diverges).
    const aliasHit = historyResolver.resolve(id);
    if (aliasHit && (aliasHit.via === 'history' || aliasHit.via === 'normalised-history')) {
      skipped.push({
        id,
        reason: 'already-recorded',
        detail:
          `cast-id-history.json already maps this to "${aliasHit.character.id}"` +
          (aliasHit.via === 'normalised-history' ? ' (via a normalised-spelling match, not an exact key)' : ''),
      });
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
      // --- #2092/#2089 Task 9: pair-scoped reject filter. Must run here,
      // AFTER `matchedId` is known, not alongside the id-wide `rejectedSet`
      // check above — a pair only blocks THIS candidate, so checking it
      // before a candidate exists would have nothing to compare against and
      // either skip every candidate (id-wide, the bug this replaces) or
      // none. Mirrors `buildCastResolver`'s own D2 rule (`cast-resolve.ts`):
      // a rejected pair refuses outright rather than falling through to try
      // a different tier/candidate for the same id. Checks the normalised
      // keyspace (see `rejectedTargetsByNormFrom`'s own comment above) — a
      // raw match is strictly subsumed by it, and this guard is
      // deliberately broader than `buildCastResolver`'s own per-tier check:
      // it only decides whether to WITHHOLD a write, and over-blocking is
      // the fail-closed direction here, unlike the resolver, which must
      // pick exactly one tier or refuse. Runs BEFORE guard 5 below — an
      // explicit prior rejection of this exact pairing is a settled user
      // decision and should skip outright without also asking whether the
      // two evidence sources agree.
      const blocked = rejectedTargetsByNormFrom.get(normaliseIdKey(id))?.has(matchedId);
      if (blocked) {
        skipped.push({
          id,
          reason: 'rejected-pair',
          detail: `user explicitly rejected pairing "${id}" -> "${matchedId}" (Cast screen "Not the same character")`,
        });
        continue;
      }
      // --- guard 5 (Important 2, independent review on the #2107
      // widening, 2026-08-05): does `id` already resolve LIVE, today, to a
      // DIFFERENT character than this match found? Widening #2107 means an
      // id that resolves via `'normalised-id'` now reaches this matching
      // pipeline (it used to silently reconcile with no write at all) — and
      // Tier A (name) is tried before Tier B (the SAME id-shape check this
      // guard re-asks), so nothing previously stopped a stale cache name
      // from out-voting a live id-shape match. `historyResolver` is the
      // SAME resolver the already-recorded skip above already asked — a
      // Tier-B-sourced match can never trip this (Tier B and this tier are
      // the identical computation over the same live cast, so they always
      // agree); only a Tier A name match can disagree with what `id`
      // already resolves to.
      const currentResolution = historyResolver.resolve(id);
      if (currentResolution?.via === 'normalised-id' && currentResolution.character.id !== matchedId) {
        reportOnly.push({
          id,
          segments: orphan.segments,
          chapters: orphan.chapters,
          reason: `name/id-matched "${matchedId}" (${evidence}) but this id already resolves via id-shape to a ` +
            `DIFFERENT live character, "${currentResolution.character.id}" — two evidence sources disagree; ` +
            `needs a human decision rather than trusting the name match over the live id-shape resolution`,
          candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
        });
        continue;
      }
      // --- guard 4 (pre-existing, still real — see snapshotsConsistent's
      // own doc comment for its narrowed scope post round-1).
      //
      // #2134, round 1: classifySnapshotEvidence's 'no-evidence' outcome
      // was made a VETO here (downgrading to report-only) — WRONG, caught
      // by round-2 review with a decisive real-data replay. `characterSnapshots`
      // is written ONLY for an id that was LIVE in cast.json at render
      // time. For this loop's population (every id here is, by definition,
      // NOT a live id today — that's what makes it an orphan), that fact
      // is anti-correlated with the risk the veto was meant to guard
      // against:
      //   - snapshot PRESENT  => the id WAS live when the chapter
      //     rendered => it rendered in that character's real voice =>
      //     drift happened AFTER the render => metadata-only fix, audio
      //     already correct.
      //   - snapshot ABSENT   => the id was NEVER live at render =>
      //     `resolveGroup` substituted the narrator => the audio is
      //     GENUINELY WRONG — precisely register row A32's damage class,
      //     and precisely the case this whole pass exists to repair.
      // So a veto on 'no-evidence' blocks exactly the aliases that fix
      // real damage and permits exactly the aliases that were already
      // fine. Replayed against the real workspace with `supersededBy`
      // emptied: *Заказ Коалфолла*'s `mayrin` (8 seg) and `coalfall` (13
      // seg) — two of the three aliases the owner already applied and
      // accepted on 2026-08-05 (register row A33) — would have been
      // wrongly blocked by the round-1 veto, while `lady-alina` (already
      // fine, snapshot present) would have sailed through. A check that
      // structurally cannot pass for its target population is not
      // fail-closed protection — it is the mirror image of the vacuous
      // `true` it replaced, costing this pass its entire remaining
      // capability on the population it exists to repair, for a
      // discrimination power of zero.
      //
      // The diagnosis from round 1 stands: `snapshotsConsistent([])`
      // returning `true` really did conflate "never checked" with
      // "checked, all clear" — classifySnapshotEvidence still exists to
      // name that distinction correctly. The fix is to stop CLAIMING
      // guard 4 verified anything for a 'no-evidence' id, not to convert
      // an inapplicable check into a veto: 'no-evidence' now flows through
      // to `autoRecord` (subject to every remaining guard below — 3, then
      // bak/cache availability), carrying an honest annotation instead of
      // a false "verified consistent". Deliberately NOT split by tier
      // (Tier A vs Tier B) — considered and rejected: it would restore
      // only `the-torment` (a Tier B id-shape match, already resolving via
      // `'normalised-id'`) while still blocking every `mayrin`-shaped Tier
      // A case, where the letters differ, there is no `normalised-id`
      // fallback, and the alias is the ONLY mechanism that reconnects the
      // id — exactly the case that matters most. This is NOT because
      // recording `the-torment`'s alias would be a low-stakes no-op — an
      // earlier version of this comment argued exactly that ("same
      // character either way"), which #2107 overturned: register row A32
      // is `the-torment` itself, 67 segments narrator-rendered despite
      // resolving live via `'normalised-id'`. The Cast screen's banner
      // reflects the same correction (src/views/cast.tsx's auto-reconciled
      // section marks an alias-resolved row as "resolves now — existing
      // audio may still need a re-render", not "nothing to do here"). The
      // split stays rejected on the Tier A coverage gap alone, not on any
      // claim that the Tier B case doesn't matter.
      //
      // 'conflict' is unaffected by any of this — real, disagreeing
      // snapshot evidence for a NAMED, non-reserved id (the case
      // `snapshotsConsistent`'s own doc comment describes) is still
      // downgraded to report-only below.
      const snapshotEvidence = classifySnapshotEvidence(orphan);
      if (snapshotEvidence === 'conflict') {
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
      //
      // #2107, widened by owner decision (2026-08-05), then narrowed again
      // by #2128: the skip is "affirmatively current" (`isAudioCurrent ===
      // true`), not "resolves via 'exact'". So `orphan.segments === 0` no
      // longer means one thing — it means EITHER this id genuinely has zero
      // rendered segments anywhere in the book, OR it rendered and every one
      // of those renders is current. `currentNonExact` (buildOrphansFromSegments)
      // is what tells them apart; giving both the same "zero rendered
      // segments" reason would emit a demonstrably false statement about a
      // book with real rendered segments carrying this id, and is one level
      // down from the `autoReconciled` bucket 511c5382 fixed and 30456c71
      // deleted.
      //
      // NEITHER is auto-recorded, for the same unchanged reason: there is no
      // wrong audio on disk to justify a durable, unreviewed alias, and no
      // reviewer in the loop (spec §4.7 scopes this pass to REPAIR).
      if (orphan.segments === 0) {
        const current = currentNonExact.has(id);
        reportOnly.push({
          id,
          segments: 0,
          chapters: [],
          reason: current
            ? `name/id-matched "${matchedId}" (${evidence}) but every rendered segment carrying this id is ` +
              `already current (rendered against the cast-id-history state that established its target) — no ` +
              `damage to repair`
            : `name/id-matched "${matchedId}" (${evidence}) but this id has zero rendered segments — no ` +
              `damage to repair, so this pass does not pre-emptively alias a never-rendered id`,
          candidates: [],
        });
        continue;
      }
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
      //
      // --- I2 (pre-merge review, 2026-08-05): this gate is deliberately
      // LAST, immediately before `autoRecord.push`, not first — moved down
      // past guards 3, 4 and (added later, #2107 widening) 5 above. Before
      // this fix it sat ahead of guards 3/4, so an id that guard 3 (zero
      // segments) or guard 4 (inconsistent snapshots) would have refused
      // ANYWAY — cache evidence or not — still incremented
      // `withheldForMissingCache`, the count that gates
      // the WHOLE workspace's `--apply` run (see `shouldRefuseApplyForWithheldAutoRecord`).
      // A single bak entry naming a retired, never-rendered id in a
      // cache-blind book would have printed `withheld: 1` and refused
      // `--apply` for all twenty books — the exact false-block the
      // round-2 policy change exists to prevent, one guard over. Ordering
      // this last means `withheldForMissingCache` only ever counts an id
      // that would otherwise have reached `autoRecord.push` — an exact
      // count, not an over-count — and its own reason string is only ever
      // shown for a candidate that was genuinely about to be recorded.
      // --- #2097/#2135: bak-availability gate, sitting immediately ahead
      // of the cacheAvailable gate above it (same I2 "deliberately LAST"
      // reasoning — an id any earlier guard would have refused anyway must
      // not inflate this count either). Bak evidence OUTRANKS cache
      // evidence for guard 2 (spec §4.7: "stronger still"), so the
      // unprotected half being the STRONGER half is exactly why #2135 rated
      // this worse than a mirror of the cache gap: `collectBakNameEntries`
      // sets `bakAvailable` false only when this book's bak evidence could
      // not be fully read (readdir failure, or a `cast.json.bak.*` that
      // exists but fails to parse) — NOT merely "zero bak files", which is
      // the normal case and leaves `bakAvailable` true. See that function's
      // own doc comment for the full reasoning and `main()`'s own comment
      // for how it's computed per book.
      if (!bakAvailable) {
        withheldForMissingBak += 1;
        reportOnly.push({
          id,
          segments: orphan.segments,
          chapters: orphan.chapters,
          reason: `name/id-matched "${matchedId}" (${evidence}) but at least one of this book's ` +
            `cast.json.bak.* files could not be read or parsed — the cross-source ambiguity veto (guard 2) ` +
            `cannot rule out bak ambiguity without it, so auto-record is withheld until every cast.json.bak.* ` +
            `for this book is readable`,
          candidates: rankSnapshotCandidates(orphan.snapshots[0], liveCast, reservedIds),
        });
        continue;
      }
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
      // #2134 round 2: `snapshotEvidence` rides along on the row itself
      // ('consistent' or 'no-evidence' — 'conflict' already `continue`d
      // above) so the console line (main()) can say plainly when guard 4
      // had nothing to verify, instead of the row silently implying every
      // guard positively confirmed this alias.
      autoRecord.push({ id, to: matchedId, tier, evidence, segments: orphan.segments, chapters: orphan.chapters, snapshotEvidence });
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

  return { autoRecord, reportOnly, skipped, withheldForMissingCache, withheldForMissingBak };
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
 *  #2135 widened the caller (`planApplyRefusal`) to also count books
 *  withheld for missing BAK evidence, sharing this same decision function —
 *  the parameter below is now a COMBINED "books with something withheld"
 *  count (bak-withheld OR cache-withheld), not cache-only; this function's
 *  own logic (a bare threshold check) needed no change to support that, only
 *  its caller's accounting did.
 *
 *  Scope correction (independent review I3, 2026-08-05, carried over):
 *  this makes the DECISION itself directly unit testable; it does NOT make
 *  `main()`'s WIRING of that decision (that it's actually called with the
 *  right arguments, and that `main()` actually exits 1 on `true`)
 *  testable — `main` isn't exported (it needs `server/dist` built; see the
 *  module doc comment's Tests section), so that wiring remains verified
 *  only by the live dry run. **#2111 narrows, but does not close, this gap
 *  — see `planApplyRefusal`'s own doc comment immediately below.** */
export function shouldRefuseApplyForWithheldAutoRecord(apply, booksWithheldCount) {
  return apply === true && booksWithheldCount > 0;
}

/** #2111: the smallest orchestration seam `main()`'s per-workspace `--apply`
 *  refusal can be pulled through a test without needing `server/dist` or a
 *  live book scan. `main()` calls this ONCE, right after its per-book loop,
 *  with `bookWithholds` — one `{ label, withheldForMissingCache,
 *  withheldForMissingBak }` entry per scanned book (#2135 widened the shape
 *  by one field), built by pushing both `plan.withheldForMissingCache` and
 *  `plan.withheldForMissingBak` straight from each iteration's
 *  `planBookRepairs` result. This is a single source of truth, not a second
 *  computation of the same fact re-derived in a test (`cast-resolve.ts`'s
 *  own doc comment explains why this codebase avoids that shape) —
 *  `main()`'s loop-tail accumulation that used to inline this logic now
 *  calls this function instead of hand-rolling it a second time.
 *
 *  What this closes, on top of `shouldRefuseApplyForWithheldAutoRecord`
 *  alone: the ACCUMULATION across multiple books — a book counts toward the
 *  refusal if EITHER `withheldForMissingCache > 0` OR
 *  `withheldForMissingBak > 0` OR either field is genuinely ABSENT from
 *  its `bookWithholds` entry (round 2 review, defect 7 — see the loop body
 *  below for why an absent field must not read as a confirmed zero; the two
 *  present-and-nonzero counts are mutually exclusive per id per
 *  `planBookRepairs`'s own doc comment, but a book can have both nonzero
 *  across different ids), the label text is built correctly (naming which
 *  reason(s) applied), and the threshold crossing is driven through the
 *  same function `main()` calls, not a hand-reimplemented copy in the test.
 *
 *  What this does NOT close, named explicitly rather than overclaimed (the
 *  #2102 pre-merge review caught exactly this shape once already — an
 *  extraction that moves the untested boundary down a level and then reads
 *  as "wiring covered" when it isn't):
 *    1. That `main()`'s per-book loop actually pushes the REAL
 *       `plan.withheldForMissingCache`/`plan.withheldForMissingBak` it
 *       computed into `bookWithholds` — a two-line push, visible by
 *       inspection, not exercised by any automated test in this file.
 *    2. That `main()` actually acts on the returned `.refuse` by setting
 *       `process.exitCode = 1` and returning before the write phase.
 *       Unreachable from `test:hooks`: exercising it needs `apply === true`,
 *       which `main()` gates behind a live TCP port-probe
 *       (`probePortRangeRefused`) and a `server/dist` import, neither of
 *       which exist in this harness — the same wall `shouldRefuseApplyFor
 *       EmptyScan`'s own "Ie" test-file comment already documents for the
 *       sibling `--apply`-gated refusal.
 *  Both remain verified only by the on-box acceptance run (register row
 *  A33, `docs/testing/onbox-acceptance-register.md`), never by an automated
 *  test in this file. */
export function planApplyRefusal(apply, bookWithholds) {
  let booksWithheldForMissingCache = 0;
  let booksWithheldForMissingBak = 0;
  let booksWithheldTotal = 0;
  const withheldBookLabels = [];
  for (const b of bookWithholds) {
    // Round 2 review, defect 7: `?? 0` made a GENUINELY ABSENT field (the
    // key missing entirely) indistinguishable from a confirmed zero — the
    // same "an omitted signal reads as unknown, refuse" shape this file
    // already applies to `cacheAvailable`/`bakAvailable` (default `false`)
    // and `historyResolver` (defaults to building a real one, not `{
    // resolve: () => undefined }`), reintroduced here two functions over
    // from where a prior review round spent a whole pass eliminating it.
    // Latent today — `main()`'s one production caller always pushes both
    // fields as real numbers — this is a safety net for any future caller
    // that forgets to, exactly like the other two defaults it mirrors.
    const cacheProvided = typeof b.withheldForMissingCache === 'number';
    const bakProvided = typeof b.withheldForMissingBak === 'number';
    const cacheCount = cacheProvided ? b.withheldForMissingCache : 0;
    const bakCount = bakProvided ? b.withheldForMissingBak : 0;
    if (cacheCount > 0) booksWithheldForMissingCache += 1;
    if (bakCount > 0) booksWithheldForMissingBak += 1;
    if (cacheCount > 0 || bakCount > 0 || !cacheProvided || !bakProvided) {
      booksWithheldTotal += 1;
      const reasons = [];
      if (!bakProvided) reasons.push('bak-withheld count missing from caller (treated as unknown, refuses)');
      else if (bakCount > 0) reasons.push(`${bakCount} id(s) missing bak evidence`);
      if (!cacheProvided) reasons.push('cache-withheld count missing from caller (treated as unknown, refuses)');
      else if (cacheCount > 0) reasons.push(`${cacheCount} id(s) missing cache evidence`);
      withheldBookLabels.push(`${b.label} (${reasons.join('; ')})`);
    }
  }
  return {
    booksWithheldForMissingCache,
    booksWithheldForMissingBak,
    booksWithheldTotal,
    withheldBookLabels,
    refuse: shouldRefuseApplyForWithheldAutoRecord(apply, booksWithheldTotal),
  };
}

/** Formats one `reportOnly` row for the console listing (main()). Extracted
 *  as a pure function so its "(N segment(s) across M chapter(s))" suffix is
 *  directly testable — #2093 residual 5 (cosmetic): a matched id with zero
 *  rendered segments (`planBookRepairs`'s "never rendered, no damage to
 *  repair" branch) reports `chapters: []` by construction — no chapter can
 *  carry a segment that was never rendered. The chapter-count clause is
 *  omitted entirely when `chapters` is empty, rather than printing the
 *  vacuous "across 0 chapter(s))" every such row would otherwise get. */
export function formatReportRowSummary(r) {
  return r.chapters.length > 0
    ? `${r.id} (${r.segments} segment(s) across ${r.chapters.length} chapter(s))`
    : `${r.id} (${r.segments} segment(s))`;
}

/** #2108: `--apply` must refuse outright when nothing was scanned. A wrong
 *  `WORKSPACE_DIR` (this script does not read `server/.env`, so a bare
 *  invocation defaults to `<home>/AudiobookWorkspace`, not necessarily
 *  where the real books live) scans ZERO books — and absent this check,
 *  that reads as "clean" rather than "unknown": `booksMissingCache` stays
 *  `0` (nothing to be missing evidence when nothing was scanned), so the
 *  round-2 fail-closed guard can never fire, and `--apply` would exit `0`
 *  having written nothing, reporting an empty tree as a healthy workspace
 *  on the exact summary line A33's precondition tells an operator to
 *  trust. There is no legitimate `--apply` against an empty workspace.
 *  Extracted as a pure decision, matching
 *  `shouldRefuseApplyForWithheldAutoRecord`'s own shape — same caveat: this
 *  covers the DECISION only, not `main()`'s wiring of it (untestable
 *  without `server/dist`; verified only by the live dry run). */
export function shouldRefuseApplyForEmptyScan(apply, booksScanned) {
  return apply === true && booksScanned === 0;
}

/** #2108: formats the `--- Summary ---` block's "books scanned" line,
 *  calling out a zero-book scan explicitly instead of letting it render as
 *  a plain "books scanned: 0" indistinguishable from any other count in the
 *  summary — every OTHER line in that block would also read `0`, which
 *  looks exactly like "a fully-scanned, perfectly clean workspace" unless
 *  something says otherwise. Dry-run only in practice: `--apply` refuses
 *  before ever reaching the summary when `booksScanned === 0` (see
 *  `shouldRefuseApplyForEmptyScan`), so an operator only ever sees this
 *  callout in dry-run output — exactly where they need to see it, before
 *  trusting any other zero in the same block. */
export function formatBooksScannedLine(booksScanned) {
  return (
    `books scanned: ${booksScanned}` +
    (booksScanned === 0
      ? ' — WARNING: nothing was examined; every count below is a row of clean zeros because NOTHING WAS ' +
        'SCANNED, not because the workspace is healthy. Check WORKSPACE_DIR before trusting anything else here.'
      : '')
  );
}

/** finding 1 follow-up (round 4 review, 2026-08-05): formats the
 *  `'not-yet-analysed'` summary line. Extracted and pinned because the fix
 *  in `collectBooks` (see its own doc comment) changed what lands in this
 *  bucket without this label being updated to match — the label used to
 *  read "no cast.json or state.json at all", describing the OLD
 *  both-files-missing discriminator, and stayed wrong once the fix widened
 *  the bucket to include a book with a perfectly good `state.json` (the
 *  bucket's primary member post-fix) or a perfectly good `cast.json` (the
 *  symmetry case). An operator reading the old text, checking disk, and
 *  finding the file right there is exactly the kind of on-screen line
 *  A33's own precondition tells them to trust — so this is pinned directly,
 *  not left to eyeball review. */
export function formatNotYetAnalysedLine(count) {
  return (
    `books not yet analysed (cast.json and/or state.json genuinely missing, judged independently per ` +
    `file — the normal shape for a book before its first analysis or just after a reparse, not evidence ` +
    `loss; a file that's PRESENT but unreadable is counted separately below, not here): ${count}`
  );
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

/** #2097 defect 10 (round 2 review, suspected — not reproducible on this
 *  box, fixed defensively regardless): reads and parses a JSON file,
 *  distinguishing "genuinely does not exist" (`ENOENT`) from "exists but
 *  could not be read" (permission denied, a directory where a file was
 *  expected, any other `readFileSync` error) or "exists, read, but failed
 *  to parse" — collapsing the first case to `'missing'` and the other two
 *  to `'unreadable'`. `collectBooks` used to derive "does this file exist"
 *  from `fs.existsSync`, which swallows EVERY error (including `EACCES`)
 *  to a bare `false` — indistinguishable from a genuinely absent file, so a
 *  permission-denied `cast.json`/`state.json` would have misclassified as
 *  the legitimate `'not-yet-analysed'` case instead of `'unreadable'`, with
 *  no `--apply` refusal for evidence that was actually lost, not absent.
 *  Reading the file directly and inspecting the thrown error's `code`
 *  removes that blind spot: the attempted read itself is the source of
 *  truth, not a separate existence probe that can lie about why it
 *  failed. */
function readJsonTriState(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { status: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch {
    return { status: 'unreadable' };
  }
}

/** #2097: was a silent `continue` with no counter, no log line — a book
 *  whose `cast.json`/`state.json` was missing, corrupt, or wrong-shaped
 *  vanished from `books` entirely, indistinguishable from a book that was
 *  never there. Now returns `{ books, droppedBooks }`, where every dropped
 *  book is counted and named — "a dropped book must be counted and named,
 *  not vanish" (same under-report class #2107 was about; note
 *  `shouldRefuseApplyForEmptyScan` only fires at exactly 0 total books, so a
 *  partial silent drop was invisible to it).
 *
 *  Distinguishes two reasons, per the design question the filed issue
 *  raised (option 3, "probably right"):
 *
 *    - **`'not-yet-analysed'`** — every file that failed the shape check did
 *      so because it is genuinely MISSING (ENOENT), not because it exists
 *      and could not be read. Judged per file, not "neither file exists at
 *      all": `state.json` is written at import time, before any analysis
 *      (`server/src/routes/import.ts`), and `cast.json` is created only
 *      later, during analysis stage 1 (`server/src/routes/analysis.ts`) —
 *      so "`state.json` present, `cast.json` absent" is the ORDINARY shape
 *      of every book between import and first analysis (and again after a
 *      reparse, which `rm`s `cast.json` and keeps `state.json` —
 *      `server/src/routes/book-state.ts`; the server's own workspace
 *      scanner already treats that shape as a normal, scannable book —
 *      `server/src/workspace/scan.ts`), not evidence loss. Counted and
 *      logged (never vanishes), but does NOT contribute to any `--apply`
 *      refusal — the same "absence is normal" posture
 *      `collectBakNameEntries`'s `bakAvailable` takes for zero bak files
 *      (#2135's own policy, applied here to a sibling case). An EARLIER
 *      version of this discriminator (`castExists || stateExists`, cleared
 *      by round 1's own review as "sound") required BOTH files to be
 *      missing before granting this reason — which classified the ordinary
 *      mid-import/post-reparse shape above as `'unreadable'` and refused
 *      `--apply` for the entire workspace over one freshly-imported book.
 *      Caught and fixed before ever reaching `main` (round 3 review). The
 *      classification is deliberately PER FILE, not special-cased to
 *      `cast.json` alone: "`cast.json` present, `state.json` missing" also
 *      grants `'not-yet-analysed'`, even though no server route deletes
 *      `state.json` on its own — grep of `server/src` confirms it — so that
 *      direction is unreached in production today. Symmetry is the point,
 *      not an accident: a future code path that DOES drop a lone
 *      `state.json` inherits the same "genuinely missing is never lost
 *      evidence" rule for free, rather than needing its own carve-out here.
 *    - **`'unreadable'`** — at least one file is PRESENT but could not be
 *      read/parsed (`readJsonTriState`'s `'unreadable'` status), or parsed
 *      fine but failed the shape check anyway (missing/wrong-shaped
 *      `characters`/`chapters`). This is evidence LOSS, not absence:
 *      something was written for this book and this pass could not read
 *      it. Counted, logged, AND refuses `--apply` for the whole run
 *      (`shouldRefuseApplyForUnreadableBooks`) — this pass cannot scan the
 *      book at all (no cast, no chapter list), so it categorically cannot
 *      rule out orphaned segments sitting unprotected in it; unlike the
 *      missing-cache/missing-bak gates, there is no `CACHE_DIR`-style knob
 *      that fixes this by pointing somewhere else, so the refusal is
 *      unconditional rather than gated on "did this book have anything at
 *      stake" the way `booksWithheldForMissingCache` is.
 *
 *  3-level author/series/title walk — the same convention
 *  `repair-linked-character-attributes.mjs` and every other workspace-wide
 *  fs-direct repair script already use for `WORKSPACE_DIR/books`. Each
 *  level's own `readdirSync` is guarded (round 2 review, defect 5) — the
 *  original only checked `fs.existsSync(booksRoot)` once, so an unreadable
 *  author or series directory (permission denied, mid-write, whatever)
 *  threw straight out of `main()` uncaught, rather than being counted and
 *  named the same way an unreadable BOOK is. An unreadable directory is
 *  pushed to `droppedBooks` as `'unreadable'` (evidence loss — we don't
 *  know what books, if any, are inside) and the walk moves on to its
 *  siblings instead of aborting the whole 20-book run.
 *
 *  The per-book shape check (round 2 review, defect 4) uses `Array.isArray`,
 *  not truthiness — `!cast?.characters` accepted ANY truthy value
 *  (`{"characters": "notanarray"}` used to be KEPT as a valid book, and
 *  `planBookRepairs` then crashed on `liveCast.map(...)` over a string,
 *  aborting the whole run with an unclassified stack trace instead of this
 *  one corrupt file being counted and named — precisely the contract
 *  `'unreadable'` exists for).
 *
 *  Exported so this is directly unit testable against real, deliberately
 *  broken fs fixtures, with no `server/dist` build needed — the same
 *  precedent `readAnalysisCache`/`isCacheAvailable` set (#2093 residual 1):
 *  this function touches only `fs`, never a compiled server module. */
export function collectBooks(workspaceDir) {
  const booksRoot = path.join(workspaceDir, 'books');
  const books = [];
  const droppedBooks = []; // { label, reason: 'not-yet-analysed' | 'unreadable' }
  if (!fs.existsSync(booksRoot)) return { books, droppedBooks };
  // Returns `null` (not a throw) on a readdir failure — every call site
  // below must check for that and record a dropped entry instead of
  // indexing into it.
  const dirs = (p) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return null;
    }
  };
  const authorDirs = dirs(booksRoot);
  if (authorDirs === null) {
    droppedBooks.push({ label: 'books/ (unreadable directory)', reason: 'unreadable' });
    return { books, droppedBooks };
  }
  for (const author of authorDirs) {
    const seriesDirs = dirs(path.join(booksRoot, author));
    if (seriesDirs === null) {
      droppedBooks.push({ label: `${author} (unreadable directory)`, reason: 'unreadable' });
      continue;
    }
    for (const series of seriesDirs) {
      const titleDirs = dirs(path.join(booksRoot, author, series));
      if (titleDirs === null) {
        droppedBooks.push({ label: `${author} / ${series} (unreadable directory)`, reason: 'unreadable' });
        continue;
      }
      for (const title of titleDirs) {
        const bookDir = path.join(booksRoot, author, series, title);
        const audiobookDir = path.join(bookDir, '.audiobook');
        const label = `${author} / ${series} / ${title}`;
        const castResult = readJsonTriState(path.join(audiobookDir, 'cast.json'));
        const stateResult = readJsonTriState(path.join(audiobookDir, 'state.json'));
        const cast = castResult.status === 'ok' ? castResult.value : null;
        const state = stateResult.status === 'ok' ? stateResult.value : null;
        const castShapeOk = Array.isArray(cast?.characters);
        const stateShapeOk = Array.isArray(state?.chapters);
        if (!castShapeOk || !stateShapeOk) {
          // Judged PER FILE, not "either file present": a genuinely missing
          // file (`'missing'`, ENOENT) is never evidence loss on its own —
          // `state.json` is written at import time, before any analysis
          // (`server/src/routes/import.ts`), and `cast.json` is created only
          // later, during analysis stage 1 (`server/src/routes/analysis.ts`)
          // — so "state.json present, cast.json absent" is the ORDINARY
          // shape of every book between import and first analysis, not
          // damage. Reparse deliberately re-creates that same shape (it
          // `rm`s `cast.json` and keeps `state.json` —
          // `server/src/routes/book-state.ts`), and the server's own
          // workspace scanner already treats it as a normal, scannable book
          // (`server/src/workspace/scan.ts`). Evidence is LOST only when a
          // file is PRESENT but could not be read/parsed (`'unreadable'`)
          // or parsed to the wrong shape (`'ok'` status, shape check
          // failed) — either of those, for either file, makes the whole
          // book `'unreadable'`.
          const castLost = castResult.status === 'unreadable' || (castResult.status === 'ok' && !castShapeOk);
          const stateLost = stateResult.status === 'unreadable' || (stateResult.status === 'ok' && !stateShapeOk);
          droppedBooks.push({ label, reason: castLost || stateLost ? 'unreadable' : 'not-yet-analysed' });
          continue;
        }
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
  return { books, droppedBooks };
}

/** #2097: pure decision for the new `--apply` refusal an `'unreadable'`
 *  dropped book (see `collectBooks`'s doc comment) triggers — same shape as
 *  `shouldRefuseApplyForEmptyScan`/`shouldRefuseApplyForWithheldAutoRecord`.
 *  Unconditional on count (unlike the withheld-evidence refusals): this
 *  pass cannot scan an unreadable book at all, so there is no "did it have
 *  anything at stake" question to ask first. A `'not-yet-analysed'` drop
 *  never reaches this — only `droppedBooks` entries reasoned `'unreadable'`
 *  count. */
export function shouldRefuseApplyForUnreadableBooks(apply, unreadableBookCount) {
  return apply === true && unreadableBookCount > 0;
}

/** #2135: enumerates `cast.json.bak.*` name entries for one book AND
 *  whether that evidence is FULLY available — mirroring `isCacheAvailable`'s
 *  fail-closed reasoning (see its own doc comment) with a deliberately
 *  DIFFERENT "no evidence" baseline. Cache evidence missing is always
 *  suspicious (every book gets analysed); bak evidence missing is the
 *  NORMAL case — most books never accumulate a `cast.json.bak.*` at all — so
 *  a naive `bakAvailable` mirroring `cacheAvailable`'s "must supply >=1
 *  usable entry" bar would fire constantly and block legitimate repairs for
 *  no reason. The distinction this function actually makes:
 *
 *    - **zero bak files at all** (readdir succeeds, filter finds nothing) —
 *      legitimate absence of evidence, `bakAvailable` stays `true`.
 *    - **bak files exist, all parse and shape-check** — `bakAvailable`
 *      stays `true` regardless of whether any of them happen to name THIS
 *      id (guard 2 in `planBookRepairs` already reads "no bak entry for
 *      this id" correctly as "bak doesn't say anything about it" when the
 *      book's bak evidence as a whole is trustworthy).
 *    - **the directory itself can't be enumerated, OR at least one bak file
 *      that exists fails to parse** (`readJsonSync` swallowing a parse
 *      failure to `null` — #2135's own repro) — `bakAvailable` is `false`:
 *      lost evidence, not clean evidence. A book's bak evidence is judged
 *      as a WHOLE, not per-id: an unread file could have named ANY id
 *      ambiguous, so this function can't tell guard 2 which ids are safe —
 *      `planBookRepairs`'s own `bakAvailable` gate withholds every matched
 *      id for the book, the same over-cautious-but-safe shape
 *      `cacheAvailable` already takes.
 *
 *  Deliberately does NOT flag a bak file that parses fine but has no
 *  `characters` array (field absent, or present and already `[]`) as
 *  unavailable — a missing/empty `characters` field is a legitimate SHAPE
 *  for an early backup to have, not evidence loss (the same way
 *  `cacheEntriesOf`'s `??[]` fallbacks aren't treated as corruption);
 *  #2135's own scan of the real workspace found 41 bak files, 0
 *  unparseable, 0 missing a `characters` array — the case this function
 *  refuses on is not live today, only reachable on a corrupted file.
 *
 *  Round 2 review, defect 6: a `characters` field that is PRESENT but not
 *  an array (`{"characters": "oops"}`, `{"characters": {...}}`) is a
 *  DIFFERENT shape from "absent/empty" — `bak?.characters ?? []` let both
 *  slip through uncaught: a string silently iterates its own characters
 *  (yielding zero usable `{id,name}` entries, same fail-open shape #2135
 *  exists to close, one level deeper) and a plain object throws an
 *  uncaught `TypeError: object is not iterable`, aborting the whole run.
 *  `Array.isArray` now distinguishes "present but wrong type" (treated as
 *  lost evidence — `bakAvailable: false`, matching a parse failure, since a
 *  file whose own declared field can't be trusted is no different from one
 *  that failed to parse) from "absent or a genuine (possibly empty) array"
 *  (tolerated, per the paragraph above).
 *
 *  Exported for the same reason `collectBooks` now is — a direct fs-fixture
 *  unit test, no `server/dist` build needed (#2093 residual 1's precedent). */
export function collectBakNameEntries(audiobookDir) {
  const entries = [];
  let files;
  try {
    files = fs.readdirSync(audiobookDir).filter((f) => f.startsWith('cast.json.bak'));
  } catch {
    // Can't even enumerate this book's bak files — unknown, not "zero
    // files"; fail closed rather than reading this the same as the (much
    // more common, entirely legitimate) zero-bak-files case.
    return { entries, bakAvailable: false };
  }
  let bakAvailable = true;
  for (const f of files) {
    const bak = readJsonSync(path.join(audiobookDir, f));
    if (bak === null) {
      // The file exists but failed to parse — lost evidence, not "this
      // file says nothing" (#2135's exact repro: a corrupt bak swallowed to
      // `null` used to contribute zero entries, which guard 2 then read as
      // "bak is unambiguous" instead of "bak is unknown").
      bakAvailable = false;
      continue;
    }
    const chars = bak?.characters;
    if (chars !== undefined && !Array.isArray(chars)) {
      // Present but the wrong shape — not the tolerated "absent/empty"
      // case (round 2 review, defect 6): a string would otherwise iterate
      // silently to zero entries, and a plain object would throw. Treated
      // the same as a parse failure: lost evidence, not clean.
      bakAvailable = false;
      continue;
    }
    for (const c of chars ?? []) {
      if (typeof c?.id === 'string' && typeof c?.name === 'string') entries.push({ id: c.id, name: c.name });
    }
  }
  return { entries, bakAvailable };
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
 *  2026-08-05, and again by pre-merge review I1, 2026-08-05): the actual
 *  `cacheAvailable` gate. A book's analysis-cache evidence counts as
 *  available only when the file EXISTS, PARSES, **and produces at least
 *  one USABLE name/id entry in the same index guard 2 actually consumes**
 *  — not merely "exists, parses, and `cacheEntriesOf` returns something
 *  non-empty" (that narrower check was I1's own finding: `cacheEntriesOf`
 *  only checks `typeof === 'string'`, so an entry like `{id:"sandor",
 *  name:""}` — one truncated analyzer write — passes it and made
 *  `isCacheAvailable` return `true`, while `buildNameIndex` (what guard 2,
 *  the cross-source ambiguity veto, actually reads as `cacheNameIndex`)
 *  drops that SAME entry for its falsy name — round 1's Critical reopened
 *  one field deeper). This now calls `buildNameIndex` with the SAME
 *  `normaliseFn` production wires in (`main()` passes
 *  `mods.normaliseForMatch`, the real server function) rather than
 *  re-deriving a parallel "is this entry usable" check — the exact
 *  "don't duplicate the resolver" principle this whole script already
 *  follows for id resolution, applied here to name-index construction too.
 *  Measured against the real workspace's cache dir: 76 files parse, 0 are
 *  unparseable, 10 parse with zero character entries, and 0 exhibit the
 *  empty-string-field shape this residual fixes — one of the 10 zero-entry
 *  books (*Unlocked*, `mns_dLurz4I544`) also carries bak-only name evidence
 *  guard 2 must not treat as uncontested without the cache's
 *  corroboration/veto. All refusal states — missing, unparseable,
 *  parses-but-produces-no-usable-entry — now read the same way here;
 *  `main()`'s diagnostic line still distinguishes the first two for the
 *  operator (see its own comment). */
export function isCacheAvailable(cacheDir, manuscriptId, normaliseFn) {
  const cache = readAnalysisCache(cacheDir, manuscriptId);
  return cacheAvailableFromParsed(cache, normaliseFn);
}

/** Pure core of `isCacheAvailable`, operating on an already-parsed `cache`
 *  value (whatever `readAnalysisCache` returns — the raw object, or `null`
 *  on missing/unparseable) rather than re-reading the file itself. Minor,
 *  pre-merge review, 2026-08-05: `main()` used to call `isCacheAvailable`
 *  (which reads the file once internally) and THEN call `readAnalysisCache`
 *  again itself for `cacheNameIndex` — two reads of the same path per book,
 *  and a theoretical window where the two reads could observe different
 *  filesystem states (a concurrent write between them). `main()` now reads
 *  once via `readAnalysisCache` and passes that same parsed value to both
 *  this function and `cacheEntriesOf`, so the gate and the guard it
 *  protects are guaranteed to measure the identical parse, not merely the
 *  identical NORMALISER (which `isCacheAvailable`'s own doc comment above
 *  already required). `isCacheAvailable` itself keeps its original
 *  `(cacheDir, manuscriptId, normaliseFn)` signature — real fs fixtures
 *  test the read-through path (missing file, corrupt JSON, empty
 *  characters) via that signature, and changing it would lose that
 *  coverage for no benefit `main()` doesn't already get from this split. */
export function cacheAvailableFromParsed(cache, normaliseFn) {
  if (cache === null) return false;
  return buildNameIndex(cacheEntriesOf(cache), normaliseFn).size > 0;
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
 *  candidate gave a definitive "nothing is listening".
 *
 *  Clamps to the valid TCP port range (minor, pre-merge review, 2026-08-05):
 *  without this, `PORT`/`LAN_HTTPS_PORT` set near the top of the 16-bit
 *  range (e.g. `PORT=65530`) makes `startPort + i` overflow past `65535`
 *  for the last few candidates, and `net.connect` throws SYNCHRONOUSLY on
 *  an out-of-range port number — the operator would see a raw stack trace
 *  instead of this script's own refusal message. A port number above
 *  `65535` cannot exist, so it cannot have a listener; excluding it from
 *  the probed set loses no real safety coverage — every port that COULD
 *  exist in the rebind range is still fully probed, and the fail-closed
 *  property is unaffected either way. */
export async function probePortRangeRefused(startPort, host = '127.0.0.1') {
  // C1 (pre-merge review, 2026-08-05): validate startPort itself BEFORE
  // building the candidate list, not merely clamp the list. main() derives
  // startPort from `Number(process.env.PORT ?? 8080)` with no validation —
  // `Number('abc')` is NaN, and `NaN <= 65535` is false for every
  // candidate, so the old `.filter()` alone silently emptied `ports` to
  // `[]` for a malformed PORT. `Promise.all([])` resolves `[]`, and
  // main() reads an empty `notRefused` as "every candidate definitively
  // refused" — indistinguishable from a genuinely clean 20-port scan, so
  // main() proceeded to WRITE. On main (pre this branch) the same input
  // reached `net.connect({ port: NaN })`, which throws synchronously and
  // crashes the run closed; the earlier clamp here turned that crash into
  // a silent pass-through. A bad startPort is returned as its own
  // one-element "not refused" result instead, so main() refuses and NAMES
  // the bad value rather than reading "nothing to probe" as "all clear".
  // Two-sided on purpose — the old one-sided `<= 65535` clamp let a
  // negative startPort (e.g. PORT=-1) through to net.connect uncaught.
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) return [startPort];
  const ports = Array.from({ length: AUTO_REBIND_RANGE }, (_, i) => startPort + i).filter((p) => p <= 65535);
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
    'server/dist/store/cast-audio-currency.js',
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
  const [castResolve, castIdHistory, textMatch, characterId, segmentsIo, narratorIdentity, foldMinorCast, castAudioCurrency] = await Promise.all([
    import('../server/dist/store/cast-resolve.js'),
    import('../server/dist/store/cast-id-history.js'),
    import('../server/dist/util/text-match.js'),
    import('../server/dist/util/character-id.js'),
    import('../server/dist/audio/segments-io.js'),
    import('../server/dist/analyzer/narrator-identity.js'),
    import('../server/dist/analyzer/fold-minor-cast.js'),
    import('../server/dist/store/cast-audio-currency.js'),
  ]);
  return {
    buildCastResolver: castResolve.buildCastResolver,
    loadCastIdHistory: castIdHistory.loadCastIdHistory,
    retireCharacterId: castIdHistory.retireCharacterId,
    castIdHistoryPath: castIdHistory.castIdHistoryPath,
    CastIdHistoryUnreadableError: castIdHistory.CastIdHistoryUnreadableError,
    // #2128 — the one-shot back-fill (Task 2) main()'s --apply tail calls
    // for EVERY scanned book, and the shared currency comparator (Task 4)
    // buildOrphansFromSegments/collectSegmentOrphans now call instead of
    // re-deriving their own seq/stamp comparison (Global Constraint 3).
    stampRecordedAtSeqIfAbsent: castIdHistory.stampRecordedAtSeqIfAbsent,
    isAudioCurrent: castAudioCurrency.isAudioCurrent,
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
 *  every rendered segment and buckets it into `orphans` — the rendered
 *  bytes on disk may be stale — per-chapter breakdown, approximate affected
 *  duration from each segment's own startSec/endSec, every non-empty
 *  characterSnapshot.
 *
 *  Exported so the collector's pure core — previously proven only by a live
 *  dry run against the real workspace, since `planBookRepairs`'s own tests
 *  only ever injected a fake `orphans` map — has a direct unit test with no
 *  fs/`server/dist` dependency (see the module doc comment's Tests
 *  section). `collectSegmentOrphans` itself stays the thin I/O wrapper that
 *  loads `segs` and calls this.
 *
 *  #2107, widened by an explicit owner decision after independent review
 *  (2026-08-05): a frozen `characterId` that is not literally a live cast
 *  id today — via `cast-resolve.ts`'s `'exact'` tier — may have been
 *  rendered against a different resolution than the one it resolves to
 *  now, so it is listed as an orphan. That covers a genuine miss AND every
 *  one of the other three resolver tiers (`'normalised-id'`, `'history'`,
 *  `'normalised-history'`) alike — ONLY `'exact'` means the rendered bytes
 *  are fine.
 *
 *  This replaces a narrower first version of this fix that kept
 *  `'normalised-id'` out of `orphans`, reasoned as: an id that still
 *  normalised-matches a live id with no history entry for it can't depend
 *  on the mutable `history.supersededBy` table, so it can't have started
 *  resolving after the render. True as far as it goes, but a non-sequitur
 *  — it proves only that no RENAME happened, not that the bytes are
 *  correct. Register row A32 (`docs/testing/onbox-acceptance-register.md`)
 *  records the counter-example: *Playing with Fire*'s `the-torment` (67
 *  segments, cast id `the_torment`) and `lightning-dave` (1 segment, cast
 *  id `lightning_dave`) both recover under the `'normalised-id'` tier
 *  today, but their audio was rendered BEFORE Wave 1's resolver existed at
 *  all — `resolveGroup` did a bare `castById.get()` and substituted the
 *  narrator regardless of tier, so a normalised-id match today says
 *  nothing about what voice rendered the frozen bytes by itself.
 *
 *  F1 (PR #2244 review gate, fix round) — there IS per-segment evidence
 *  after all: the PER-SEGMENT field `renderedFallbackCharacterId`, stamped
 *  by #2023 exactly when the render-time resolver missed and substituted
 *  the narrator. `isAudioCurrent` (`server/src/store/cast-audio-currency.ts`)
 *  now consults it FIRST, above the entire tier dispatch including
 *  `'exact'` (originally added inside the `'normalised-id'` branch alone;
 *  round 2 hoisted it above every tier's marker comparison, round 3 hoisted
 *  it above `'exact'` too, since this function — unlike the banner's
 *  `collectOrphanedCharacterFallbacks` — resolves every string
 *  `characterId` with no exact-tier filter ahead of it) — this
 *  function threads `s.renderedFallbackCharacterId` through on every call,
 *  same as `collectOrphanedCharacterFallbacks` (`segments-io.ts`) does on
 *  the banner side. Measured absent from all 84,642 real segments as of the
 *  ORIGINAL writing of this comment (only `renderedFallbackEngine`, 77
 *  segments, existed then) — that measurement predates most real renders
 *  ever having a reason to carry it, not evidence the field can't fire: a
 *  render that post-dates #2023 and DID substitute the narrator stamps it
 *  every time. `characterSnapshots` is a FILE-level map, not a per-segment
 *  field — this function reads it below, once per file, and it IS present
 *  (497 files, 2,625 keys) — but it doesn't say which tier resolved any ONE
 *  segment either, so it remains unusable as a `'normalised-id'`
 *  discriminator. Where `renderedFallbackCharacterId` is itself absent (a
 *  pre-#2023 render, or one that never substituted), the tier still falls
 *  back to `true` — over-reporting every legacy normalised-id match forever
 *  was tried and rejected: it would re-list every already-verified row on
 *  every run with no way to ever clear it. A stamped, non-null substitution
 *  is treated as damage on sight; its absence is not treated as proof of the
 *  opposite, only as "no evidence found," which for THIS tier the owner
 *  ruled reads `true`, not `'unknown'` (unlike the seven other guards in
 *  `isAudioCurrent`'s own header, where absent evidence reads `'unknown'`).
 *
 *  Empty-result note (the defect shape this wave keeps hitting): `orphans`
 *  being empty for an id must mean "resolves via `'exact'`, OR its rendered
 *  audio is affirmatively CURRENT (`isAudioCurrent === true`)" — never
 *  merely "resolver.resolve() returned something". That laxer reading is
 *  the bug this comment exists to prevent from coming back.
 *
 *  #2128 — `isAudioCurrent` (Task 4, `server/src/store/cast-audio-currency.ts`)
 *  is now the skip test, not `resolution.via === 'exact'` alone. It is the
 *  SAME comparator the Cast banner calls (plan 278's invariant 7, extended
 *  from candidate ranking to currency) — this function must call it, never
 *  re-derive "is this id fine?" with its own `castHistorySeq`/`recordedAtSeq`
 *  comparison (Global Constraint 3, one comparator two callers). `'exact'`
 *  is fine with no stamp needed UNLESS the segment itself recorded
 *  `renderedFallbackCharacterId` — round 3 found this function (unlike the
 *  banner) reaches `'exact'` routinely, with no filter ahead of the call, so
 *  a stale claim that `'exact'` is "unconditionally fine" here would have
 *  silently cleared every re-minted-id substitution case; see the doc
 *  comment on the `renderedFallbackCharacterId` parameter below for the full
 *  reasoning. This is a strict widening of the old skip, not a replacement
 *  of it. */
export function buildOrphansFromSegments(segs, resolver, history, isAudioCurrent) {
  const orphans = new Map(); // id -> { segments, chapters: [{chapterId,chapterTitle,segments,durationSec}], snapshots: [] }
  /* #2128 — ids that skipped `orphans` because their audio is affirmatively
     CURRENT, though they do not resolve via `'exact'`. `planBookRepairs`'s
     zero-segment branch needs to tell these apart from an id that genuinely
     never rendered a line: both now arrive with `segments === 0`, and giving
     them the same reason string would state a demonstrably false thing about
     a book with real rendered segments for that id — one level down from the
     `autoReconciled`-bucket defect `511c5382` fixed and `30456c71` deleted.
     Reported as fact here; the policy (what to DO about a current id) lives
     in the caller, `planBookRepairs`. */
  const currentNonExact = new Set();
  for (const seg of segs) {
    const perChapterCount = new Map(); // id -> count
    const perChapterDuration = new Map(); // id -> seconds
    for (const s of seg.segments ?? []) {
      const id = s.characterId;
      if (typeof id !== 'string') continue;
      const resolution = resolver.resolve(id);
      /* #2128 — the skip is now "affirmatively current", not "resolves via
         'exact'". Anything other than a literal `true` is listed: `false`
         is a genuine miss or a stale render, and `'unknown'` means the
         comparison could not be made at all — reading THAT as clean is
         exactly what #2107 exists to prevent (Global Constraint 4: only an
         affirmative comparison clears a row).

         F1 (PR #2244 review gate) — also passes `s.renderedFallbackCharacterId`,
         the per-segment render-time narrator-substitution stamp: `isAudioCurrent`
         consults it FIRST, above its entire tier dispatch (originally only
         inside `'normalised-id'`; round 2 hoisted it above every tier's marker
         comparison, round 3 hoisted it above `'exact'` too) — this function
         reaches `'exact'` routinely, with no filter ahead of the call, so the
         hoist above `'exact'` is load-bearing HERE specifically, not merely a
         tidy-up. */
      if (isAudioCurrent(resolution, seg, history, s.renderedFallbackCharacterId) === true) {
        if (resolution?.via !== 'exact') currentNonExact.add(id);
        continue;
      }
      // Everything else — a genuine miss, or a non-current match via
      // 'normalised-id' / 'history' / 'normalised-history' — is listed (see
      // the doc comment above for why only an affirmatively current
      // resolution is exempt).
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
  // #2128 — `orphans` membership wins: an id current in one chapter but
  // stale in another (the file-level `isAudioCurrent` call is per-segments-
  // file, and this loop is already per-file) must not read as clean. Without
  // this subtraction the id would land in BOTH sets, and planBookRepairs's
  // zero-segment branch reads `currentNonExact` only when `orphans.segments
  // === 0` — an id with real orphaned segments elsewhere never reaches that
  // branch at all, so the wrong signal would simply be dropped silently
  // there; a FUTURE caller reading `currentNonExact` on its own would not be
  // so lucky. This is the "any-current => clean" direction that re-opens
  // #2107.
  for (const id of orphans.keys()) currentNonExact.delete(id);
  return { orphans, currentNonExact };
}

// Exported (previously module-private) SOLELY so Task 9's fix — passing
// `history` through unmodified instead of a hand-built subset — has a direct
// unit test asserting what actually reaches `buildCastResolver`, rather than
// relying on the live dry run the way most of this file's I/O wrappers do.
//
// Also returns the real, history-aware `resolver` it built — Important 1
// (independent review, 2026-08-05): `planBookRepairs`'s "already recorded"
// and current-resolution-conflict guards need to ask this SAME resolver,
// not reconstruct a second instance from the same inputs (see
// `planBookRepairs`'s `historyResolver` local for the full reasoning).
// `main()` threads it straight through.
export async function collectSegmentOrphans(bookDir, chapters, cast, history, mods) {
  // #2092/#2089 Task 9 incidental fix: this used to hand-build a
  // `{ supersededBy, rejected }` subset of `history`, silently dropping
  // `rejectedPairs` — the exact "defaulted field a caller can drop" shape
  // Task 3 made unrepresentable server-side by threading the whole loaded
  // `CastIdHistory` object instead (see `synthesise-chapter.ts`'s
  // `castResolver = buildCastResolver(cast, castIdHistory)`). With the
  // subset, a segment whose id was pair-rejected against the very target it
  // would otherwise resolve onto (an alias or normalised-id/-history hit)
  // resolved anyway here — so it was counted as NOT orphaned, disagreeing
  // with the real render-time resolver (which DOES know about the pair) and
  // silently hiding the rejected pairing from this script's damage report.
  // Passing `history` itself, the same loaded object `planBookRepairs`
  // already receives unmodified, is what `buildCastResolver` actually wants
  // (`Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'>`).
  const resolver = mods.buildCastResolver(cast.characters, history);
  const segs = await mods.loadSegmentsFiles(bookDir, chapters);
  const { orphans, currentNonExact } = buildOrphansFromSegments(segs, resolver, history, mods.isAudioCurrent);
  return { orphans, currentNonExact, resolver };
}

function backupCastIdHistory(historyPath) {
  if (!fs.existsSync(historyPath)) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = `${historyPath}.bak.id-drift-${stamp}`;
  fs.copyFileSync(historyPath, backupPath);
  return backupPath;
}

/** #2128 — the one-shot `recordedAtSeq` back-fill, for EVERY book `main()`
 *  scanned this run, not only ones with an alias to record: absence of the
 *  field reads `'unknown'` and lists the whole book forever (see
 *  `isAudioCurrent`'s own doc comment, source 2), and the books carrying
 *  pre-lane aliases are exactly the ones this A33 repair workflow already
 *  visits.
 *
 *  Exported and pulled out of `main()` (mirroring `buildRerenderRows`,
 *  every `shouldRefuseApplyFor*` guard, and `planApplyRefusal` above) so
 *  this wiring has a direct unit test with a fake `stampRecordedAtSeqIfAbsent`
 *  — this file's tests never invoke `main()`/`--apply` itself (see the
 *  module doc comment's Tests section and `collectSegmentOrphans`'s own
 *  describe block for why: no server build in the `test:hooks` CI job,
 *  and this repair pass is under an explicit instruction to never invoke
 *  `--apply` from its own suite).
 *
 *  Takes `apply` as its own first argument, mirroring `shouldRefuseApplyFor*`'s
 *  own `(apply, ...)` shape, rather than leaving the dry-run/write split as
 *  an `if (apply)` wrapper at the call site (review round 1, I2): a dry run
 *  must never write, and folding the gate INTO the tested function — instead
 *  of around an untested call to it — is what lets a test assert that
 *  directly (a dry run calls `stampRecordedAtSeqIfAbsent` zero times), not
 *  merely that the counting logic is right once invoked.
 *
 *  Caller order matters: `main()` calls this AFTER the alias-writing
 *  (`pendingWrites`) loop — a book that just received an alias already has
 *  the field from `bumpSeqAndStamp`, so the stamp is a no-op there, and
 *  doing it first would be equally correct but harder to reason about. */
export async function stampScannedBooks(apply, scannedBookDirs, stampRecordedAtSeqIfAbsent) {
  if (!apply) return 0;
  let stamped = 0;
  for (const bookDir of scannedBookDirs) {
    /* F3 (PR #2244 review gate) — `stampRecordedAtSeqIfAbsent`'s own READ
       failures are already caught and warned (cast-id-history.ts's
       `stampRecordedAtSeqIfAbsent`, ~:1211-1217), but its `writeJsonAtomic`
       call is not — an EPERM from an AV scanner (or any other transient I/O
       failure) on one book must not propagate out of this loop and abort
       main()'s whole `--apply` run: every book after the failing one would
       silently never get stamped, with no "stamped ... (#2128 one-shot)"
       line and a bare stack trace instead. Matches the surrounding failure
       discipline (warn and continue), same as the read-failure branch this
       mirrors. */
    try {
      if (await stampRecordedAtSeqIfAbsent(bookDir)) stamped += 1;
    } catch (err) {
      console.warn(
        `[repair-cast-id-drift] failed to stamp recordedAtSeq for ${bookDir} ` +
          `(${err?.message ?? err}) — skipping this book's #2128 one-shot stamp, continuing with the rest.`,
      );
    }
  }
  return stamped;
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

  // Ie (pre-merge review, 2026-08-05): collectBooks + the empty-scan refusal
  // are deliberately ordered BEFORE loadServerModules() — collectBooks needs
  // no compiled server module at all, and putting the refusal ahead of the
  // one thing in this function that DOES need `server/dist` built means a
  // wrong WORKSPACE_DIR + `--apply` is caught (and named specifically)
  // before an unrelated "missing compiled server module" error would
  // otherwise mask it, AND means THAT combination's exit path needs no
  // build step. (A subprocess test of it was considered and deliberately
  // NOT added: the review that requested this reorder also forbade this
  // repair pass from ever invoking `--apply`, and a DRY run against zero
  // books does not exercise this refusal at all — `shouldRefuseApplyForEmptyScan`
  // only fires when `apply === true` — so it still falls through to
  // `loadServerModules()` below either way, which needs `server/dist`
  // built and is NOT built in the `test:hooks` CI job that runs this
  // script's test file; see that file's own note on this.) Behaviour is
  // unchanged for every case that reaches this point with books.length > 0
  // or apply === false — only the zero-book + --apply combination now
  // short-circuits earlier.
  const { books, droppedBooks } = collectBooks(workspaceDir);
  // #2108, minor (pre-merge review, 2026-08-05): this early line now goes
  // through the same formatBooksScannedLine() the summary block already
  // used — previously this printed a bare `books scanned: 0` with none of
  // the summary's explicit warning, so a zero-book dry run's FIRST visible
  // line still looked like an unremarkable count rather than the "nothing
  // was examined" callout #2108 added further down.
  console.log(`${formatBooksScannedLine(books.length)}\n`);

  // #2097: a book dropped by collectBooks is counted and named, not left to
  // vanish — see that function's own doc comment for the two reasons and
  // why only 'unreadable' (evidence LOSS, not legitimate absence) refuses
  // --apply. Logged before the refusal checks below so an operator sees
  // WHICH books were dropped and why even on a dry run.
  const unreadableBooks = droppedBooks.filter((b) => b.reason === 'unreadable');
  const notYetAnalysedBooks = droppedBooks.filter((b) => b.reason === 'not-yet-analysed');
  if (notYetAnalysedBooks.length) {
    console.log(formatNotYetAnalysedLine(notYetAnalysedBooks.length));
    for (const b of notYetAnalysedBooks) console.log(`  - ${b.label}`);
  }
  if (unreadableBooks.length) {
    console.log(
      `books DROPPED — cast.json/state.json present but unreadable or wrong-shaped (evidence LOST, not ` +
        `absent): ${unreadableBooks.length}`,
    );
    for (const b of unreadableBooks) console.log(`  - ${b.label}`);
  }
  if (notYetAnalysedBooks.length || unreadableBooks.length) console.log('');

  // #2097: an unreadable book cannot be scanned at all (no cast, no chapter
  // list) — this pass categorically cannot rule out orphaned segments
  // sitting unprotected in it, so --apply refuses unconditionally rather
  // than merely reporting the drop (see shouldRefuseApplyForUnreadableBooks's
  // own doc comment for why this is unconditional, unlike the withheld-
  // evidence refusals below).
  if (shouldRefuseApplyForUnreadableBooks(apply, unreadableBooks.length)) {
    console.error(
      `\nRefusing --apply: ${unreadableBooks.length} book(s) have a cast.json/state.json that exists but ` +
        `could not be read — this pass cannot scan them for orphaned segments at all, so it cannot rule out ` +
        `damage sitting unprotected in them: ${unreadableBooks.map((b) => b.label).join('; ')}. Fix or ` +
        `restore each book's cast.json/state.json and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  // #2108: a wrong WORKSPACE_DIR (the script does not read server/.env, so a
  // bare invocation defaults to <home>/AudiobookWorkspace, not necessarily
  // where the real books live) scans ZERO books — and without this check,
  // that reads as "clean" rather than "unknown": booksMissingCache stays 0
  // (there is nothing to be missing evidence when nothing was scanned), so
  // the round-2 fail-closed guard can never fire, and --apply would run to
  // completion, exit 0, and write nothing — reporting an empty tree as a
  // healthy workspace on the exact summary line A33's precondition tells an
  // operator to trust. There is no legitimate --apply against an empty
  // workspace, so this refuses outright; a dry run still completes (so the
  // operator can see WHERE it looked), but the summary below calls the zero
  // out explicitly instead of rendering a row of clean zeros that reads as
  // "nothing needs fixing".
  if (shouldRefuseApplyForEmptyScan(apply, books.length)) {
    console.error(
      `\nRefusing --apply: 0 books found at workspace (${workspaceDir}). This usually means ` +
        `WORKSPACE_DIR is wrong — this script does not read server/.env, so a bare invocation ` +
        `defaults to <home>/AudiobookWorkspace, which may not be where the real workspace lives. ` +
        `Point WORKSPACE_DIR (or BASE/AUDIOBOOK_WORKSPACE) at the real workspace root and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  const mods = await loadServerModules();

  let totalAuto = 0;
  let totalAutoSegments = 0;
  let totalReport = 0;
  let totalReportSegments = 0;
  let totalSkipped = 0;
  let booksMissingCache = 0;
  let booksMissingBak = 0;
  // #2111: fed to `planApplyRefusal` once, after the loop, instead of
  // hand-accumulating `booksWithheldForMissingCache`/`withheldBookLabels`
  // inline here — see that function's doc comment for what this does and
  // does not close of the wiring-untested gap. #2135 widened the per-book
  // record with a second field.
  const bookWithholds = []; // { label, withheldForMissingCache, withheldForMissingBak }
  const allRerenderRows = [];
  const pendingWrites = []; // { bookDir, historyPath, autoRecord }
  // #2128 (review round 1, I2) — every book this run actually scanned,
  // whether or not it had an alias to record; fed to the one-shot
  // recordedAtSeq back-fill below. Deliberately DERIVED from `books`
  // (already fully populated above by `collectBooks`) rather than an
  // imperative push inside the loop below: a push is a silent-degrade
  // hazard — delete the line and `scannedBookDirs` quietly stays `[]`,
  // `stampScannedBooks` reports 0 stamped, and the one-shot back-fill
  // becomes a permanent no-op with no error anywhere. A deleted `const`
  // declaration instead throws a ReferenceError the moment `main()` reaches
  // it — loud, not silent — since nothing else in this codebase can prove
  // this specific line survives a future edit (main() itself is outside
  // this file's own no-server-build test policy; see stampScannedBooks's
  // doc comment).
  const scannedBookDirs = books.map((b) => b.bookDir);

  for (const book of books) {
    const history = await mods.loadCastIdHistory(book.bookDir);
    const chapters = book.state.chapters.map((c) => ({ id: c.id, slug: c.slug, title: c.title }));

    const { orphans: segmentOrphans, currentNonExact, resolver: historyResolver } = await collectSegmentOrphans(book.bookDir, chapters, book.cast, history, mods);
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
    // independent-review Critical C1, widened again by pre-merge review I1)
    // PARSES-BUT-PRODUCES-NO-USABLE-NAME/ID-ENTRY cache file must never
    // silently read as "confirmed unambiguous". `cacheAvailable` is a
    // per-book fact — does the file exist, parse, AND supply usable
    // evidence — computed independently of whether THIS book's cache
    // happens to name any of its orphaned ids specifically. Gated on
    // `isCacheAvailable`, passed the SAME `normaliseForMatch` used to build
    // `cacheNameIndex` below so the gate and the guard it protects measure
    // the identical quantity (I1: the gate used to accept an entry with an
    // empty-string id/name that `buildNameIndex` would silently drop) —
    // never `analysisCacheFileExists` (exists only, which read a
    // present-but-corrupt OR present-but-empty file as "available" — the
    // exact fail-open shape the round-2 fix closed one level up, reopened
    // here three times now).
    // Minor (pre-merge review, 2026-08-05): read the cache file exactly
    // once per book and reuse the same parsed value for both the
    // availability gate and cacheNameIndex, rather than reading it twice
    // (see cacheAvailableFromParsed's own doc comment).
    const cache = readAnalysisCache(cacheDir, book.state.manuscriptId);
    const cacheAvailable = cacheAvailableFromParsed(cache, mods.normaliseForMatch);
    if (!cacheAvailable) booksMissingCache += 1;
    const cacheNameIndex = buildNameIndex(cacheEntriesOf(cache), mods.normaliseForMatch);
    // #2135: `collectBakNameEntries` now returns both the entries AND
    // whether this book's bak evidence is fully readable — see its own doc
    // comment for why "zero bak files" and "confirmed available" are the
    // SAME state here, unlike the cache side.
    const { entries: bakEntries, bakAvailable } = collectBakNameEntries(book.audiobookDir);
    if (!bakAvailable) booksMissingBak += 1;
    const bakNameIndex = buildNameIndex(bakEntries, mods.normaliseForMatch);

    const plan = planBookRepairs(
      {
        liveCast: book.cast.characters,
        history,
        cacheNameIndex,
        bakNameIndex,
        orphans: segmentOrphans,
        cacheAvailable,
        bakAvailable,
        historyResolver,
        currentNonExact,
      },
      {
        normaliseForMatch: mods.normaliseForMatch,
        buildCastResolver: mods.buildCastResolver,
        reservedIds: mods.reservedIds,
        normaliseIdKey: mods.normaliseIdKey,
      },
    );

    bookWithholds.push({
      label: book.label,
      withheldForMissingCache: plan.withheldForMissingCache,
      withheldForMissingBak: plan.withheldForMissingBak,
    });

    const rerenderRows = buildRerenderRows(book.label, segmentOrphans);
    allRerenderRows.push(...rerenderRows);

    if (plan.autoRecord.length === 0 && plan.reportOnly.length === 0 && plan.skipped.length === 0) continue;

    console.log(`--- ${book.label} ---`);
    if (!bakAvailable) {
      // #2135: a corrupt/unreadable cast.json.bak.* — NOT merely "zero bak
      // files", which is the normal case and leaves bakAvailable true (see
      // collectBakNameEntries's own doc comment).
      console.log(
        `  (! at least one cast.json.bak.* for this book (${book.audiobookDir}) could not be read or parsed. ` +
          `The cross-source ambiguity veto cannot see this book's full bak evidence, so auto-record is withheld ` +
          `for every matched id below until every cast.json.bak.* for this book is readable.)`,
      );
    }
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
        // #2134 round 2: an honest annotation, not a claim guard 4 verified
        // something it couldn't — see planBookRepairs' guard-4 doc comment
        // for why 'no-evidence' is expected, not suspicious, for this
        // population (characterSnapshots is written only for a LIVE id at
        // render time, and every id here is by definition not live today).
        if (a.snapshotEvidence === 'no-evidence') {
          console.log(
            `      (guard 4 not evaluable — no rendered characterSnapshots evidence exists under "${a.id}"'s own key; ` +
              `this alias relies on guards 1/2/3/5 and cache/bak availability alone)`,
          );
        }
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

  // #2111: single call, right after the loop — see `planApplyRefusal`'s
  // own doc comment for exactly what this does and does not prove tested.
  // #2135 widened the returned shape with a bak-side count alongside cache.
  const {
    booksWithheldForMissingCache,
    booksWithheldForMissingBak,
    booksWithheldTotal,
    withheldBookLabels,
    refuse: refuseApply,
  } = planApplyRefusal(apply, bookWithholds);

  if (allRerenderRows.length) {
    // #2244 review gate N4: this list is no longer only orphaned ids — an
    // `'exact'`-tier id with a recorded `renderedFallbackCharacterId` now
    // enters `orphans` too (it genuinely needs a re-render, with no alias to
    // record), and that id IS live in `liveIds`. "character id" stays
    // accurate for both cases; "orphaned id" no longer does.
    console.log('--- Re-render list (book / chapter / character id / segments / ~duration) ---');
    for (const row of allRerenderRows) {
      console.log(
        `  ${row.book} | ch${row.chapterId} "${row.chapterTitle}" | ${row.id} | ${row.segments} seg | ~${formatDuration(row.durationSec)}`,
      );
    }
    console.log('');
  }

  console.log('--- Summary ---');
  console.log(formatBooksScannedLine(books.length));
  console.log(`auto-recordable aliases: ${totalAuto} (${totalAutoSegments} segment(s))${apply ? '' : ' — dry run, nothing written'}`);
  console.log(`reported for human decision: ${totalReport} id(s) / ${totalReportSegments} segment(s)`);
  console.log(`skipped (already recorded / rejected): ${totalSkipped}`);
  // M-3 (independent review, 2026-08-05): the row count alone forces an
  // operator to sum every row's `segments` by hand to get the figure the
  // register/run-sheet/live-view all quote as "the arithmetic check that
  // the set is complete" (e.g. 188) — print it here instead.
  const totalRerenderSegments = allRerenderRows.reduce((sum, row) => sum + row.segments, 0);
  console.log(`re-render candidates: ${allRerenderRows.length} chapter row(s) / ${totalRerenderSegments} segment(s)`);
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
  // #2135: bak's informational line, mirroring cache's — but a nonzero
  // count here is RARE and worth flagging harder in the reason text, since
  // (unlike cache) most books legitimately carry zero bak files at all;
  // this count only rises when at least one that DOES exist is unreadable.
  console.log(
    `books with unreadable cast.json.bak.* evidence: ${booksMissingBak}` +
      (booksMissingBak
        ? ' — the cross-source ambiguity veto cannot see this book\'s full bak evidence, so no auto-record can ' +
          'be recorded for a matched id in them; informational only, does NOT by itself block --apply (see below)'
        : ''),
  );
  // finding 4 (round 3 review, 2026-08-05): the "not blocked by X evidence"
  // half of each line used to print unconditionally whenever ITS OWN count
  // was 0 — but `refuseApply` can still be true from the OTHER field, or
  // from a book whose withheld count was never provided at all (defect 7's
  // absent-field case, above; latent today — main()'s one caller always
  // supplies both fields as real numbers). That produced two summary lines
  // both claiming "not blocked", immediately followed by a refusal message
  // saying a book WAS withheld — the exact line A33's own precondition
  // tells the operator to trust, printing false. The reassuring claim is
  // now gated on the actual outcome (`refuseApply`), not on this field's
  // own count in isolation — the counts themselves are unchanged.
  console.log(
    `books with an auto-record withheld for missing cache evidence: ${booksWithheldForMissingCache}` +
      (booksWithheldForMissingCache
        ? ` — contributes to the --apply block below`
        : refuseApply
          ? ''
          : ' — --apply is not blocked by cache evidence'),
  );
  console.log(
    `books with an auto-record withheld for missing bak evidence: ${booksWithheldForMissingBak}` +
      (booksWithheldForMissingBak
        ? ` — contributes to the --apply block below`
        : refuseApply
          ? ''
          : ' — --apply is not blocked by bak evidence'),
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
  // (booksWithheldTotal > 0), so a blind-but-empty book no longer blocks a
  // run it was never going to affect. #2135 widened the trigger to also
  // cover bak-side withholding, sharing this one refusal path rather than a
  // second copy of it.
  if (refuseApply) {
    console.error(
      `\nRefusing --apply: ${booksWithheldTotal} scanned book(s) had a real auto-record candidate withheld ` +
        `because their bak and/or analysis-cache evidence is unusable: ${withheldBookLabels.join('; ')}. The ` +
        `cross-source ambiguity veto (guard 2) can only see an id as ambiguous through the cache (at CACHE_DIR, ` +
        `${cacheDir}) and any cast.json.bak.* for the book — unusable evidence on either side makes every ` +
        `matched id in that book look unambiguous whether or not it actually is, silently re-opening the exact ` +
        `bak-unambiguous x cache-ambiguous cell the reserved-source/ambiguity-veto fix exists to close. Point ` +
        `CACHE_DIR at the checkout that actually ran these books' analysis, and/or fix each book's unreadable ` +
        `cast.json.bak.* (see the module doc comment), and re-run — the dry run above must report both withheld ` +
        `counts as 0 before --apply is safe. (A nonzero "books missing ... evidence" count alone does NOT block ` +
        `--apply — only a book with a real withheld candidate does.)`,
    );
    process.exitCode = 1;
    return;
  }

  if (apply && pendingWrites.length) {
    console.log('\nWriting cast-id-history.json aliases...');
    for (const w of pendingWrites) {
      const backupPath = backupCastIdHistory(w.historyPath);
      if (backupPath) console.log(`  backed up ${w.historyPath} -> ${backupPath}`);
      try {
        for (const a of w.autoRecord) {
          await mods.retireCharacterId(w.bookDir, a.id, a.to);
          console.log(`  recorded ${a.id} -> ${a.to} (${w.bookDir})`);
        }
      } catch (err) {
        // PR #2233 review, finding 2 — retireCharacterId now THROWS
        // CastIdHistoryUnreadableError on a degraded read (#2214) instead of
        // laundering the file, which is right for this book but wrong for
        // this loop: unguarded, one bad book's throw used to abort every
        // later book in the same --apply run, surfacing nothing but a raw
        // stack from main()'s top-level catch. backupCastIdHistory already
        // ran above, so the operator has a pre-write copy regardless — skip
        // this book's remaining writes and keep going.
        if (err instanceof mods.CastIdHistoryUnreadableError) {
          console.error(
            `  SKIPPED ${w.bookDir}: cast-id-history.json could not be read (${err.message}). ` +
              `A backup was taken at ${backupPath ?? '(none — see the earlier backup line for this book)'}; ` +
              `fix or restore the file and re-run --apply for this book. Continuing with the remaining books.`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  /* #2128 — the one-shot back-fill stamp, for EVERY book scanned, not only
     ones with an alias to record. Absence of `recordedAtSeq` reads 'unknown'
     and lists the whole book forever; the books carrying pre-lane aliases
     are exactly the ones this A33 workflow already visits, so this is where
     they get their field. No-op on a book that already has one, on a book
     with no history file, and on a malformed file (which is left alone to
     be fixed, never overwritten) — see `stampRecordedAtSeqIfAbsent`'s own
     doc comment for the full four-case account. Ordered after the alias
     writes above (see `stampScannedBooks`'s own doc comment for why).
     Called unconditionally — `apply` is threaded straight through and
     `stampScannedBooks` itself is the dry-run gate (review round 1, I2): no
     `if (apply)` wrapper here to accidentally call it under, and nothing to
     drift out of sync with the function it wraps. */
  const stamped = await stampScannedBooks(apply, scannedBookDirs, mods.stampRecordedAtSeqIfAbsent);
  if (stamped) console.log(`\nstamped cast-id-history recordedAtSeq on ${stamped} book(s) (#2128 one-shot)`);
}

// See scripts/lib/is-main-module.mjs — a resolve()-only comparison misses
// when the invocation crosses a symlink/junction (#2291).
const invokedDirectly = isDirectlyInvoked(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
  });
}
