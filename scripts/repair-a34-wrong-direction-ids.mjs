#!/usr/bin/env node
/*
 * repair-a34-wrong-direction-ids.mjs — register row A34 (#2584, #2040),
 * parent #2903, step 2 of the on-box repair-and-retest chain.
 *
 * Repairs the WRONG-DIRECTION `characterId` retirement shape: an
 * already-established ASCII-kebab id that a prior analysis run retired in
 * favour of its non-ASCII (typically Cyrillic) sibling, even though both ids
 * name the SAME character. PR #2640's `stripEstablishedAsciiRewrites`
 * (`server/src/analyzer/roster-dedup.ts`) stops this from happening again
 * going FORWARD, in a fresh analysis run; it does nothing for damage already
 * written to disk before that fix shipped. This script is the repair pass
 * for that pre-existing damage — see docs/testing/onbox-a34-results/
 * step-1-scope.md (step 1 of this same chain) for the on-box scope: 1 hit
 * (`Заказ Коалфолла`'s `oduvan` → `одуван`) across the 23 books scanned.
 *
 * Detection (mirrors `stripEstablishedAsciiRewrites`'s own gate exactly —
 * see that function's doc comment for the two rejected, too-broad/too-narrow
 * alternatives; this script does not re-litigate that choice, only reuses
 * its conclusion):
 *
 *   - a book's `cast-id-history.json` `supersededBy` map has an entry
 *     `from -> to` where `from` is ASCII-kebab (`isAsciiKebabId`) and `to`
 *     is NOT (the wrong-direction id-shape), AND
 *   - `to` is a currently-LIVE character in `cast.json` (otherwise there is
 *     nothing left to reinstate `from` in place of), AND
 *   - `from` and `to` are the SAME character by name, compared under the
 *     server's own `normaliseForMatch` (replicated verbatim below — see its
 *     own comment for why replicating rather than importing from
 *     `server/dist` is the right call for JUST this one small pure
 *     function), AND that name identifies a UNIQUE live row. The uniqueness
 *     half is NOT inherited from `stripEstablishedAsciiRewrites` — it is
 *     `resolveTierAName`'s tie rule (`repair-cast-id-drift.mjs:378-384`),
 *     mirrored here because the blast radius differs. There, a wrong answer
 *     skips one strip in a fresh analysis run a later run revisits; here it
 *     is a permanent write to `cast.json` and `cast-id-history.json`
 *     binding the retired id to possibly the WRONG live character.
 *
 * The THIRD test needs a name for `from` — but `from` is, by construction,
 * no longer a live row in `cast.json` (it was fully retired). The only
 * on-disk source for what it used to be called is a `cast.json.bak.*`
 * snapshot from before the retirement (`collectBakNameEntries` /
 * `buildNameIndex`, both reused from `repair-cast-id-drift.mjs` rather than
 * reimplemented — see the module doc comment there for the ambiguity
 * handling those two functions already do, e.g. the `unknown-male` reused-
 * bucket hazard). Confirmed against the one on-box hit: step 1's
 * cross-check found `Заказ Коалфолла`'s `cast.json.bak.castfix` (and two
 * other bak snapshots) all name `oduvan` as "Одуван" — the same name the
 * live `одуван` row carries today. No bak evidence (missing, unreadable, or
 * ambiguous across snapshots) means this script CANNOT confirm same-name and
 * leaves the pair alone (`reportOnly`, never auto-repaired) — same-name is
 * the one thing the wrong-direction shape and a genuine cross-script ALIAS
 * merge cannot be told apart without.
 *
 * Repair (per confirmed pair only — a book with no confirmed pair is never
 * touched, dry run or not). Both files are COPIED to a timestamped
 * `.bak.a34-<date>` sidecar before either is written (mirroring
 * `repair-cast-id-drift.mjs`'s own `backupCastIdHistory`), so the operator
 * has an on-disk undo for a run that dies part-way — the two writes are
 * separate and there is no transaction across them:
 *
 *   1. `cast-id-history.json`: call the server's own `retireCharacterId`
 *      (`server/src/store/cast-id-history.ts`), retiring `to` in favour of
 *      `from` — i.e. `retireCharacterId(bookDir, to, from)`. That function's
 *      own "direct reversal" branch is EXACTLY this case (its doc comment
 *      names the identical antón/антон repro): since `supersededBy[from] ===
 *      to` already holds, it deletes the stale forward entry, repoints
 *      anything that targeted `to` onto `from`, and writes `from -> to`
 *      correctly transitively — this script does not hand-roll a second,
 *      divergent history writer for the one case retireCharacterId already
 *      gets right.
 *   2. `cast.json`: rename the live character's `id` from `to` (non-ASCII)
 *      back to `from` (ASCII) — every other field on the row is carried
 *      over unchanged.
 *
 * That ORDER is a correctness argument, not a preference, and it is the
 * reverse of the order the issue lists the two actions in. `retireCharacterId`
 * can throw for reasons unrelated to this script (`CastIdHistoryUnreadableError`
 * on a degraded read, `LockAcquisitionTimeoutError` from its own `withKeyLock`,
 * an EPERM from an AV scanner), and there is no transaction across the two
 * files, so the intermediate state has to be survivable:
 *
 *   - history first (what this script does): live id is still `to`, history
 *     now says `to -> from`. `buildCastResolver` hits `to` in `byId`
 *     exactly, so every attribution still resolves; only the
 *     already-retired `from` dangles.
 *   - cast.json first: live id is `from`, history still says `from -> to`.
 *     `buildCastResolver` only counts a history entry whose TARGET is live
 *     (`cast-resolve.ts:113-118`) and `to` no longer is, so the entry is
 *     dropped; `normaliseIdKey` is lowercase + hyphen folding and does not
 *     transliterate, so the two ids do not collide there either. Net:
 *     `resolve(to)` returns `undefined` and EVERY attribution and frozen
 *     render pointing at `to` — which is all of them, `to` being the live
 *     id today — is orphaned.
 *
 * `retireCharacterId` never reads `cast.json`, so nothing about the repair
 * depends on the old order.
 *
 * Dry-run by default; `--apply` writes both files. `--apply` refuses
 * outright if a server is live on the resolved `PORT`/`LAN_HTTPS_PORT` (incl.
 * the `listenWithAutoRebind` range) — same probe `repair-cast-id-drift.mjs`
 * already uses (`probePortRangeRefused`), reused directly rather than a
 * second liveness check that could drift from it. `cast-id-history.json` is
 * written out-of-process by this script, exactly like that sibling script,
 * so the same out-of-process-write hazard applies unchanged.
 *
 * A book with zero confirmed pairs is never written to, in either file —
 * `planWorkspaceRepairs` only returns a book in `bookPlans` when it has at
 * least one confirmed `repairs` entry.
 *
 * Env:
 *   BASE / WORKSPACE_DIR / AUDIOBOOK_WORKSPACE   workspace root (same
 *     fallback chain as every other repair script here); default
 *     `<home>/AudiobookWorkspace`.
 *   PORT             loopback port the --apply liveness probe checks
 *                     (default 8080).
 *   LAN_HTTPS_PORT   LAN HTTPS port the --apply liveness probe ALSO checks
 *                     (default 8443).
 *   ALLOW_STANDING_PORTS  comma-separated ports the shared liveness probe
 *                     should SKIP (standing non-Castwright services only).
 *                     Empty by default — see `parseStandingPorts` in
 *                     repair-cast-id-drift.mjs for why this is a per-run
 *                     opt-in rather than a hardcoded set, and why 8090 in
 *                     particular must not be skipped blindly.
 *
 * Usage:
 *   node scripts/repair-a34-wrong-direction-ids.mjs            # dry run
 *   node scripts/repair-a34-wrong-direction-ids.mjs --apply    # write
 *
 * Tests: scripts/tests/repair-a34-wrong-direction-ids.test.mjs. The planning
 * helpers (`isAsciiKebabId`, `normaliseForMatch`, `planBookRepairs`,
 * `planWorkspaceRepairs`) are pure and unit-tested with no `server/dist`
 * build needed. `applyBookPlan` is exported and driven DIRECTLY by the write
 * -path tests against an fs fixture with a fake `retireCharacterId` /
 * `writeJsonAtomic`, so no build is needed there either — only `main()`'s
 * own dynamic `import()` of `server/dist` is left uncovered, the same split
 * `repair-cast-id-drift.mjs`'s test file already documents. Do NOT make
 * `applyBookPlan` private again and assert on a re-implementation of it in
 * the test: that is what the first revision did, and it left the argument
 * swap, a `return;` stub, and the partial-repair refusal all invisible.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import {
  collectBooks,
  collectBakNameEntries,
  buildNameIndex,
  probePortRangeRefused,
  AUTO_REBIND_RANGE,
} from './repair-cast-id-drift.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests, no fs/server/dist dependency.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

/** ASCII kebab-case test — lowercase letters/digits, single hyphens between
 *  groups, no leading/trailing hyphen. Verbatim copy of
 *  `server/src/analyzer/roster-dedup.ts`'s `isAsciiKebabId` (not exported
 *  there) — the exact shape test the wrong-direction defect is defined
 *  against; this script and that comparator must never disagree about what
 *  counts as "established ASCII". */
export function isAsciiKebabId(id) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** Behaviour-identical copy of `server/src/util/text-match.ts`'s `normaliseForMatch`
 *  (lowercase, smart-quote/dash/ellipsis folding, edge-trim, whitespace
 *  collapse) — the module doc comment's "import or replicate this one
 *  exactly" call: replicated rather than imported because it is small,
 *  genuinely pure, and importing it alone would otherwise force every unit
 *  test through the `server/dist` build step this script's own tests are
 *  deliberately free of (see `repair-cast-id-drift.mjs`'s own test file for
 *  the same tradeoff already made there for its pure helpers). If
 *  `text-match.ts` ever changes this function, this copy must change with
 *  it — there is no third place either may drift to. Not textually
 *  identical: this copy escapes the isEdge class's quote/backtick as
 *  \uXXXX (see that line's own comment). Same class, same outputs. */
export function normaliseForMatch(s) {
  const stripped = String(s)
    .toLowerCase()
    .replace(/[‘’‚‛‹›]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[—–―]/g, '-')
    .replace(/…/g, '...');
  let a = 0;
  let b = stripped.length;
  /* The quote and backtick are written as \uXXXX escapes rather than
     literally: an unpaired quote/backtick inside a regex literal desyncs the
     source scanner in server/src/spawn-windows-hide.test.ts, which fails loud
     on that shape (#2747, closed by #2764) for every file under scripts/.
     The character class is unchanged - whitespace, ", ' and ` - which the
     "edge-trim class" tests below pin character by character. */
  const isEdge = (ch) => /[\s\u0022\u0027\u0060]/.test(ch);
  while (a < b && isEdge(stripped[a])) a += 1;
  while (b > a && isEdge(stripped[b - 1])) b -= 1;
  return stripped.slice(a, b).replace(/\s+/g, ' ');
}

/** Core detector + repair-plan for ONE book. Pure — takes already-loaded
 *  plain data, does no I/O.
 *
 *  `input.liveCast` — `cast.json`'s `characters` array (only `id`/`name`
 *  are read). `input.supersededBy` — `cast-id-history.json`'s
 *  `supersededBy` map (`{}` if the book has no history file at all — the
 *  common case; see step 1's scope doc). `input.bakNameIndex` — the `Map`
 *  `buildNameIndex(collectBakNameEntries(audiobookDir), normaliseForMatch)`
 *  produces (id -> `{name, ambiguous, distinctNames}`).
 *  `input.bakAvailable` — `collectBakNameEntries`'s SECOND return field: is
 *  this book's bak evidence fully readable? `false` means the directory
 *  could not be enumerated, or at least one `cast.json.bak.*` that exists
 *  failed to parse / shape-check. `buildNameIndex` cannot represent that
 *  state: an unparseable snapshot is swallowed to `null` by `readJsonSync`,
 *  contributes zero entries, and `buildNameIndex`'s own `normSet.size > 1`
 *  check then reads the SURVIVING entries as unambiguous rather than as
 *  unknown — the exact #2135 fail-open shape. A book's bak evidence is
 *  judged as a WHOLE (an unread file could have named ANY id ambiguously),
 *  so `false` withholds every matched pair in the book, the same
 *  over-cautious-but-safe shape `repair-cast-id-drift.mjs` already takes at
 *  its own `bakAvailable` gate (`:2605`, `:2641`). Absent/`undefined` is NOT
 *  read as `false`: a caller that simply has no bak index already gets
 *  `no-name-evidence` per id; only an explicit `false` means evidence was
 *  LOST.
 *
 *  Returns `{ repairs, reportOnly }`:
 *    - `repairs`   — confirmed wrong-direction pairs, safe to apply:
 *                    `{ asciiId, nonAsciiId, name }`.
 *    - `reportOnly` — a pair that matched the ASCII/non-ASCII id-shape but
 *                    could not be confirmed same-character:
 *                    `{ asciiId, nonAsciiId, reason }`, never auto-repaired.
 *                    Five reasons: `ascii-id-already-live`,
 *                    `bak-evidence-unreadable` (the book's bak evidence was
 *                    LOST, so its silence proves nothing),
 *                    `no-name-evidence` (no/ambiguous bak entry for this
 *                    id), `name-mismatch` (the expected, common case of a
 *                    genuine, deliberate id-shape rewrite that is NOT this
 *                    defect), and `live-name-not-unique` (the names agree
 *                    but two live rows share the name, so the evidence
 *                    cannot say WHICH one). */
export function planBookRepairs(input, deps = { normaliseForMatch }) {
  const { liveCast, supersededBy, bakNameIndex, bakAvailable } = input;
  const liveById = new Map(liveCast.map((c) => [c.id, c]));
  const repairs = [];
  const reportOnly = [];

  /* Live-side uniqueness census for the same-name confirmation below. Counts
     ARRAY ENTRIES, exactly as `resolveTierAName`
     (`repair-cast-id-drift.mjs:378-384`) does — that function returns
     `undefined` on a tie and its own doc comment says why: it is "the same
     'a tie means stop' rule `buildCastResolver` and `remapFreshToPriorIds`
     both already apply; this function must not reintroduce a looser one."
     A bare 1-1 name comparison IS a looser one. Minor cast routinely shares
     a display name (Солдат, Стражник, Голос, and the unknown-male/
     unknown-female buckets), and here a wrong answer is not a skipped strip
     in a fresh analysis run that a later run revisits — it is a PERMANENT
     write binding the retired id, and every attribution behind it, to
     possibly the wrong live row (a different `voiceUuid`, so the character
     renders in the wrong voice). */
  const liveNameCounts = new Map();
  for (const c of liveCast) {
    if (typeof c.name !== 'string') continue;
    const norm = deps.normaliseForMatch(c.name);
    if (!norm) continue;
    liveNameCounts.set(norm, (liveNameCounts.get(norm) ?? 0) + 1);
  }

  for (const [asciiId, nonAsciiId] of Object.entries(supersededBy ?? {})) {
    // Direction gate: `from` must be the established ASCII id, `to` the
    // non-ASCII survivor — this is the ONE shape #2584/A34 covers. An
    // ASCII->ASCII or non-ASCII->ASCII entry is a different, legitimate
    // rewrite (a fold onto unknown-male/unknown-female, an id-format
    // cleanup, a genuine improvement onto a more canonical id) and is left
    // untouched — see step 1's scope doc for the 4 real books that hit
    // exactly this "not the shape" case.
    if (!isAsciiKebabId(asciiId) || isAsciiKebabId(nonAsciiId)) continue;

    const liveChar = liveById.get(nonAsciiId);
    // `to` isn't currently live: either already repaired, or the id was
    // itself later retired again onto something else — either way there is
    // no live row left to rename back, so this is not an actionable pair.
    if (!liveChar) continue;
    // `from` somehow already live too (should not happen given retireCharacterId's
    // own invariants, but this script never assumes a file it did not just
    // write is well-formed) — ambiguous, never auto-repaired.
    if (liveById.has(asciiId)) {
      reportOnly.push({ asciiId, nonAsciiId, reason: 'ascii-id-already-live' });
      continue;
    }

    // #2135's gate, applied here too: this book's bak evidence is not fully
    // readable, so "the index has no ambiguous flag for this id" means
    // NOTHING — the file that would have raised it is the one that failed to
    // parse. Withhold every matched pair in the book. See the doc comment.
    if (bakAvailable === false) {
      reportOnly.push({ asciiId, nonAsciiId, reason: 'bak-evidence-unreadable' });
      continue;
    }

    const liveName = typeof liveChar.name === 'string' ? liveChar.name : '';
    const bakEntry = bakNameIndex?.get(asciiId);
    if (!liveName || !bakEntry || bakEntry.ambiguous || !bakEntry.name) {
      reportOnly.push({ asciiId, nonAsciiId, reason: 'no-name-evidence' });
      continue;
    }
    if (deps.normaliseForMatch(bakEntry.name) !== deps.normaliseForMatch(liveName)) {
      reportOnly.push({ asciiId, nonAsciiId, reason: 'name-mismatch' });
      continue;
    }
    // The names agree — but does that name identify a UNIQUE live character?
    // If two live rows share it, nothing on disk says which one the retired
    // ASCII id was, and the evidence cannot be made to answer that. Tie
    // means stop (see the census above).
    if (liveNameCounts.get(deps.normaliseForMatch(liveName)) !== 1) {
      reportOnly.push({ asciiId, nonAsciiId, reason: 'live-name-not-unique' });
      continue;
    }

    repairs.push({ asciiId, nonAsciiId, name: liveChar.name });
  }

  return { repairs, reportOnly };
}

/** Workspace-wide plan: given every `collectBooks` entry plus each book's
 *  loaded history + bak index, returns only the books that have at least
 *  one CONFIRMED repair — a book with zero confirmed pairs (whether it has
 *  no history file at all, or a history file with no wrong-direction entry,
 *  or only report-only pairs) is never included, so a caller that only acts
 *  on `bookPlans` never touches `cast.json` for a book with nothing to fix
 *  (the issue's own "do not touch a book with no detected entry" rule). */
export function planWorkspaceRepairs(bookInputs, deps = { normaliseForMatch }) {
  const bookPlans = [];
  const reportOnly = [];
  for (const input of bookInputs) {
    const { repairs, reportOnly: bookReportOnly } = planBookRepairs(input, deps);
    for (const r of bookReportOnly) reportOnly.push({ ...r, book: input.label });
    if (repairs.length > 0) bookPlans.push({ book: input.label, bookDir: input.bookDir, castPath: input.castPath, repairs });
  }
  return { bookPlans, reportOnly };
}

// ---------------------------------------------------------------------------
// I/O — everything below touches the filesystem, the network, or server/dist.
// ---------------------------------------------------------------------------

function resolveWorkspaceDir() {
  return (
    (process.env.BASE && path.resolve(process.env.BASE)) ||
    (process.env.WORKSPACE_DIR && path.resolve(process.env.WORKSPACE_DIR)) ||
    (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
    path.join(os.homedir(), 'AudiobookWorkspace')
  );
}

const readJsonSync = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Loads this script's `main()`-only dependency on the compiled server:
 *  `retireCharacterId` (history write, direct-reversal branch) and
 *  `writeJsonAtomic` (cast.json write) — reused rather than re-implemented
 *  for the same reason `repair-cast-id-drift.mjs` reuses them (see that
 *  script's own module doc comment): a second, hand-rolled history writer
 *  or a second atomic-write primitive is exactly the "two independent
 *  implementations disagree" defect class this codebase has already been
 *  bitten by more than once. Only called from `main()`, never from the pure
 *  planning helpers above, so every unit test of THOSE needs no build step. */
async function loadServerModules() {
  const need = ['server/dist/store/cast-id-history.js', 'server/dist/workspace/state-io.js'];
  for (const rel of need) {
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
      throw new Error(
        `Missing compiled server module: ${rel}\n` +
          `This script reuses the server's own retireCharacterId/writeJsonAtomic rather than ` +
          `re-implementing them. Run "cd server && npm run build" (or the root "npm run build") ` +
          `first, then re-run this script.`,
      );
    }
  }
  const [castIdHistory, stateIo] = await Promise.all([
    import('../server/dist/store/cast-id-history.js'),
    import('../server/dist/workspace/state-io.js'),
  ]);
  return {
    retireCharacterId: castIdHistory.retireCharacterId,
    writeJsonAtomic: stateIo.writeJsonAtomic,
  };
}

/** Copies `filePath` to `<filePath>.bak.a34-<YYYY-MM-DD>` if it exists,
 *  returning the backup path (or `null` when there was nothing to copy).
 *  Same shape as `repair-cast-id-drift.mjs`'s `backupCastIdHistory`. This
 *  script writes TWO files with no transaction across them, so the operator
 *  needs an on-disk undo for both, not advice. `writeJsonAtomic`'s own
 *  `{ rotate: { keep } }` is not used for this: it rotates only the file
 *  being written, and the history file is not written by this script at all
 *  — `retireCharacterId` writes it, from inside the server.
 *
 *  The cast.json copy lands as `cast.json.bak.a34-<date>`, which
 *  `collectBakNameEntries` WILL pick up as bak evidence on a later run.
 *  That is deliberate and correct: it is a genuine pre-repair snapshot of
 *  this book's cast, the same class of file as the `cast.json.bak.castfix`
 *  the workspace already carries, and it names the ids it really held at
 *  that moment. */
export function backupBeforeApply(filePath, deps = { fs }) {
  if (!deps.fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = `${filePath}.bak.a34-${stamp}`;
  deps.fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/** Applies one book's confirmed repairs: retires `nonAsciiId` in
 *  `cast-id-history.json` via the server's own `retireCharacterId`
 *  (direct-reversal branch), THEN renames each matched character's `id` in
 *  `cast.json` from `nonAsciiId` back to `asciiId`. Both files are backed up
 *  first. Written unconditionally (this function is only ever called under
 *  `--apply`, gated in `main()`).
 *
 *  History-before-cast is deliberate and load-bearing — see the module doc
 *  comment's "That ORDER is a correctness argument" paragraph for the two
 *  intermediate states and why only this one keeps every attribution
 *  resolvable.
 *
 *  Exported so the tests drive THIS function rather than a copy of it. An
 *  earlier revision left it private and the test re-implemented its body;
 *  four separate mutations to the real function — including swapping
 *  `retireCharacterId`'s last two arguments, which re-inflicts the exact
 *  A34 defect this script exists to repair — left the suite fully green. */
export async function applyBookPlan(bookPlan, mods) {
  const cast = readJsonSync(bookPlan.castPath);
  if (!cast || !Array.isArray(cast.characters)) {
    throw new Error(`${bookPlan.castPath}: cast.json missing or malformed at apply time`);
  }
  const byNonAsciiId = new Map(bookPlan.repairs.map((r) => [r.nonAsciiId, r.asciiId]));
  let renamed = 0;
  const characters = cast.characters.map((c) => {
    const newId = byNonAsciiId.get(c.id);
    if (newId === undefined) return c;
    renamed += 1;
    return { ...c, id: newId };
  });
  // Refuse BEFORE any backup or write: a plan that no longer matches the
  // cast.json on disk means the file moved under us since planning, and a
  // partial rename is worse than no rename.
  if (renamed !== bookPlan.repairs.length) {
    throw new Error(
      `${bookPlan.castPath}: expected to rename ${bookPlan.repairs.length} character(s), renamed ${renamed} — ` +
        `refusing to write a partial repair.`,
    );
  }
  cast.characters = characters;

  // Same path the server's own `castIdHistoryPath` builds
  // (`cast-id-history.ts:197-199`, `join(bookDir, '.audiobook',
  // 'cast-id-history.json')`) — this must back up the file
  // `retireCharacterId` is about to write, not a neighbour of it.
  const historyPath = path.join(bookPlan.bookDir, '.audiobook', 'cast-id-history.json');
  const backups = [backupBeforeApply(bookPlan.castPath), backupBeforeApply(historyPath)].filter(Boolean);

  try {
    for (const r of bookPlan.repairs) {
      await mods.retireCharacterId(bookPlan.bookDir, r.nonAsciiId, r.asciiId);
    }
    await mods.writeJsonAtomic(bookPlan.castPath, cast);
  } catch (err) {
    // Name the backups in the failure itself. A run that dies between the
    // two writes leaves a book half-repaired, and the operator has to be
    // told where the pre-repair copies are without going hunting.
    throw new Error(
      `${bookPlan.castPath}: repair failed part-way (${err?.message ?? err}). Pre-repair copies: ` +
        `${backups.length ? backups.join(', ') : '(none — neither file existed)'}.`,
      { cause: err },
    );
  }
  return { backups };
}

/**
 * @param {string[]} argv — process.argv slice (flags only; pass [] for defaults)
 * @param {string} [workspaceDirOverride] — override the resolved workspace root (used in tests)
 */
export async function main(argv = process.argv.slice(2), workspaceDirOverride) {
  const { apply } = parseArgs(argv);
  const workspaceDir = workspaceDirOverride ?? resolveWorkspaceDir();
  const port = Number(process.env.PORT ?? 8080);
  const lanPort = Number(process.env.LAN_HTTPS_PORT ?? 8443);

  console.log('=== A34 (#2584/#2040) wrong-direction characterId repair pass ===');
  console.log(`mode: ${apply ? 'APPLY (writing cast.json + cast-id-history.json)' : 'DRY RUN (no writes)'}`);
  console.log(`workspace: ${workspaceDir}`);

  if (apply) {
    console.log(
      `probing 127.0.0.1:${port}-${port + AUTO_REBIND_RANGE - 1} and ` +
        `127.0.0.1:${lanPort}-${lanPort + AUTO_REBIND_RANGE - 1} for a live server...`,
    );
    const [httpNotRefused, lanNotRefused] = await Promise.all([
      probePortRangeRefused(port),
      probePortRangeRefused(lanPort),
    ]);
    const notRefused = [...httpNotRefused, ...lanNotRefused];
    if (notRefused.length) {
      console.error(
        `\nRefusing --apply: port(s) ${notRefused.join(', ')} did not return a clear ECONNREFUSED — treating as ` +
          `possibly-live. This script writes cast.json and cast-id-history.json out-of-process, with no ` +
          `in-process lock covering either against a running server's own writes. Stop the server on ` +
          `${port}-${port + AUTO_REBIND_RANGE - 1} (and LAN HTTPS ${lanPort}-${lanPort + AUTO_REBIND_RANGE - 1} ` +
          `if running), or point PORT/LAN_HTTPS_PORT elsewhere.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const { books } = collectBooks(workspaceDir);
  console.log(`books scanned: ${books.length}\n`);

  const bookInputs = books.map((book) => {
    const historyPath = path.join(book.audiobookDir, 'cast-id-history.json');
    const history = readJsonSync(historyPath);
    // BOTH fields, not just `entries` — see planBookRepairs's doc comment
    // for `input.bakAvailable`. Discarding the second one is #2135's
    // fail-open shape: an unparseable snapshot vanishes into zero entries
    // and the survivors then read as unambiguous rather than as unknown.
    const { entries: bakEntries, bakAvailable } = collectBakNameEntries(book.audiobookDir);
    return {
      label: book.label,
      bookDir: book.bookDir,
      castPath: path.join(book.audiobookDir, 'cast.json'),
      liveCast: book.cast.characters,
      supersededBy: history?.supersededBy ?? {},
      bakNameIndex: buildNameIndex(bakEntries, normaliseForMatch),
      bakAvailable,
    };
  });

  const { bookPlans, reportOnly } = planWorkspaceRepairs(bookInputs);

  if (reportOnly.length) {
    console.log(`report-only (id-shape matched, but same-character NOT confirmed — never auto-repaired): ${reportOnly.length}`);
    for (const r of reportOnly) console.log(`  - [${r.book}] ${r.asciiId} -> ${r.nonAsciiId} (${r.reason})`);
    console.log('');
  }

  if (!bookPlans.length) {
    console.log('0 confirmed wrong-direction pairs — nothing to repair.');
    return;
  }

  console.log(`confirmed repairs: ${bookPlans.reduce((n, b) => n + b.repairs.length, 0)} across ${bookPlans.length} book(s)`);
  for (const plan of bookPlans) {
    for (const r of plan.repairs) {
      console.log(`  - [${plan.book}] ${apply ? 'reinstating' : 'would reinstate'} "${r.asciiId}" (was "${r.nonAsciiId}", "${r.name}")`);
    }
  }

  if (!apply) {
    console.log('\nRe-run with --apply to write.');
    return;
  }

  const mods = await loadServerModules();
  for (const plan of bookPlans) {
    const { backups } = await applyBookPlan(plan, mods);
    console.log(`  -> wrote ${plan.castPath} and its cast-id-history.json`);
    if (backups.length) console.log(`     pre-repair copies: ${backups.join(', ')}`);
  }
  console.log(`\nApplied ${bookPlans.length} book(s).`);
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exitCode = 1;
  });
}
