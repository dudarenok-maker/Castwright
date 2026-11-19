/* fs-51 — per-book QA report aggregation. Reads existing per-chapter files
   (never a new persisted book-level aggregate) and computes one honest
   summary. See docs/superpowers/specs/2026-07-05-fs51-qa-report-design.md
   for the "never a false pass" constraint this module is built around —
   in particular, voiceDrift.chaptersEligible is computed HERE, directly
   from segments.json, rather than derived from scoreBook's output, because
   scoreBook's own early-return control flow can't distinguish "nothing to
   check" from "never ran" (see the spec's round-3 finding).

   The per-character STOCHASTIC classification itself, though, is NOT
   re-derived independently — it calls scoreBook's own book-wide, first-
   chapter-wins `resolveConfiguredEngineByChar` (a pure helper, no control
   flow) so this module's eligibility population can never disagree with
   what scoreBook actually attempts to score (PR #1433 review finding: a
   per-chapter re-derivation here could classify a character stochastic in
   a chapter that scoreBook's book-wide view never scores, producing a
   false "embed failed" count). */

import { loadSegmentsFiles } from './segments-io.js';
import { deriveBookOutline } from './render-integrity/verdicts-io.js';
import {
  STOCHASTIC_ENGINES,
  charsWithCurrentVoiceLine,
  createCurrentVoiceFacts,
  loadCastContext,
  resolveConfiguredEngineByChar,
  resolveRowCharId,
  segKey,
} from './render-integrity/aggregate.js';
import type { CurrentVoiceChapter } from './render-integrity/aggregate.js';
import { livePartPath } from '../workspace/take-fields.js';
import { readEmbeddings } from './render-integrity/embeddings-io.js';
import { readCentroids } from './render-integrity/centroids-io.js';
import { audioDir } from '../workspace/paths.js';
import { configValue } from '../config/resolver.js';

export interface AudioQaReport {
  chaptersRendered: number;
  totalLines: number;
  acoustic: { linesChecked: number; linesRerecorded: number; chaptersFlagged: number };
  asr: { linesVerified: number; linesFlaggedDrift: number };
  voiceDrift: {
    attribution: 'full' | 'legacy-unattributed';
    /** #4454 — the live qa.speaker.enabled gate; false means no score pass will run, so nothing in charactersPending can be resumed */
    speakerCheckEnabled: boolean;
    chaptersEligible: number;
    chaptersScored: number;
    /** Eligible chapters that scoreBook attempted (see the attempted
     *  sentinel in render-integrity/verdicts-io.ts) but never produced a
     *  verdict file for — an embedding failure. Correctly nonzero for BOTH
     *  an isolated failure (some chapters scored, this one didn't) AND a
     *  fleet-wide failure (the gate ran and attempted every eligible
     *  chapter, but embeddings failed for literally all of them, so
     *  chaptersScored is also 0). Stays 0 only when the gate was never
     *  attempted on any eligible chapter at all ("gate off") — see the
     *  computation below. */
    chaptersEmbedFailed: number;
    charactersOnRoster: number;
    charactersChecked: number;
    /** srv-36 hardening — stochastic characters that have appeared on a
     *  chapter's embeddings roster but have no row yet in
     *  render-integrity.centroids.json, OR whose row is a stale no-current-voice
     *  marker (#3680: a score-only pass clears it) — still mid-retry-cycle, not
     *  stuck. A chapter whose only unscored roster character is in this list is
     *  excluded from chaptersEmbedFailed (see the computation below). */
    charactersPending: string[];
    /** #3680/#3524 — CAST ids (resolved through the cast of record; a merged character
     *  is listed once, under the id the cast shows) with a persisted
     *  `noCurrentVoiceReference` marker on one of their render keys AND no rendered line
     *  in that key's current cast voice, re-checked HERE at read time against the cast
     *  of record rather than trusted from the last pass. Every line under that key is
     *  inconclusive until a chapter holding it is re-rendered. A marker the current cast
     *  no longer supports is in `charactersPending` instead. The marker is per KEY: a
     *  merged character's other keys can be healthy, so see the chapters field below. */
    charactersNeedingRerender: string[];
    /** #3680 — per id in `charactersNeedingRerender`: the chapter ids holding lines under
     *  the marked key(s), ascending. A re-render keys its fresh lines under the canonical
     *  id, so each re-rendered chapter drops off this list. */
    charactersNeedingRerenderChapters: Record<string, number[]>;
    mismatches: Array<{ characterId: string; chapterId?: number; fixable: boolean }>;
    inconclusiveCount: number;
    uncheckedCharacterIds: string[];
  };
}

export async function buildAudioQaReport(
  bookDir: string,
  chapters: { id: number; slug: string }[],
): Promise<AudioQaReport> {
  const segFiles = await loadSegmentsFiles(bookDir, chapters);

  let totalLines = 0;
  let linesChecked = 0;
  let linesRerecorded = 0;
  let linesVerified = 0;
  let linesFlaggedDrift = 0;
  const chaptersFlaggedSet = new Set<number>();
  const eligibleChapterIds = new Set<number>();
  const stochasticCharacterIds = new Set<string>();

  // Book-wide, first-chapter-wins engine classification — the SAME
  // implementation scoreBook uses, so a character's eligibility here can
  // never disagree with which characters/chapters scoreBook actually scores.
  const configuredEngineByChar = resolveConfiguredEngineByChar(segFiles);

  /* #3362 pass-4 fix (🟠D) — `configuredEngineByChar` is keyed by whatever
     snapshot key each chapter's own `characterSnapshots` used (canonical AT
     THAT RENDER, since finalize-chapter-write #3370 — but never rewritten by
     a LATER retirement/merge), while `embeddings.json` rows below carry the
     RAW segment characterId their synth request was made under. Resolve
     each row's raw id through the SAME per-segment stamp aggregate.ts's
     scoreBook now joins on (`resolveRowCharId`/`segKey`, reading
     `resolvedCharacterId` off the matching `segments.json` entry) before
     joining it against `configuredEngineByChar` — never through a resolver
     rebuilt from the CURRENT cast + cast-id-history, which can disagree with
     scoreBook's own join the moment that history changes after the chapter
     rendered (see aggregate.ts's `resolveRowCharId` doc comment for the bug
     class — pass-4 S4–S8 — this closes). A chapter's own `seg.segments`
     supplies the segKey → stamp lookup directly; no cast-id-history read is
     needed here at all any more. */
  const stampByKeyByChapter = new Map<number, Map<string, string>>(
    segFiles.map((seg) => {
      const byKey = new Map<string, string>();
      for (const s of seg.segments ?? []) {
        if (s.characterId && Array.isArray(s.sentenceIds) && s.resolvedCharacterId) {
          byKey.set(segKey(s.characterId, s.sentenceIds), s.resolvedCharacterId);
        }
      }
      return [seg.chapterId, byKey];
    }),
  );

  // srv-36 hardening — per-chapter roster sourced from embeddings.json
  // (which character actually has embeddable rows in THIS chapter), not
  // from segments.json's characterSnapshots presence — a character can
  // appear in a chapter's snapshot (they speak there) yet have every one of
  // their lines fall under the duration floor, producing zero embedding
  // rows for them in that chapter even though they resolve fine elsewhere
  // in the book. Sourcing the roster from embeddings keeps such a character
  // from blocking that chapter's "fully scored" check below.
  const rosterByChapter = new Map<number, Set<string>>();
  const voiceChapters: CurrentVoiceChapter[] = [];
  for (const ch of chapters) {
    const embPath = livePartPath(audioDir(bookDir), ch.slug, 'embeddings');
    const embResult = await readEmbeddings(embPath);
    if (!embResult) continue;
    const stampByKey = stampByKeyByChapter.get(ch.id);
    const ownSnapshots = segFiles.find((s) => s.chapterId === ch.id)?.characterSnapshots ?? {};
    const chapterChars = new Set<string>();
    for (const row of embResult.rows) {
      const stamp = stampByKey?.get(segKey(row.characterId, row.sentenceIds));
      const rowCharId = resolveRowCharId({ resolvedCharacterId: stamp }, row.characterId, ownSnapshots);
      const engine = rowCharId === undefined ? undefined : configuredEngineByChar.get(rowCharId);
      if (rowCharId !== undefined && engine && STOCHASTIC_ENGINES.has(engine)) chapterChars.add(rowCharId);
    }
    if (chapterChars.size > 0) rosterByChapter.set(ch.id, chapterChars);

    /* #3680 — the same per-chapter view scoreBook's phase 1 builds (a chapter with
       BOTH an embeddings sibling and a segments file), for the stale-marker check. */
    const segFile = segFiles.find((s) => s.chapterId === ch.id);
    if (segFile) {
      const segsByKey = new Map<string, NonNullable<typeof segFile.segments>[number]>();
      for (const seg of segFile.segments ?? []) {
        if (seg.characterId && Array.isArray(seg.sentenceIds)) segsByKey.set(segKey(seg.characterId, seg.sentenceIds), seg);
      }
      voiceChapters.push({ slug: ch.slug, embRows: embResult.rows, segsByKey, snapshots: ownSnapshots });
    }
  }

  for (const seg of segFiles) {
    let chapterHasSuspect = false;
    for (const s of seg.segments ?? []) {
      const lineCount = Array.isArray(s.sentenceIds) ? s.sentenceIds.length : 0;
      totalLines += lineCount;
      const anySeg = s as unknown as {
        qa?: unknown; suspect?: boolean; qaRetries?: number;
        asr?: unknown; asrSuspect?: boolean;
      };
      if (anySeg.qa != null) linesChecked += lineCount;
      if ((anySeg.qaRetries ?? 0) > 0) linesRerecorded += lineCount;
      if (anySeg.suspect) chapterHasSuspect = true;
      if (anySeg.asr != null) linesVerified += lineCount;
      if (anySeg.asrSuspect) linesFlaggedDrift += lineCount;
    }
    if (chapterHasSuspect) chaptersFlaggedSet.add(seg.chapterId);

    // A chapter is eligible for a character iff that character APPEARS in
    // this chapter's own snapshot AND is classified stochastic book-wide —
    // NOT iff this chapter's own snapshot happens to say a stochastic engine
    // (that per-chapter value can disagree with the book-wide classification
    // on a mid-book engine switch; the book-wide one wins, matching scoreBook).
    for (const charId of Object.keys(seg.characterSnapshots ?? {})) {
      const engine = configuredEngineByChar.get(charId);
      if (engine && STOCHASTIC_ENGINES.has(engine)) {
        stochasticCharacterIds.add(charId);
        eligibleChapterIds.add(seg.chapterId);
      }
    }
  }

  const outline = await deriveBookOutline(bookDir, chapters);
  const attribution: 'full' | 'legacy-unattributed' = outline.issues.some((r) => r.chapterId == null)
    ? 'legacy-unattributed'
    : 'full';
  const uncheckedSet = new Set(outline.counts.uncheckedCharacters);

  const centroids = (await readCentroids(bookDir)) ?? {};
  const markedIds = Array.from(stochasticCharacterIds).filter((id) => centroids[id]?.noCurrentVoiceReference === true);
  /* #3680 pass 1 — the persisted marker was decided from the cast voice at the last scoring
     pass. Re-check it against the CURRENT cast voice, with the same helpers scoreBook uses:
     a marker is only true while the character has a current voice AND no rendered line in it.
     A stale one (the voice was reverted, or the cast row is gone) is PENDING — a score-only
     pass (Resume) clears it — never a re-render. */
  const staleMarkerIds = new Set<string>();
  /* #3680 pass 1 — the ids above are frozen-render snapshot keys (a merged character keeps
     the key it rendered under). Resolve each through the cast of record, as scoreBook does
     (CLAUDE.md: cast.json is the identity of record), and de-duplicate, so the listing names
     the character the cast shows, once. */
  const charactersNeedingRerender: string[] = [];
  const charactersNeedingRerenderChapters: Record<string, number[]> = {};
  const idBySlug = new Map(chapters.map((c) => [c.slug, c.id]));
  if (markedIds.length > 0) {
    const { castResolver, bookLanguage } = await loadCastContext(bookDir);
    const { currentVoiceFor } = createCurrentVoiceFacts({
      chapterData: voiceChapters,
      configuredEngineByChar,
      castResolver,
      bookLanguage,
      // Resume passes none (no run model key), so this is the pass the report predicts.
      justFinalized: new Set<string>(),
    });
    const withCurrentLine = charsWithCurrentVoiceLine(voiceChapters, stochasticCharacterIds, currentVoiceFor);
    for (const id of markedIds) {
      if (currentVoiceFor(id) === undefined || withCurrentLine.has(id)) {
        staleMarkerIds.add(id);
        continue;
      }
      // A marker needs a current voice, which needs a live cast row, so this resolves.
      const canonicalId = castResolver.resolve(id)?.character.id ?? id;
      if (!charactersNeedingRerender.includes(canonicalId)) charactersNeedingRerender.push(canonicalId);
      /* The chapters whose lines sit under THIS marked key: re-rendering one keys its fresh
         lines under the canonical id, so it leaves this list. Another key of the same person may be
         healthy, so the listing must not claim "no lines" for the person. */
      const held = (charactersNeedingRerenderChapters[canonicalId] ??= []);
      for (const cd of voiceChapters) {
        const chapterId = idBySlug.get(cd.slug);
        if (chapterId === undefined || held.includes(chapterId)) continue;
        const has = cd.embRows.some((row) =>
          resolveRowCharId(cd.segsByKey.get(segKey(row.characterId, row.sentenceIds)), row.characterId, cd.snapshots) === id);
        if (has) held.push(chapterId);
      }
    }
    // One person can have several marked keys, each pushing its own chapters in turn.
    for (const held of Object.values(charactersNeedingRerenderChapters)) held.sort((a, b) => a - b);
  }
  const charactersPending = Array.from(stochasticCharacterIds).filter(
    (id) => !(id in centroids) || staleMarkerIds.has(id),
  );

  /* srv-36 hardening — chaptersScored/chaptersEmbedFailed are now
     roster-aware: a chapter is "fully scored" iff EVERY character on its
     embeddings-sourced roster (rosterByChapter, above) has a verdict row
     for that chapter (outline.verdictCharactersByChapter), not merely iff
     a verdict file exists for the chapter at all (the old file-presence
     test). This also replaces the fs-51 `attemptedEligibleCount -
     chaptersScored` subtraction: with per-character incremental verdict
     writes (Task 2/3), a chapter can be partially scored (some roster
     characters resolved, others still mid-retry-cycle) without being fully
     scored OR fully embed-failed. A chapter whose only unscored roster
     character is still charactersPending (no centroids row yet — still
     working) is excluded from chaptersEmbedFailed; only a chapter that was
     attempted and has an unscored roster character NOT in charactersPending
     (i.e. genuinely stuck) counts. */
  /* review pass 2 🟡 finding 1 (still possible after the pass-4 fix's
     per-segment stamp join) — a chapter can land on rosterByChapter (it has
     embeddings rows that resolve onto a stochastic character) without being
     eligibleChapterIds-eligible (its OWN characterSnapshots never named that
     character). The stamp is scoped to THIS chapter's own segment (see
     aggregate.ts's `resolveRowCharId`), so a row can no longer resolve onto
     a DIFFERENT chapter's key at all — that holds only because
     finalize-chapter-write.ts's own write invariant guarantees a stamp
     always names a key present in THAT SAME write's `characterSnapshots`
     (pass-5, 🟠E: a re-finalize that can't carry a stamp's snapshot entry
     forward clears the stamp rather than leaving it dangling — see
     finalize-chapter-write.ts's stamping block) — but a pre-#3362/pass-4 chapter with
     no snapshot entry at all still passes its raw embeddings-row id through
     UNRESOLVED, and that raw id can still coincide, by plain string
     equality, with a canonical key a LATER chapter's own snapshot
     introduced. Left unguarded, such a chapter could count as "scored"
     while never counting as "eligible", producing the nonsensical "2 of 1
     eligible chapters scored". chaptersEligible can't become the
     roster-derived set instead — it must stay gate-independent (a chapter
     with a stochastic character but the gate never run is still eligible,
     just unscored) — so scored is clamped to eligibleChapterIds instead,
     keeping chaptersScored <= chaptersEligible structurally true. */
  const chaptersScored = Array.from(rosterByChapter.entries())
    .filter(([chapterId, roster]) => {
      if (!eligibleChapterIds.has(chapterId)) return false;
      const verdictChars = outline.verdictCharactersByChapter.get(chapterId);
      if (!verdictChars) return false;
      return Array.from(roster).every((id) => verdictChars.has(id));
    })
    .map(([chapterId]) => chapterId).length;

  const attemptedEligibleCount = outline.attemptedChapterIds.filter((id) => eligibleChapterIds.has(id)).length;
  const chaptersEmbedFailed = attemptedEligibleCount > 0
    ? Array.from(eligibleChapterIds).filter((chapterId) => {
        const roster = rosterByChapter.get(chapterId);
        const verdictChars = outline.verdictCharactersByChapter.get(chapterId);
        const fullyScored = !!roster && !!verdictChars && Array.from(roster).every((id) => verdictChars.has(id));
        if (fullyScored) return false;
        const hasPendingRosterChar = roster && Array.from(roster).some((id) => charactersPending.includes(id));
        return !hasPendingRosterChar && outline.attemptedChapterIds.includes(chapterId);
      }).length
    : 0;

  return {
    chaptersRendered: segFiles.length,
    totalLines,
    acoustic: {
      linesChecked,
      linesRerecorded,
      chaptersFlagged: chaptersFlaggedSet.size,
    },
    asr: {
      linesVerified,
      linesFlaggedDrift,
    },
    voiceDrift: {
      attribution,
      speakerCheckEnabled: configValue<boolean>('qa.speaker.enabled') === true,
      chaptersEligible: eligibleChapterIds.size,
      chaptersScored,
      chaptersEmbedFailed,
      charactersOnRoster: stochasticCharacterIds.size,
      charactersChecked: Array.from(stochasticCharacterIds).filter((id) => !uncheckedSet.has(id)).length,
      charactersPending,
      charactersNeedingRerender,
      charactersNeedingRerenderChapters,
      mismatches: outline.issues.map((r) => ({
        characterId: r.characterId,
        chapterId: r.chapterId,
        fixable: r.fixable,
      })),
      inconclusiveCount: outline.inconclusiveChapterIds.length,
      uncheckedCharacterIds: outline.counts.uncheckedCharacters,
    },
  };
}
