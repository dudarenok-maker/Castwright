/* Manuscript slice — uploaded manuscript meta + sentences from the analysis
   response. Sentences live here (not in chapters) because they're a separate
   object the backend returns alongside chapters. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { initialSentences } from '../data/sentences';
import type {
  Sentence,
  UploadResponse,
  AnalyseResponse,
  ImportCandidate,
  BookStateJson,
} from '../lib/types';

export interface ManuscriptState {
  /** Which book the rest of this slice currently reflects. Set whenever a
      hydrate reducer lands (analysis complete or disk hydrate); cleared by
      reset. Layout uses this to detect stale state across cross-book
      navigation — e.g. analysing Book A then clicking the generation pill
      to open Book B's Generate view: without bookId tracking the slice
      title selector falls through to Book A's stale title because the
      manuscriptId+title guard short-circuited the per-book disk hydrate. */
  bookId: string | null;
  manuscriptId: string | null;
  title: string | null;
  format: UploadResponse['format'] | null;
  wordCount: number;
  sourceText: string | null;
  sentences: Sentence[];
  /** Parsed-but-not-yet-confirmed import (sits between Import and Confirm screens). */
  importCandidate: ImportCandidate | null;
  /** Plan 74 — set when the user re-uploads a manuscript for an
      already-imported book. Holds the OLD slice snapshot alongside
      the NEW candidate sentences so the diff modal can render
      side-by-side without committing anything until the user picks
      Apply or Discard. The current top-level slice fields (sourceText,
      sentences, etc.) remain untouched while this is non-null — that's
      the "preview before apply" invariant. */
  pendingReupload: PendingReupload | null;
  /** fs-58 — tombstone of merged-away (chapterId:sentenceId) keys.
      Prevents a re-analysis from resurrecting sentence ids that were
      deliberately merged away by the user. Format: `"${chapterId}:${id}"`. */
  mergedAwayKeys: string[];
}

export interface PendingReupload {
  bookId: string;
  /** Snapshot of the current top-level slice fields the diff "old" side
      reads from. We snapshot rather than re-derive because the slice
      gets stamped by the Apply path; Discard restores from this snapshot. */
  oldSnapshot: {
    sourceText: string | null;
    sentences: Sentence[];
    wordCount: number;
    title: string | null;
    format: UploadResponse['format'] | null;
  };
  /** The new manuscript text the user just uploaded, ready to commit
      on Apply. Carries the same shape as `UploadResponse` minus the
      bookId/manuscriptId (the existing book keeps its ids). */
  newCandidate: {
    sourceText: string;
    /** Pre-split sentences from the analyzer-bound source text. We hand
        the client splitter (splitIntoSentences) the new sourceText and
        store the result here so the modal doesn't re-split on every
        render. */
    sentences: Sentence[];
    wordCount: number;
    title: string;
    format: UploadResponse['format'];
  };
}

const initialState: ManuscriptState = {
  bookId: null,
  manuscriptId: null,
  title: null,
  format: null,
  wordCount: 0,
  sourceText: null,
  sentences: initialSentences,
  importCandidate: null,
  pendingReupload: null,
  mergedAwayKeys: [],
};

export const manuscriptSlice = createSlice({
  name: 'manuscript',
  initialState,
  reducers: {
    uploadComplete: (s, a: PayloadAction<UploadResponse>) => {
      const { manuscriptId, title, format, wordCount, sourceText } = a.payload;
      s.manuscriptId = manuscriptId;
      s.title = title;
      s.format = format;
      s.wordCount = wordCount;
      s.sourceText = sourceText;
      s.importCandidate = null;
    },
    setImportCandidate: (s, a: PayloadAction<ImportCandidate | null>) => {
      s.importCandidate = a.payload;
    },
    /* Merge incoming analysis sentences with the current slice contents.
       On first hydrate (manuscriptId still null, state holds the demo
       fixture) replace wholesale. On re-analysis (manuscriptId already set,
       state holds the user's edited sentences from disk hydration or live
       edits) preserve every sentence whose (chapterId, id) matches an
       incoming one — this carries forward setSentenceCharacter /
       setSentencesCharacter reassignments. Sentences in state but NOT in
       incoming (typical for splitSentence offsprings, whose ids are
       assigned above the analyzer's max) are kept in narrative position.
       Sentences in incoming but NOT in state are appended. Without the
       merge a confirm → reanalyse cycle would silently stomp the user's
       manuscript edits.

       Keying by (chapterId, id) rather than id alone is load-bearing:
       sentence ids restart at 1 in every chapter, so a single-id key
       collapsed all sentences with id=N from earlier chapters onto the
       LAST chapter that owned that id — chapter 1's content vanished
       and the final chapter accumulated copies of every prior chapter
       starting at sentence 1. */
    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      /* Stamp the slice's bookId from the analysis payload BEFORE the
         no-sentences early return so the analysing-route hand-off (which
         lands the full AnalyseResponse) anchors this slice to its book
         even if the response trivially has no sentences. */
      if (a.payload.bookId) s.bookId = a.payload.bookId;
      const incoming = a.payload.sentences as unknown as Sentence[] | undefined;
      if (!incoming?.length) return;
      if (s.manuscriptId === null) {
        s.sentences = incoming;
        return;
      }

      const key = (x: Sentence) => `${x.chapterId}:${x.id}`;
      const incomingByKey = new Map<string, Sentence>(incoming.map((x) => [key(x), x]));
      const stateKeys = new Set<string>(s.sentences.map(key));
      const merged: Sentence[] = [];
      for (const x of s.sentences) {
        const inc = incomingByKey.get(key(x));
        if (inc) {
          /* Sentence still exists in the new analysis. Refresh fields from
             incoming but preserve characterId (the user's reassignment) and
             text (in case the sentence was split — splitSentence rewrites
             text in place and the analyzer wouldn't know about it). */
          merged.push({ ...inc, characterId: x.characterId, text: x.text, excludeFromSynthesis: x.excludeFromSynthesis });
        } else {
          /* Either a split offspring (id assigned above analyzer max) or a
             sentence the new analysis dropped. Keep it — the GET-side merge
             on a reload would filter true orphans against the fresh cache. */
          merged.push(x);
        }
      }
      const tomb = new Set(s.mergedAwayKeys);
      for (const inc of incoming) {
        if (!stateKeys.has(key(inc)) && !tomb.has(key(inc))) merged.push(inc);
      }
      s.sentences = merged;
    },

    /* Rehydrate from a disk-resident book state + manuscript-edits.json.
       Used when opening a previously-analysed book. */
    hydrateFromBookState: (
      s,
      a: PayloadAction<{
        state: BookStateJson;
        sentences: Sentence[] | null;
        wordCount?: number | null;
        format?: UploadResponse['format'] | null;
        /** fs-58 — tombstone of merged-away sentence keys for this book.
            The `?? []` also book-scopes the tombstone: loading Book B with
            no keys clears Book A's tombstone from the prior load. */
        mergedAwayKeys?: string[];
      }>,
    ) => {
      const { state, sentences, wordCount, format } = a.payload;
      s.bookId = state.bookId;
      s.manuscriptId = state.manuscriptId;
      s.title = state.title;
      s.importCandidate = null;
      if (typeof wordCount === 'number' && wordCount > 0) s.wordCount = wordCount;
      if (format) s.format = format;
      if (sentences?.length) s.sentences = sentences;
      s.mergedAwayKeys = a.payload.mergedAwayKeys ?? [];
    },
    reset: (s) => {
      s.bookId = null;
      s.manuscriptId = null;
      s.title = null;
      s.format = null;
      s.wordCount = 0;
      s.sourceText = null;
      s.sentences = initialSentences;
      s.importCandidate = null;
      s.pendingReupload = null;
      s.mergedAwayKeys = [];
    },

    /* Plan 74 — capture the user's re-uploaded manuscript without
       mutating the live top-level fields. The diff modal reads
       `pendingReupload.oldSnapshot` (the current slice) against
       `pendingReupload.newCandidate` (the just-imported text) and
       prompts the user to Apply or Discard. Snapshotting up-front
       keeps Discard cheap (restore from snapshot, no API round-trip)
       and means we don't have to keep the live state in sync with
       a held reference. */
    previewReuploadDiff: (
      s,
      a: PayloadAction<{
        bookId: string;
        newSourceText: string;
        newSentences: Sentence[];
        newWordCount: number;
        newTitle?: string | null;
        newFormat?: UploadResponse['format'] | null;
      }>,
    ) => {
      const { bookId, newSourceText, newSentences, newWordCount, newTitle, newFormat } =
        a.payload;
      s.pendingReupload = {
        bookId,
        oldSnapshot: {
          sourceText: s.sourceText,
          sentences: s.sentences,
          wordCount: s.wordCount,
          title: s.title,
          format: s.format,
        },
        newCandidate: {
          sourceText: newSourceText,
          sentences: newSentences,
          wordCount: newWordCount,
          title: newTitle ?? s.title ?? 'Untitled',
          format: newFormat ?? s.format ?? 'markdown',
        },
      };
    },

    /* Plan 74 — commit the pending re-upload into the slice's live
       fields, then clear the pending slot. Mirrors `uploadComplete`'s
       field set so downstream consumers (manuscript view, generation
       view) react identically whether the manuscript landed via a
       fresh upload or via the re-upload diff Apply path. */
    applyReupload: (s) => {
      if (!s.pendingReupload) return;
      const { newCandidate } = s.pendingReupload;
      s.sourceText = newCandidate.sourceText;
      s.sentences = newCandidate.sentences;
      s.wordCount = newCandidate.wordCount;
      s.title = newCandidate.title;
      s.format = newCandidate.format;
      s.pendingReupload = null;
      s.mergedAwayKeys = [];
    },

    /* Plan 74 — drop the pending re-upload without touching anything
       else. The slice's live fields were never mutated (that was the
       point of the snapshot), so this is just a clear. */
    discardReupload: (s) => {
      s.pendingReupload = null;
    },

    /* User edit: reassign a single sentence to a different character.
       Scopes by (chapterId, sentenceId) — sentence ids restart at 1 in
       every chapter, so a single-id match would silently mutate the wrong
       chapter's same-id sentence. Mirrors the hydrate-merge keying above. */
    setSentenceCharacter: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; characterId: string }>,
    ) => {
      const sent = s.sentences.find(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (sent) sent.characterId = a.payload.characterId;
    },

    /* fs-58 Unit B — User/review edit: mark a sentence excluded from synthesis
       (flag_nonstory) or re-include it. Scoped by (chapterId, sentenceId) like
       setSentenceText. No-op if the sentence is not found. */
    setSentenceExcluded: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; excluded: boolean }>,
    ) => {
      const sent = s.sentences.find(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (sent) sent.excludeFromSynthesis = a.payload.excluded;
    },

    /* fs-58 — User edit: replace a sentence's text (strip_tag + validate_instruct
       vocalization targets). Scoped by (chapterId, sentenceId). The optional
       `vocalization` is TRI-STATE: undefined ⇒ leave the flag untouched (so an
       unrelated strip_tag text edit can't wipe a vocalization:true sentence —
       locked by a regression test); true ⇒ set; false ⇒ delete (never store false). */
    setSentenceText: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; text: string; vocalization?: boolean }>,
    ) => {
      const sent = s.sentences.find(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (!sent) return;
      sent.text = a.payload.text;
      if (a.payload.vocalization === undefined) return; // leave the flag untouched
      if (a.payload.vocalization) sent.vocalization = true;
      else delete sent.vocalization;
    },

    /* fs-25 — User edit: set (or clear) a quote's delivery emotion. Scoped by
       (chapterId, sentenceId) like setSentenceCharacter. `'neutral'` clears the
       field back to undefined (the default render on every engine) so the store
       never carries a redundant neutral. A hand-set emotion always wins over
       analyzer/seed emotion (this is the manual-override write site). */
    setSentenceEmotion: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; emotion: string }>,
    ) => {
      const sent = s.sentences.find(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (!sent) return;
      if (a.payload.emotion === 'neutral') delete sent.emotion;
      else sent.emotion = a.payload.emotion as typeof sent.emotion;
    },

    /* fs-56 — User edit: set (or clear) a sentence's free-text delivery `instruct`.
       The MANUAL write site for the resolver's top "manual" rung. Scoped by
       (chapterId, sentenceId) like setSentenceEmotion. A blank/whitespace value
       deletes the field (so the store never carries an empty instruct, and a
       re-detect may refill it). A hand-set instruct wins over analyzer instruct
       because applyDetectedInstruct is fill-only. */
    setSentenceInstruct: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; instruct: string }>,
    ) => {
      const sent = s.sentences.find(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (!sent) return;
      const trimmed = a.payload.instruct.trim();
      if (trimmed === '') delete sent.instruct;
      else sent.instruct = trimmed;
    },

    /* fs-33 — bulk-apply the emotion-only backfill pass for one chapter.
       Fill-ONLY-empty: a detected emotion is written only where the sentence
       currently has no (non-neutral) emotion, so a hand-set tag ALWAYS wins and
       a re-run just fills the remaining neutrals. A `neutral` annotation is a
       no-op (the pass omits these, but guard anyway). Persisted to
       manuscript-edits.json via the persistence middleware, the same path synth
       reads — so detected emotion reaches generation exactly like a manual tag. */
    applyDetectedEmotions: (
      s,
      a: PayloadAction<{
        chapterId: number;
        annotations: Array<{ sentenceId: number; emotion: string }>;
      }>,
    ) => {
      const byId = new Map<number, string>();
      for (const ann of a.payload.annotations) {
        if (ann.emotion && ann.emotion !== 'neutral') byId.set(ann.sentenceId, ann.emotion);
      }
      if (byId.size === 0) return;
      for (const sent of s.sentences) {
        if (sent.chapterId !== a.payload.chapterId) continue;
        if (sent.emotion) continue; // manual / prior-detected wins — fill only empty
        const detected = byId.get(sent.id);
        if (detected) sent.emotion = detected as Sentence['emotion'];
      }
    },

    /* fs-57 — bulk-apply Stage-3 vocalization annotations for one chapter.
       Three-rule contract:
       1. Staleness (TOCTOU): if no sentence with the given id exists, DROP
          the annotation — a merge/split may have removed it after Stage 3 ran.
       2. Idempotency: if the sentence is ALREADY vocalization:true, SKIP IT
          entirely (text AND instruct). A text edit is NOT idempotent, so
          the skip-if-flagged guard is what makes re-running safe.
       3. Apply (fresh sentence):
          - text: set via the same single mutation setSentenceText performs
            (changing sent.text is sufficient to mark it for re-synth — audio
            is keyed on sentence text downstream; no separate dirty flag exists).
          - instruct: fill-only — written only when the sentence has no
            hand-set instruct (manual instruct always wins, mirroring how
            applyDetectedEmotions never overwrites a hand-set emotion).
          - vocalization: fill-only — only written when currently falsy. */
    applyDetectedInstruct: (
      s,
      a: PayloadAction<{
        chapterId: number;
        annotations: Array<{ sentenceId: number; text?: string; instruct?: string; vocalization?: boolean }>;
      }>,
    ) => {
      for (const ann of a.payload.annotations) {
        const sent = s.sentences.find(
          (x) => x.chapterId === a.payload.chapterId && x.id === ann.sentenceId,
        );
        if (!sent) continue; // TOCTOU — sentence was merged/split away
        if (sent.vocalization) continue; // idempotency — already a vocalization, skip
        if (ann.text !== undefined) sent.text = ann.text; // mark dirty for re-synth (text is the key)
        if (!sent.instruct && ann.instruct !== undefined) sent.instruct = ann.instruct; // fill-only
        if (!sent.vocalization && ann.vocalization) sent.vocalization = ann.vocalization; // fill-only
      }
    },

    /* User edit: reassign a batch of sentences at once. Used by the
       boundary-drag handle and the segment inspector. Scoped to one
       chapter — the caller batches ids from a single chapter's segments. */
    setSentencesCharacter: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceIds: number[]; characterId: string }>,
    ) => {
      const ids = new Set(a.payload.sentenceIds);
      for (const sent of s.sentences) {
        if (sent.chapterId === a.payload.chapterId && ids.has(sent.id)) {
          sent.characterId = a.payload.characterId;
        }
      }
    },

    /* User edit: split a sentence's text at the given offsets, producing
       N + 1 pieces, each assigned to its own characterId. Offsets are
       0-based character positions within the original sentence text.
       characterIds.length must equal offsets.length + 1. The first piece
       keeps the original sentence's id; subsequent pieces get new ids
       (max + 1, +2, …) inserted right after it. Empty pieces are skipped.
       Scoped to one chapter — sentence ids restart per chapter. */
    splitSentence: (
      s,
      a: PayloadAction<{
        chapterId: number;
        sentenceId: number;
        offsets: number[];
        characterIds: string[];
      }>,
    ) => {
      const idx = s.sentences.findIndex(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (idx < 0) return;
      const original = s.sentences[idx];
      const text = original.text;
      const sorted = [...a.payload.offsets].sort((x, y) => x - y);
      const bounds = [0, ...sorted, text.length];
      const maxId = s.sentences.reduce((m, x) => Math.max(m, x.id), 0);
      const pieces: typeof s.sentences = [];
      let newIdCounter = maxId;
      for (let i = 0; i < bounds.length - 1; i++) {
        const piece = text.slice(bounds[i], bounds[i + 1]);
        if (!piece) continue;
        const isFirst = pieces.length === 0;
        pieces.push({
          ...original,
          id: isFirst ? original.id : ++newIdCounter,
          text: piece,
          characterId: a.payload.characterIds[i] ?? original.characterId,
          /* fs-57 follow-up (#1100): per-sentence delivery hints describe the
             ORIGINAL text. The first piece is the original sentence's head (it
             keeps the id + the hints); every later fragment is NEW text, so
             null both — a stale `vocalization:true` would turn real narration
             into a sound-effect token, and an `instruct` written for the whole
             sentence may not fit a fragment. */
          ...(isFirst ? {} : { instruct: undefined, vocalization: undefined }),
        });
      }
      if (pieces.length === 0) return;
      s.sentences.splice(idx, 1, ...pieces);
    },

    /* Apply a chapter restructure remap (plan 51). Rewrites each
       sentence's (chapterId, id) pair according to the table the
       server returned from POST /chapters/{merge,split,reorder}.
       Sentences whose (chapterId, id) doesn't appear in the table
       are dropped — content-changed merge / split chapters return no
       remap entries for the dropped halves, and any other sentence
       missing a remap entry is structurally orphan. The reducer is
       pure (no I/O); the route's response already reflects the new
       on-disk reality, so the slice just mirrors it.

       Re-sorted into (chapterId, id) order so the manuscript view
       renders in narrative sequence — the remap entries may arrive
       in any order. */
    applyChapterRestructure: (
      s,
      a: PayloadAction<{
        sentenceRemap: Array<{
          oldChapterId: number;
          oldSentenceId: number;
          newChapterId: number;
          newSentenceId: number;
        }>;
      }>,
    ) => {
      const key = (chapterId: number, id: number) => `${chapterId}:${id}`;
      const remapByOld = new Map(
        a.payload.sentenceRemap.map((r) => [key(r.oldChapterId, r.oldSentenceId), r]),
      );
      const next: Sentence[] = [];
      for (const sent of s.sentences) {
        const mapped = remapByOld.get(key(sent.chapterId, sent.id));
        if (!mapped) continue; // orphan — dropped
        next.push({ ...sent, chapterId: mapped.newChapterId, id: mapped.newSentenceId });
      }
      next.sort((x, y) => x.chapterId - y.chapterId || x.id - y.id);
      s.sentences = next;
    },

    /* fs-58 — User edit: merge adjacent sentences into the lowest id.
       sentenceIds are sorted ascending; the lowest becomes the survivor
       (its text = all members joined by a space). Dropped ids are recorded
       in mergedAwayKeys so a subsequent re-analysis cannot resurrect them.
       No-op if any named id is missing or only one id is given. */
    mergeSentences: (s, a: PayloadAction<{ chapterId: number; sentenceIds: number[] }>) => {
      const ids = [...a.payload.sentenceIds].sort((x, y) => x - y);
      if (ids.length < 2) return;
      const members = ids.map((id) => s.sentences.find((x) => x.chapterId === a.payload.chapterId && x.id === id));
      if (members.some((m) => !m)) return;
      const live = members as NonNullable<(typeof members)[number]>[];
      live[0].text = live.map((m) => m.text).join(' ');
      /* fs-57 follow-up (#1100): the survivor's joined text is NEW — drop its
         instruct/vocalization (a `vocalization:true` flag on a now-much-longer
         merged sentence is wrong; an `instruct` written for the old short text
         may no longer fit). The merged-away members' fields were already
         discarded with their rows. */
      live[0].instruct = undefined;
      live[0].vocalization = undefined;
      for (const m of live.slice(1)) {
        const i = s.sentences.findIndex((x) => x.chapterId === a.payload.chapterId && x.id === m.id);
        if (i >= 0) s.sentences.splice(i, 1);
        s.mergedAwayKeys.push(`${a.payload.chapterId}:${m.id}`);
      }
    },
  },
});

export const manuscriptActions = manuscriptSlice.actions;
