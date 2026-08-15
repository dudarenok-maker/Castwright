## Implementation plan v2 — rebuild the audition centroid reference when a character's voice changes (Closes #1969)

> Updated after an independent adversarial review (differs from v1: the recorded identity is widened to the full audition-render parameter set — voice, model key, **language**, cloned; a Coqui same-name caveat is documented; the language-rebuild and voice-info-absent cases are pinned by tests; worktree bootstrap is an explicit task). Plan-first: nothing is implemented until this is approved.

### Root cause
`resolveCharacterReference` (`server/src/audio/render-integrity/aggregate.ts`) persists the Option-B audition centroid (for characters too thin on in-book anchors) and reuses it verbatim on later passes, because the row records nothing identifying the voice it was built from. A voice reassignment leaves the character scored against a speaker it no longer is → false `voice-mismatch / severe` on correct audio, re-rendering every pass. In-book references self-heal (rebuilt each pass); only the persisted audition path is stale.

### Design decision
Persist an `auditionVoice` identity on audition rows = **`{ voiceName, modelKey, language?, cloned }`** — the `AuditionCharacter` parameters that determine what the audition actually renders. Reuse a persisted audition row **iff** the character's current `voiceInfo` is present and every recorded field matches the current value. Otherwise (any mismatch, or an absent/unknown record) → **discard and rebuild**.

- **Why these four fields:** `voiceName` is the actual voice sent to the provider (snapshot `resolvedVoiceName`, #1972) and `modelKey` is the render tier — the issue's sanctioned "name + modelKey". `language` (#1951) and `cloned` are the remaining parameters that change what the audition synthesises; including them closes the reviewer's gap where a book **language change** would otherwise leave an old-language audition against new-language chapters. Comparison is on structured, debuggable fields, not an opaque hash.
- **Reuse gate:** `voiceInfo != null && matchesCurrentVoice(persisted, voiceInfo)`. `voiceInfo` absent → not trusted → falls through to the rebuild path (→ `too-short` when no voice info exists at all) — a deliberate, tested behavior change from today's unconditional reuse.
- **Legacy (acceptance 3):** a row with no `auditionVoice` (every pre-change `centroids.json`) is "unknown" → rebuilt once. Field rules: `voiceName`/`modelKey`/`cloned` always compared; `language` participates only when the persisted row recorded one (a recorded language that differs from the current, or a recorded language with a now-unknown current, is a mismatch → rebuild).
- **Coqui same-name caveat (residual, documented):** Coqui designed-voice names are bucket-derived (`voice-mapping.ts:390-394` — `stableHash(characterId) % catalog[profile].length`), so two assignable catalog voices in the same profile bucket can share a `resolvedVoiceName`. Since #1972 the snapshot records the voice *actually sent*, two **explicitly-assigned** distinct Coqui voices have distinct sent names — so the collision only affects *auto-derived* (never-explicitly-assigned) voices, which cannot be "reassigned between distinct voices." Carried as an open confirmation, not silently ignored.
- **Single covering seam:** the gate lives in the scoring path, upstream of every reassignment route (assign, splice, re-cast). Clear-on-assign in `POST /api/voice-library/:uuid/assign` was **considered and rejected because it is strictly weaker and incomplete** — it misses splice/re-cast/override paths; the score-path gate is the one place that covers all of them.
- Rejected drift-distance as identity: it cannot reliably distinguish "same voice, different sample" from "different speaker" — the exact false-negative this defect abuses.

### Open confirmation needed (identity proxy — for the maintainer)
The gate assumes **every** reassignment of a real, assignable voice changes at least one recorded field, and no non-reassignment does. Confirmed for the clone case (reassign flips `qwen-<uuid>`); the language/cloned extension covers non-clone re-renders and book-language changes. The one residual unit tests cannot settle is the Coqui same-bucket collision above — confirm the assign UI always sets an explicit, cardinal sent name for a reassigned Coqui character.

### Acceptance-criteria mapping
| # | Criterion | Where it lands |
|---|---|---|
| 1 | Row records what voice it was built from | `auditionVoice {voiceName, modelKey, language?, cloned}` set on audition build |
| 2 | Mismatched/unknown record → discarded & rebuilt | `matchesCurrentVoice` gate in `resolveCharacterReference` |
| 3 | Missing field → treated unknown, rebuilt once | Same gate (absent ⇒ no match ⇒ rebuild once, then re-persisted with voice) |
| 4 | Regression test fails-before/passes-after | `aggregate-audition-voice-reassign.test.ts` (Tests 1–4) |

### Files
- **Modify** `server/src/audio/render-integrity/centroids-io.ts` — `AuditionVoiceRef` interface + optional `CharacterCentroid.auditionVoice`.
- **Modify** `server/src/audio/render-integrity/aggregate.ts` — optional `CharacterReference.auditionVoice`; `matchesCurrentVoice`; gated reuse; stamp on build; `persistedAsRef` carriage; JSDoc.
- **Create** `server/src/audio/render-integrity/aggregate-audition-voice-reassign.test.ts` — regression suite.
- **Modify** `docs/release-notes-next.md` + `RELEASE_NOTES.md`; record the on-box row in `docs/testing/onbox-acceptance-register.md` (+ live view).

---
### Task 0 — Worktree & environment bootstrap (one-time)
- [ ] Verify the worktree `wt-1969-audition-reference-voice` on branch `fix/server-1969-audition-reference-voice` (`git worktree list`). Bootstrap via `node scripts/wt-new.mjs fix/server-1969-audition-reference-voice` if not present — a fresh worktree's hooks and `server/node_modules` are silent failure traps otherwise (missing junctions fail the server legs with "vitest not found").
- [ ] Confirm `server/node_modules` exists and hooks are wired (`npx husky`) before running server tests.

### Task 1 — Persist the voice identity on audition centroids
**Modify:** `server/src/audio/render-integrity/centroids-io.ts` (interface only).

- [ ] Add the interface + optional field:
```ts
export interface AuditionVoiceRef {
  /** Resolved voice name actually sent to the provider (snapshot resolvedVoiceName, #1972). */
  voiceName: string;
  /** The TTS model key the audition rendered under. */
  modelKey: string;
  /** Book language the audition rendered in (#1951). Optional — pre-#1951 auditions carry none. */
  language?: string;
  /** Whether the voice is a clone on this engine. Always present on built rows. */
  cloned?: boolean;
}
// inside CharacterCentroid, after referenceKind:
auditionVoice?: AuditionVoiceRef;
```
- [ ] Confirm no runtime change — `writeCentroids`/`readCentroids` round-trip JSON; the field is optional.

### Task 2 — Gate audition-centroid reuse on the recorded identity; stamp it on rebuild
**Modify:** `server/src/audio/render-integrity/aggregate.ts`.

- [ ] **Step 1 — import the type:** in the `./centroids-io.js` import block add `type AuditionVoiceRef`.
- [ ] **Step 2 — extend `CharacterReference`** with `auditionVoice?: AuditionVoiceRef;`.
- [ ] **Step 3 — `persistedAsRef` carries it through** so a match-checked reuse rewrites the same identity back (not dropped next pass):
```ts
function persistedAsRef(row: CharacterCentroid): CharacterReference {
  return { centroid: row.centroid, cleanMean: row.cleanMean, pSevere: row.pSevere, pBand: row.pBand, referenceKind: row.referenceKind, auditionVoice: row.auditionVoice };
}
```
- [ ] **Step 4 — add the match helper:**
```ts
function matchesCurrentVoice(row: CharacterCentroid, voiceInfo: AuditionCharacter): boolean {
  const r = row.auditionVoice;
  if (row.referenceKind !== 'audition' || r == null) return false;
  // language is compared when the persisted row recorded one: a recorded language
  // differing from the current, or a recorded language with a now-unknown current,
  // is a mismatch -> rebuild. Absence on the row is lenient (pre-#1951 auditions).
  const langMatch = r.language === undefined || r.language === voiceInfo.language;
  return r.voiceName === voiceInfo.voiceName && r.modelKey === voiceInfo.modelKey && r.cloned === voiceInfo.cloned && langMatch;
}
```
- [ ] **Step 5 — replace the unconditional reuse** in `resolveCharacterReference`:
```ts
if (persisted?.referenceKind === 'audition' && voiceInfo != null && matchesCurrentVoice(persisted, voiceInfo)) {
  return { status: 'resolved', ref: persistedAsRef(persisted) };
}
```
(`voiceInfo != null` → an audition row for a character with no current voice info is not trusted; falls to `too-short`.)
- [ ] **Step 6 — stamp the fresh build:**
```ts
return { status: 'resolved', ref: { centroid: centroidArr, cleanMean, pSevere, pBand, referenceKind: 'audition', auditionVoice: { voiceName: voiceInfo.voiceName, modelKey: voiceInfo.modelKey, ...(voiceInfo.language != null ? { language: voiceInfo.language } : {}), cloned: voiceInfo.cloned } } };
```
- [ ] **Step 7 — update the surrounding JSDoc** (currently promises "reuse it verbatim" unconditionally) to describe the match-checked reuse.

---
### Task 3 — Regression tests (fails before, passes after)
**Create:** `server/src/audio/render-integrity/aggregate-audition-voice-reassign.test.ts`. Mock `./audition-centroid.js` (existing seam, pattern of `aggregate-audition-tier.test.ts`) to return a resolvable `{ kind: 'audition' }` pool; drive `scoreBook` over a 3-anchor (too-thin) book.

- [ ] **Test 1 — voice mutation:** pass 1 voice A → audition runs once, row persists `auditionVoice {A}`; pass 2 same voice A → reused (call count stays 1); pass 3 voice B → rebuilt (call count 2), row now `{B}`.
- [ ] **Test 2 — legacy row:** hand-write an `audition` row with **no** `auditionVoice`; assert rebuilt (audition called once) and re-persisted with the current voice.
- [ ] **Test 3 — voice-info absent:** snapshot has `voiceEngine` but no `resolvedVoiceName` + persisted audition row → resolved `too-short` (inconclusive), never the stale reference. Pins the deliberate behavior change.
- [ ] **Test 4 — book language change:** same `voiceName`+`modelKey` but a different book `language` → rebuilt (closes the reviewer's language gap with a test).
- [ ] **Mutation proof (mandatory):** temporarily revert Task 2 Step 5 to the old unconditional reuse → Test 1 must fail; restore. Record the mutation run in the PR body.

Run: `npx vitest run src/audio/render-integrity/aggregate-audition-voice-reassign.test.ts` → pass; then `npx vitest run src/audio/render-integrity` (full dir) → no regression (`aggregate.test.ts`, `audition-*.test.ts`).

### Task 4 — Release notes + validation
- [ ] Technical entry in `docs/release-notes-next.md` (🔊 Generation quality & engine health) referencing `#1969`; matching user-facing brand-voice line at the top of the in-progress `RELEASE_NOTES.md`.
- [ ] `npx tsc --noEmit -p server` → exit 0.
- [ ] `npx eslint server/src/audio/render-integrity/aggregate.ts server/src/audio/render-integrity/centroids-io.ts <new-test> --max-warnings 0` → exit 0.
- [ ] `npm run config:check` → passes.
- [ ] Stage and run `npm run verify:fast:branch` as the pre-push gate.

### Release-note wording (short)
- **Technical:** "Reassigning a character's voice no longer pins the render-integrity gate to the old speaker's audition reference (#1969). The persisted audition centroid records the voice it was built from (name, model, language, cloned), is reused only while that matches, and is discarded + rebuilt otherwise; pre-existing files without the field are rebuilt once."
- **Brand-voice:** "Changing a character's voice no longer drags their old sound into every new line — the reference now remembers which voice it was built from and rebuilds itself the moment you change the voice."

### Commits (Conventional Commits)
1. `test(server): regression: audition centroid is rebuilt after a voice reassignment (#1969)`
2. `fix(server): rebuild the audition centroid when a character's voice is reassigned (#1969)`
3. `docs(docs): plan + release notes for the #1969 audition-reference fix`

### Ship obligations
- PR title matches the commit-subject format; PR body carries `Closes #1969` and records the mutation-proof run.
- **On-box acceptance (owed, recorded not run):** record a row in `docs/testing/onbox-acceptance-register.md` (+ live-view HTML) for rebuild-on-reassign, and note the existing A24 `voice-mismatch` sub-check blocked on #1969 is unblockable by this fix. Completes in the shipping PR.
- Resolve the identity-proxy open confirmation (Coqui same-bucket) with the maintainer before merge.

### Open risks / edge cases
- **Voice-info absent** → `too-short` (Test 3), deliberate behavior change.
- **modelKey best-effort on legacy segments** (`snap.modelKey ?? cd.modelKey ?? 0.6B`): recorded key is what the audition rendered under → self-consistent; a real tier change reads as a mismatch and rebuilds (correct).
- **Coqui same-name bucket collision** (`voice-mapping.ts:390-394`): residual only for auto-derived, never-explicitly-assigned voices; carried as an open confirmation.
- **Language recompute:** `readBookLanguage` resolves `'en'` for a state.json with no `language` key; a legacy absent-language audition records no language (lenient rule keeps matching); once a book's language is set/recorded, the next change is caught.
