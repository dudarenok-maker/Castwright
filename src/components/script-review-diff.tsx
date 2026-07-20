/* fs-58 — ScriptReviewDiff modal.
   Shows the LLM script-review suggestions bucketed by op class (strip_tag,
   fix_emotion, split, etc.), lets the user select/deselect individual ops or
   whole classes, then applies the selected set via planApply +
   dispatchAcceptedOps. Mirrors drift-report.tsx overlay pattern. */

import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from '@reduxjs/toolkit';
import { Checkbox } from './primitives';
import { useAppDispatch, useAppSelector } from '../store';
import {
  scriptReviewActions,
  selectActiveReview,
  selectReviewSummary,
  opKey,
  type ReviewOpWithChapter,
} from '../store/script-review-slice';
import { planApply, dispatchAcceptedOps } from '../lib/script-review-apply';
import { discardReview } from '../store/script-review-thunk';
import {
  applyProposedReattributions,
  consolidateProposedByName,
  type ProposedNameGroup,
} from '../lib/apply-proposed';
import { changeLogActions } from '../store/change-log-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { castActions } from '../store/cast-slice';
import { notificationsActions } from '../store/notifications-slice';
import { api } from '../lib/api';
import { CreateCharacterForm } from './create-character-form';
import { IconClose } from '../lib/icons';
import { engineForModelKey } from '../lib/tts-models';
import { sampleModelKeyForEngine } from '../lib/tts-voice-mapping';
import type { TtsModelKey } from '../lib/types';

/* Human-readable class labels. */
const CLASS_LABELS: Record<string, string> = {
  strip_tag: 'Strip tag',
  split: 'Split sentence',
  extract_dialogue: 'Extract dialogue',
  merge: 'Merge sentences',
  fix_emotion: 'Fix emotion',
  validate_instruct: 'Instruct',          // fs-58 validate_instruct
  reattribute: 'Reattribute speaker',     // fs-58 Unit B
  flag_nonstory: 'Exclude non-story',     // fs-58 Unit B
};

function classLabel(op: string): string {
  return CLASS_LABELS[op] ?? op;
}

/** fs-63 — push the off-roster "Design now" nudge, gated to a Qwen project.
    Exported (and pure-ish: side effect is the single dispatch) so it's unit
    testable without driving the confirm UI. No-op on preset engines or an
    empty batch. */
export function maybePushVoiceNudge(
  dispatch: Dispatch,
  args: { ttsModelKey: TtsModelKey; startBookId: string; createdCharacters: { id: string; name: string }[] },
): void {
  const { ttsModelKey, startBookId, createdCharacters } = args;
  if (createdCharacters.length === 0) return;
  if (engineForModelKey(ttsModelKey) !== 'qwen') return;
  dispatch(
    notificationsActions.pushToast({
      kind: 'info',
      message:
        createdCharacters.length > 1
          ? `${createdCharacters.length} new characters need voices`
          : `New character «${createdCharacters[0].name}» needs a voice`,
      dedupeKey: `off-roster-voice-nudge:${startBookId}`,
      nudge: {
        bookId: startBookId,
        characterIds: createdCharacters.map((c) => c.id),
        modelKey: sampleModelKeyForEngine('qwen', ttsModelKey),
        names: createdCharacters.map((c) => c.name),
      },
    }),
  );
}

/* Format the before → after preview for a single op row. `before` is the
   live sentence text (the original) when available, so strip_tag shows the
   tagged source struck-through next to the cleaned result. */
function OpPreview({
  op,
  before,
  liveInstruct,
  liveVocalization,
}: {
  op: ReviewOpWithChapter;
  before?: string;
  liveInstruct?: string;
  liveVocalization?: boolean;
}) {
  void liveVocalization;
  if (op.op === 'validate_instruct') {
    if (op.newInstruct !== undefined) {
      const after = op.newInstruct.trim() === '' ? '(stripped)' : op.newInstruct;
      return (
        <span className="text-xs text-ink/70 min-w-0 truncate">
          instruct: <span className="line-through text-ink/45">{liveInstruct ?? '(none)'}</span>
          {' → '}
          <span className="text-ink font-medium">{after}</span>
        </span>
      );
    }
    if (op.newVocalizationText !== undefined) {
      return (
        <span className="text-xs text-ink/70 min-w-0 truncate">
          {before !== undefined && before !== op.newVocalizationText && (
            <>
              <span className="line-through text-ink/45">{before}</span>
              {' → '}
            </>
          )}
          <span className="text-ink font-medium">{op.newVocalizationText}</span>
        </span>
      );
    }
    return null;
  }
  if (op.op === 'strip_tag' && op.newText !== undefined) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        {before !== undefined && before !== op.newText && (
          <>
            <span className="line-through text-ink/45">{before}</span>
            {' → '}
          </>
        )}
        <span className="text-ink font-medium">{op.newText}</span>
      </span>
    );
  }
  if (op.op === 'fix_emotion' && op.emotion) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        emotion → <span className="font-semibold text-ink">{op.emotion}</span>
      </span>
    );
  }
  if (op.op === 'merge' && op.mergeIds) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        merge sentences {op.mergeIds.join(', ')}
      </span>
    );
  }
  if ((op.op === 'split' || op.op === 'extract_dialogue') && op.anchor) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        split at: <span className="font-medium text-ink">{op.anchor}</span>
      </span>
    );
  }
  if (op.op === 'reattribute') {
    const target = op.characterId ?? (op.proposed ? `+ new: «${op.proposed.name}»` : '?');
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        reassign → <span className="font-semibold text-ink">{target}</span>
      </span>
    );
  }
  if (op.op === 'flag_nonstory') {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        exclude: {before !== undefined && <span className="line-through text-ink/45">{before}</span>}
      </span>
    );
  }
  return null;
}

/* fs-58 Unit B — one entry in the per-op confirm queue. We carry the ORIGINAL
   proposed op plus the operator's final decision so the helper sees either a
   (possibly edited) proposed name OR a rewrite to an existing roster member. */
type FinalizedProposed = ReviewOpWithChapter;

/* fs-58 persistence Task 13 — mirror a batch of already-applied ops into the
   server ledger (design spec §4.2's per-chapter /resolve) and, on success,
   remove exactly those ops from the local bucket via resolveOpsLocally. This
   is what replaced the old handleApply tail's whole-bucket `clearReview` —
   that call deleted every op in the bucket, including ones the user left
   unchecked, which is the silent-data-loss bug this plan exists to fix. A
   chapter missing from `versionByChapter` (no ledger entry to resolve
   against) is skipped rather than resolved — nothing local changes for it. */
async function resolveAppliedOps(
  dispatch: Dispatch,
  bookId: string,
  bucket: { versionByChapter: Record<number, number> },
  appliedOps: ReviewOpWithChapter[],
): Promise<void> {
  // Finding 5 (PR review round 5): push each op's key onto the chapter's
  // existing array in place instead of spreading a brand-new array per op —
  // the old `[...(byChapter.get(...) ?? []), key]` was O(n^2) in ops-per-
  // chapter (a fresh copy on every push).
  const byChapter = new Map<number, string[]>();
  for (const op of appliedOps) {
    const key = opKey(op.chapterId, op.id, op.op);
    const existing = byChapter.get(op.chapterId);
    if (existing) {
      existing.push(key);
    } else {
      byChapter.set(op.chapterId, [key]);
    }
  }
  // Finding 4 (PR review round 5): each chapter's /resolve call is
  // independent (own chapterId/version/opKeys) — run them concurrently
  // instead of sequentially awaiting one chapter at a time, so a whole-book
  // Apply spanning many chapters pays ~1 round-trip's worth of latency
  // instead of N.
  await Promise.all(
    [...byChapter].map(async ([chapterId, opKeys]) => {
      const version = bucket.versionByChapter[chapterId];
      if (version === undefined) return;
      try {
        const result = await api.resolveScriptReviewOps(bookId, { chapterId, version, appliedOpKeys: opKeys });
        if (result.ok) {
          dispatch(scriptReviewActions.resolveOpsLocally({ bookId, opKeys }));
        } else {
          // Stale version — another client/tab already resolved or replaced this
          // chapter's ledger entry since this bucket loaded. The manuscript
          // mutation already happened locally (dispatchAcceptedOps runs before
          // this call), so we can't safely mark it resolved server-side or
          // silently drop it from the bucket without risking a re-apply on a
          // second click — surface it instead of swallowing it.
          dispatch(
            notificationsActions.pushToast({
              kind: 'warn',
              message: `Chapter ${chapterId}'s script-review findings changed elsewhere — reload to see the latest state.`,
              dedupeKey: `script-review-stale-${bookId}-${chapterId}`,
            }),
          );
        }
      } catch (err) {
        // A thrown network/HTTP error must not abort the whole batch — every
        // other chapter in `appliedOps` still deserves its own resolve
        // attempt. The manuscript mutation for THIS chapter already applied
        // locally; it stays unresolved in the bucket/ledger until the user
        // retries (e.g. re-running or re-applying), same recovery path as the
        // stale-version case above.
        dispatch(
          notificationsActions.pushToast({
            kind: 'error',
            message: err instanceof Error ? err.message : `Failed to save chapter ${chapterId}'s script-review resolution.`,
            dedupeKey: `script-review-resolve-failed-${bookId}-${chapterId}`,
          }),
        );
      }
    }),
  );
}

export function ScriptReviewDiff({ bookId }: { bookId: string }) {
  const dispatch = useAppDispatch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = useAppSelector((s) => selectActiveReview(s as any, bookId));
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const cast = useAppSelector((s) => s.cast?.characters ?? []);
  // Live book id of the active `ready` stage — used by the book-switch guard.
  // Tracked through a ref so the async helper sees the CURRENT value, not the
  // one captured when handleApply was first invoked.
  const stageBookId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : undefined,
  );
  const stageBookIdRef = useRef(stageBookId);
  stageBookIdRef.current = stageBookId;
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);

  /* The create-once confirm queue. While `confirm` is non-null we overlay a
     CreateCharacterForm for `confirm.groups[confirm.index]` — ONE form per
     NEW unique proposed name (not per line). Direct ops are already applied
     by the time this is set; only the off-roster reattributes are pending. */
  const [confirm, setConfirm] = useState<{
    groups: ProposedNameGroup[];
    index: number;
    finalized: FinalizedProposed[];
    startBookId: string;
  } | null>(null);

  /* Accordion expand state — collapsed by default so a whole-book run opens as
     a scannable per-chapter summary, not a wall of cards. `expandedTypes` keys
     are `${chapterId}:${op}`. Both are view-only local UI state. */
  const [expandedChapters, setExpandedChapters] = useState<Set<number>>(new Set());
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const toggleChapterExpand = (chapterId: number) =>
    setExpandedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  const toggleTypeExpand = (chapterId: number, op: string) =>
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      const k = `${chapterId}:${op}`;
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /* fs-58 persistence Task 12 — "Dismiss all" is destructive (discards the
     persisted ledger via discardReview), so it requires this confirm step
     before firing. Close/backdrop stay non-destructive (handleClose below)
     and never touch this state. */
  const [confirmDismiss, setConfirmDismiss] = useState(false);

  /* fs-58 persistence Task 13 — debounce the selection PATCH per chapter so a
     burst of checkbox toggles collapses into one network call. Keyed by
     chapterId (not a single timer) so toggles across different chapters
     don't cancel each other's pending sync. */
  const selectionSyncTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  /* Clear any pending debounced-PATCH timers on unmount — otherwise a
     scheduled selection sync can fire after the modal has closed (e.g. the
     user hides it right after toggling a checkbox), which combined with
     mount-time re-hydration could cause a brief selection flicker. */
  useEffect(() => {
    const timers = selectionSyncTimers.current;
    return () => {
      for (const id of Object.values(timers)) clearTimeout(id);
    };
  }, []);

  if (!bucket) return null;

  const { ops, selected, unappliable } = bucket;

  /* Per-chapter/per-type aggregation — the collapsed summary the accordion
     renders (chapters ascending, mechanical types bulk-approvable). */
  const summary = selectReviewSummary(bucket);

  const selectedCount = ops.filter((o) => selected[opKey(o.chapterId, o.id, o.op)]).length;

  /* fs-58 persistence Task 13 — mirror the operator's checkbox state to the
     server (design spec §6.5's selection PATCH) 500ms after the last toggle
     for that chapter, so the persisted ledger stays in sync with what the
     modal shows without a round-trip on every click. */
  function scheduleSelectionSync(chapterId: number, currentSelected: Record<string, boolean>) {
    clearTimeout(selectionSyncTimers.current[chapterId]);
    selectionSyncTimers.current[chapterId] = setTimeout(() => {
      const version = bucket?.versionByChapter[chapterId];
      if (version === undefined) return;
      const chapterSelected: Record<string, boolean> = {};
      for (const op of ops) {
        if (op.chapterId !== chapterId) continue;
        chapterSelected[opKey(op.chapterId, op.id, op.op)] = !!currentSelected[opKey(op.chapterId, op.id, op.op)];
      }
      void api.patchScriptReviewSelection(bookId, { chapterId, version, selected: chapterSelected });
    }, 500);
  }

  function handleClose() {
    dispatch(scriptReviewActions.hideReview({ bookId }));
  }

  function handleDismiss() {
    setConfirmDismiss(true);
  }

  async function confirmDismissAll() {
    // Finding 3 (PR review round 4): scoping the discard to only `ops`
    // (the appliable set) silently left out a chapter whose findings are
    // ALL unappliable — even though this button's own copy claims "This
    // can't be undone." Include unappliable's chapters too.
    const chapterIds = [...new Set([...ops.map((o) => o.chapterId), ...unappliable.map((u) => u.op.chapterId)])];
    setConfirmDismiss(false);
    try {
      await discardReview(bookId, chapterIds, { dispatch });
    } catch (err) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to discard script-review findings.',
        }),
      );
    }
  }

  /* Run the finalized off-roster reattributes through the interleaved
     create→reassign helper (dedupe + book-switch guard); each applied op is
     resolved server-side one at a time via onOpApplied as it happens (fs-58
     persistence Task 14) — no whole-bucket clear at the end. Called once,
     after the LAST confirm resolves. */
  async function runProposed(finalized: FinalizedProposed[], startBookId: string) {
    const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
    try {
      const { createdCharacters, aborted } = await applyProposedReattributions(finalized, {
        rosterByName,
        createCharacter: async (p) => {
          // api.createCharacter resolves to a { character } envelope — unwrap it.
          // `p` widens gender/ageRange to string (the proposed shape); the API's
          // narrower enum tolerates the values the form's <select>s produce.
          const { character } = await api.createCharacter(startBookId, p as never);
          return character;
        },
        addCharacter: (c) => dispatch(castActions.addCharacter(c as never)),
        setSentenceCharacter: (chapterId, sentenceId, characterId) =>
          dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, characterId })),
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
        isSameBook: () => stageBookIdRef.current === startBookId,
        onOpApplied: (op) => {
          if (!bucket) return;
          void resolveAppliedOps(dispatch, startBookId, bucket, [op]);
        },
      });
      if (aborted) {
        // Book-switch guard tripped mid-batch (silent, no throw) — whatever
        // was already resolved via onOpApplied above stays resolved; hide,
        // don't discard the rest (design spec §6.5).
        setConfirm(null);
        dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
        return;
      }
      // fs-63 — on success, nudge to auto-voice any newly-created off-roster
      // character (qwen-only; no-op otherwise). Inside the try so a failed
      // create falls to the catch and never nudges.
      maybePushVoiceNudge(dispatch, { ttsModelKey, startBookId, createdCharacters });
    } catch {
      // A create failed mid-batch. Reset the confirm machine and surface a toast,
      // but DON'T clearReview — the operator can re-trigger. Re-run is safe because
      // setSentenceCharacter is idempotent for an already-applied reattribute.
      setConfirm(null);
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: "Couldn't create character",
          dedupeKey: 'create-character',
        }),
      );
      return;
    }
    setConfirm(null);
    // fs-58 persistence Task 14 — no clearReview/discard here: every applied
    // op was already resolved per-op via onOpApplied as it happened; any op
    // left in the bucket (unselected, or never reached because an earlier op
    // failed) stays, unresolved.
  }

  /* Advance the per-NAME confirm queue by one group's decision. "Create new"
     stamps the (possibly edited) proposed fields onto EVERY line of the group
     and defers them to the dedupe-aware helper; "reattribute to existing"
     applies all the group's lines to that id immediately (on-roster reassign)
     and resolves them server-side one at a time (design spec §6.5). When the
     LAST group is decided, hand the collected create-batch to runProposed
     exactly once. */
  function advanceGroup(
    group: ProposedNameGroup,
    decision: { characterId?: string; proposed?: { name: string; gender?: string; ageRange?: string } },
  ) {
    if (decision.characterId) {
      for (const op of group.ops) {
        dispatch(
          manuscriptActions.setSentenceCharacter({
            chapterId: op.chapterId,
            sentenceId: op.id,
            characterId: decision.characterId,
          }),
        );
        dispatch(changeLogActions.bumpBoundaryMove({ chapterId: op.chapterId, count: 1 }));
      }
      if (bucket) {
        const startBookId = confirm?.startBookId ?? bookId;
        void resolveAppliedOps(dispatch, startBookId, bucket, group.ops);
      }
    }
    setConfirm((prev) => {
      if (!prev) return prev;
      const finalized = decision.characterId
        ? prev.finalized
        : [...prev.finalized, ...group.ops.map((op) => ({ ...op, characterId: undefined, proposed: decision.proposed }))];
      const nextIndex = prev.index + 1;
      if (nextIndex >= prev.groups.length) {
        void runProposed(finalized, prev.startBookId);
        // Keep `confirm` populated until runProposed resolves — every applied
        // op is resolved per-op via onOpApplied as it happens; runProposed
        // itself calls setConfirm(null) once done (success, abort, or failure).
      }
      return { ...prev, finalized, index: nextIndex };
    });
  }

  /* Cancel mid-confirm: leave the already-applied direct ops in place, do NOT
     create any not-yet-confirmed member, and hide (not discard) the review
     bucket — whatever's left (including ops from this batch that were never
     confirmed) survives, reachable again via the badge/"Review existing"
     path (fs-58 persistence Task 14). */
  function cancelConfirm() {
    const startBookId = confirm?.startBookId ?? bookId;
    setConfirm(null);
    dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
  }

  function handleApply() {
    const startBookId = bookId;
    // Gather only the ops the user selected
    const selectedOps = ops.filter((o) => selected[opKey(o.chapterId, o.id, o.op)]);

    // Build the live snapshot for planApply
    const live = sentences.map((s) => ({
      id: s.id,
      chapterId: s.chapterId,
      text: s.text,
      characterId: s.characterId,
      instruct: s.instruct,
      vocalization: s.vocalization,
    }));

    const roster = new Set(cast.map((c) => c.id));
    const { appliable } = planApply(selectedOps, live, roster);

    // D2 — surface partial application: with the summary's bulk-approve it's
    // easy to select ~1000 ops at once, and planApply silently drops any that
    // no longer validate (stale text, one-structural-op-per-id collisions).
    // Tell the operator how many of their selection actually landed.
    const notApplied = selectedOps.length - appliable.length;
    if (notApplied > 0) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: `${appliable.length} applied · ${notApplied} couldn't apply (conflicting edits)`,
          dedupeKey: `script-review-partial-${startBookId}`,
        }),
      );
    }

    // Off-roster reattributes (a proposed new name, no characterId) defer to
    // the create→reassign confirm queue; everything else applies synchronously.
    const proposedOps = appliable.filter(
      (o) => o.op === 'reattribute' && o.proposed && !o.characterId,
    ) as ReviewOpWithChapter[];
    const directOps = appliable.filter(
      (o) => !(o.op === 'reattribute' && o.proposed && !o.characterId),
    ) as ReviewOpWithChapter[];

    dispatchAcceptedOps(
      dispatch,
      directOps,
      live,
      {
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
      },
    );
    // fs-58 persistence Task 13 — resolve directOps server-side UNCONDITIONALLY
    // whenever there are any, before the proposedOps early-return below. A
    // mixed batch (some direct ops + some off-roster proposed ops) would
    // otherwise skip past the old tail entirely and never resolve directOps.
    if (bucket && directOps.length > 0) {
      void resolveAppliedOps(dispatch, startBookId, bucket, directOps);
    }

    if (proposedOps.length > 0) {
      // Create-once: consolidate the off-roster proposals by normalized name so
      // a speaker on N lines prompts a single create, not N. Names that already
      // match a live cast member need no form — apply them straight through.
      const rosterNames = new Set(cast.map((c) => c.name.trim().toLowerCase()));
      const { newGroups, rosterMatchedOps } = consolidateProposedByName(proposedOps, rosterNames);
      if (newGroups.length === 0) {
        void runProposed(rosterMatchedOps, startBookId);
      } else {
        setConfirm({ groups: newGroups, index: 0, finalized: rosterMatchedOps, startBookId });
      }
      return; // the confirm queue / runProposed handle the rest (Task 14 cleanup path)
    }

    // fs-58 persistence Task 13 — hide the modal, don't wipe the bucket.
    // clearReview deleted the WHOLE bucket, including any op the user left
    // unchecked — the exact silent-data-loss bug this plan exists to fix.
    // hideReview only flips `visible`; anything resolveOpsLocally hasn't
    // (yet, or ever) removed stays reachable via the badge/"Review existing"
    // path (Task 11). resolveAppliedOps above is fire-and-forget (`void`), so
    // it may still be in flight here; once it resolves, resolveOpsLocally's
    // own empty-bucket cleanup (Task 6) deletes the bucket if every op ended
    // up resolved — hideReview on an already- or soon-to-be-deleted bucket is
    // a documented no-op (Task 6's reducer guards on `if (bucket)`).
    dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
  }

  // Create-once — the active confirm group (one per new unique name), if any.
  const confirmGroup =
    confirm && confirm.index < confirm.groups.length ? confirm.groups[confirm.index] : null;
  const confirmRosterByName = new Map(
    cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id, name: c.name }]),
  );

  /* Tick/untick an explicit key set and mirror the post-toggle snapshot to the
     server (stale-safe: builds nextSelected locally, since `selected` in this
     closure predates the dispatch). All keys here belong to one chapter. */
  function approveKeys(chapterId: number, keys: string[], nextValue: boolean) {
    if (keys.length === 0) return;
    dispatch(scriptReviewActions.toggleKeys({ bookId, keys, value: nextValue }));
    const nextSelected = { ...selected };
    for (const k of keys) if (k in nextSelected) nextSelected[k] = nextValue;
    scheduleSelectionSync(chapterId, nextSelected);
  }

  /* One op card — the leaf of the accordion. Extracted so the summary body and
     its tests share one render path. */
  function renderOpCard(op: ReviewOpWithChapter) {
    const key = opKey(op.chapterId, op.id, op.op);
    const isSelected = !!selected[key];
    const liveSentence = sentences.find((s) => s.chapterId === op.chapterId && s.id === op.id);
    return (
      <div key={key} className="flex items-start gap-3 p-3 rounded-2xl border border-ink/10 bg-canvas/50">
        <label
          htmlFor={`op-toggle-${key}`}
          className="flex items-center min-h-[44px] fine-pointer:min-h-0 cursor-pointer"
        >
          <Checkbox
            id={`op-toggle-${key}`}
            data-testid={`op-toggle-${key}`}
            checked={isSelected}
            accent="ink"
            onChange={() => {
              dispatch(scriptReviewActions.toggleOp({ bookId, key }));
              scheduleSelectionSync(op.chapterId, { ...selected, [key]: !selected[key] });
            }}
            aria-label={`Toggle this ${op.op} suggestion`}
          />
        </label>
        <div className="flex-1 min-w-0 space-y-1">
          <OpPreview
            op={op}
            before={liveSentence?.text}
            liveInstruct={liveSentence?.instruct}
            liveVocalization={liveSentence?.vocalization}
          />
          <p className="text-xs text-ink/55 leading-relaxed">{op.rationale}</p>
          {op.confidence !== undefined && (
            <p className="text-[10px] text-ink/40 tabular-nums">
              Confidence: {Math.round(op.confidence * 100)}%
            </p>
          )}
        </div>
        <span className="text-[10px] text-ink/35 tabular-nums shrink-0 mt-0.5">#{op.id}</span>
      </div>
    );
  }

  return (
    <>
      {/* Create-once — one confirm step per NEW unique proposed name, applied
          to every line that named it. The operator can edit the proposed name
          (→ create) or, if the typed name matches a roster member, reattribute
          to the existing one instead. */}
      {confirmGroup && (
        <>
          <div className="fixed inset-0 bg-ink/50 z-[60]" aria-hidden="true" />
          <div className="fixed inset-0 z-[60] grid place-items-center p-4 pointer-events-none">
            <div
              data-testid="confirm-reattribute"
              className="bg-white rounded-3xl shadow-float w-full max-w-md pointer-events-auto p-6 space-y-4"
            >
              <div>
                <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                  New speaker ({(confirm?.index ?? 0) + 1} of {confirm?.groups.length})
                </p>
                <h3 className="text-base font-bold text-ink leading-tight">
                  «{confirmGroup.name}» — {confirmGroup.ops.length} line{confirmGroup.ops.length === 1 ? '' : 's'}
                </h3>
              </div>
              <CreateCharacterForm
                // #1480 — keyed on the unique name so React remounts the form
                // (resetting its internal name/gender/ageRange state) on every
                // group advance instead of carrying the prior name's values.
                key={confirmGroup.name.trim().toLowerCase()}
                initial={confirmGroup.proposed}
                rosterByName={confirmRosterByName}
                onSubmit={(f) => advanceGroup(confirmGroup, { proposed: f })}
                onReattributeExisting={(characterId) => advanceGroup(confirmGroup, { characterId })}
                onCancel={cancelConfirm}
              />
            </div>
          </div>
        </>
      )}

      {/* fs-58 persistence Task 12 — "Dismiss all" confirm step. This is the
          sole destructive action left in this modal; close/backdrop
          (handleClose) never reach here. */}
      {confirmDismiss && (
        <>
          <div className="fixed inset-0 bg-ink/50 z-[60]" aria-hidden="true" />
          <div className="fixed inset-0 z-[60] grid place-items-center p-4 pointer-events-none">
            <div
              data-testid="dismiss-confirm"
              className="bg-white rounded-3xl shadow-float w-full max-w-sm pointer-events-auto p-6 space-y-4"
            >
              <p className="text-sm text-ink/80">
                Discard {ops.length} unresolved suggestion{ops.length === 1 ? '' : 's'}? This can&apos;t be undone.
              </p>
              <div className="flex items-center gap-3">
                <button
                  data-testid="dismiss-confirm-yes"
                  onClick={() => void confirmDismissAll()}
                  className="px-4 min-h-[44px] fine-pointer:min-h-0 py-2 rounded-full bg-ink text-canvas text-sm font-semibold"
                >
                  Discard
                </button>
                <button
                  data-testid="dismiss-confirm-cancel"
                  onClick={() => setConfirmDismiss(false)}
                  className="px-4 min-h-[44px] fine-pointer:min-h-0 py-2 rounded-full border border-ink/20 text-ink text-sm font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Backdrop */}
      <div
        onClick={handleClose}
        className="fixed inset-0 bg-ink/40 z-50"
        aria-hidden="true"
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto overflow-hidden max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                LLM script review
              </p>
              <h3 className="text-base font-bold text-ink leading-tight">
                Script review suggestions
                <span className="ml-2 text-sm font-normal text-ink/50">
                  ({ops.length} suggestion{ops.length === 1 ? '' : 's'})
                </span>
              </h3>
            </div>
            <button
              data-testid="close-button"
              onClick={handleClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] fine-pointer:min-h-0 min-w-[44px] fine-pointer:min-w-0 flex items-center justify-center"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin">
            {unappliable.length > 0 && (
              <div
                data-testid="unappliable-notice"
                className="rounded-2xl border border-ink/10 bg-canvas/50 px-4 py-3 text-xs text-ink/60"
              >
                <span className="font-semibold text-ink/70">
                  {unappliable.length} suggestion{unappliable.length === 1 ? '' : 's'} couldn&apos;t be applied
                </span>
                {' '}(stale text or invalid)
              </div>
            )}
            {summary.chapters.length === 0 && (
              <div
                data-testid="script-review-empty"
                className="rounded-2xl border border-ink/10 bg-canvas/50 px-6 py-10 text-center"
              >
                <p className="text-sm font-medium text-ink/70">No suggestions found</p>
                <p className="mt-1 text-xs text-ink/50">
                  {unappliable.length > 0
                    ? "All suggestions were stale or invalid and couldn't be applied."
                    : "The reviewer didn't find anything to change in this scope."}
                </p>
              </div>
            )}
            {summary.chapters.map((chapter) => {
              const chapterOpen = expandedChapters.has(chapter.chapterId);
              const allChapterSel =
                chapter.selectableKeys.length > 0 && chapter.selectableKeys.every((k) => selected[k]);
              return (
                <section
                  key={chapter.chapterId}
                  data-testid={`chapter-section-${chapter.chapterId}`}
                  className="space-y-2"
                >
                  {/* Chapter row — approve-all checkbox + clickable expand button.
                      BLOCKER-2: the chapter-row testid sits on the expand BUTTON
                      (clickable, carries the "N to review" text), never the wrapper. */}
                  <div className="flex items-center gap-3 pb-1 border-b border-ink/10">
                    {chapter.selectableKeys.length > 0 && (
                      <label className="flex items-center gap-1.5 text-[11px] text-ink/55 cursor-pointer select-none min-h-[44px] fine-pointer:min-h-0">
                        <Checkbox
                          data-testid={`chapter-approve-${chapter.chapterId}`}
                          checked={allChapterSel}
                          accent="ink"
                          onChange={() => approveKeys(chapter.chapterId, chapter.selectableKeys, !allChapterSel)}
                          aria-label={`Approve all mechanical suggestions in chapter ${chapter.chapterId}`}
                        />
                        Approve {chapter.selectableKeys.length}
                      </label>
                    )}
                    <button
                      type="button"
                      data-testid={`chapter-row-${chapter.chapterId}`}
                      onClick={() => toggleChapterExpand(chapter.chapterId)}
                      className="flex-1 flex items-center gap-3 text-left min-h-[44px] fine-pointer:min-h-0"
                    >
                      <span className="text-xs font-bold uppercase tracking-wider text-ink/60 flex-1">
                        Chapter {chapter.chapterId}
                      </span>
                      <span className="text-xs text-ink/45 tabular-nums">
                        {chapter.total}
                        {chapter.toReview > 0 ? ` · ${chapter.toReview} to review` : ''}
                      </span>
                      <span aria-hidden className="text-ink/40">
                        {chapterOpen ? '▾' : '▸'}
                      </span>
                    </button>
                  </div>

                  {chapterOpen &&
                    chapter.byType.map((type) => {
                      const typeOpen = expandedTypes.has(`${chapter.chapterId}:${type.op}`);
                      const allTypeSel =
                        type.selectableKeys.length > 0 && type.selectableKeys.every((k) => selected[k]);
                      const typeOps = ops.filter(
                        (o) => o.chapterId === chapter.chapterId && o.op === type.op,
                      );
                      return (
                        <div
                          key={type.op}
                          data-testid={`type-group-${chapter.chapterId}-${type.op}`}
                          className="pl-3 space-y-2"
                        >
                          <div className="flex items-center gap-2">
                            {type.selectableKeys.length > 0 ? (
                              <label className="flex items-center gap-1.5 text-[11px] text-ink/55 cursor-pointer select-none min-h-[44px] fine-pointer:min-h-0">
                                <Checkbox
                                  data-testid={`type-approve-${chapter.chapterId}-${type.op}`}
                                  checked={allTypeSel}
                                  accent="ink"
                                  onChange={() => approveKeys(chapter.chapterId, type.selectableKeys, !allTypeSel)}
                                  aria-label={`Approve ${classLabel(type.op)} in chapter ${chapter.chapterId}`}
                                />
                              </label>
                            ) : (
                              <span className="text-[10px] uppercase tracking-wider text-magenta/70">review</span>
                            )}
                            <button
                              type="button"
                              data-testid={`type-row-${chapter.chapterId}-${type.op}`}
                              onClick={() => toggleTypeExpand(chapter.chapterId, type.op)}
                              className="flex-1 flex items-center gap-2 text-left min-h-[44px] fine-pointer:min-h-0"
                            >
                              <span className="text-xs font-semibold text-ink/70 flex-1">{classLabel(type.op)}</span>
                              <span className="text-[11px] text-ink/45 tabular-nums">{type.count}</span>
                              <span aria-hidden className="text-ink/40">
                                {typeOpen ? '▾' : '▸'}
                              </span>
                            </button>
                          </div>
                          {typeOpen && <div className="space-y-2">{typeOps.map(renderOpCard)}</div>}
                        </div>
                      );
                    })}
                </section>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-ink/10 flex items-center gap-3 flex-wrap">
            <button
              data-testid="apply-button"
              onClick={handleApply}
              disabled={selectedCount === 0}
              className="shrink-0 inline-flex items-center gap-2 px-5 min-h-[44px] fine-pointer:min-h-0 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply {selectedCount} selected
            </button>
            <button
              data-testid="dismiss-button"
              onClick={handleDismiss}
              className="text-sm font-medium text-ink/50 hover:text-ink/80 min-h-[44px] fine-pointer:min-h-0"
            >
              Dismiss all
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
