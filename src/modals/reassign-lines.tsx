/* Reassign Lines modal (#1676 part c).

   One reusable form for moving many attributed lines from one character to
   another, driven by a discriminated `source`:
     - character: every sentence currently on a character (roster path)
     - selection: an explicit key set multi-selected in the script view
     - unlink:    today's alias-unlink flow (feature b reuses this)

   Selection is a Set<"chapterId:sentenceId"> over the FULL resolved candidate
   list held in component state — never derived from mounted (virtualized) DOM
   rows, so "select all" covers the whole 1184/10k-row set, not just the window.
   Apply routes through a lightweight confirm, re-validates keys against the
   live store (drift), then dispatches ONE setSentencesCharacterBulk plus a
   bumpBoundaryMove per affected chapter. The layout-level Undo banner (see
   bulk-reassign-undo-banner.tsx) owns the undo affordance. */

import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconClose } from '../lib/icons';
import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import type { UnlinkAliasImpactedChapter } from '../lib/api';
import type { Sentence } from '../lib/types';
import type { SentenceKey } from '../store/manuscript-slice';

export type ReassignSource =
  | { kind: 'character'; characterId: string }
  | { kind: 'selection'; keys: SentenceKey[] }
  | { kind: 'unlink'; impactedChapters: UnlinkAliasImpactedChapter[]; aliasCharacterId: string };

interface Props {
  source: ReassignSource;
  onClose: () => void;
}

const CHAR_PREVIEW = 140;
const keyOf = (chapterId: number, sentenceId: number) => `${chapterId}:${sentenceId}`;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

interface Row {
  chapterId: number;
  sentenceId: number;
  text: string;
  characterId: string;
}

export function ReassignLinesModal({ source, onClose }: Props) {
  const dispatch = useAppDispatch();
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const characters = useAppSelector((s) => s.cast.characters);
  const chapters = useAppSelector((s) => s.chapters.chapters);

  const chapterTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of chapters) m.set(c.id, c.title);
    return m;
  }, [chapters]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of characters) m.set(c.id, c.name);
    return m;
  }, [characters]);

  /* Resolve the full candidate list from `source`. Read from the live store so
     the list reflects concurrent edits, but freeze the identity set at open by
     memoizing on `source` only for the selection/unlink key lists (the row TEXT
     may still update). */
  const rows = useMemo<Row[]>(() => {
    const byKey = new Map<string, Sentence>();
    for (const s of sentences) byKey.set(keyOf(s.chapterId, s.id), s);
    if (source.kind === 'character') {
      return sentences
        .filter((s) => s.characterId === source.characterId)
        .map((s) => ({ chapterId: s.chapterId, sentenceId: s.id, text: s.text, characterId: s.characterId }));
    }
    if (source.kind === 'selection') {
      return source.keys
        .map((k) => byKey.get(keyOf(k.chapterId, k.sentenceId)))
        .filter((s): s is Sentence => Boolean(s))
        .map((s) => ({ chapterId: s.chapterId, sentenceId: s.id, text: s.text, characterId: s.characterId }));
    }
    // unlink
    const out: Row[] = [];
    for (const ch of source.impactedChapters) {
      for (const sid of ch.candidateSentenceIds) {
        const s = byKey.get(keyOf(ch.chapterId, sid));
        if (s) out.push({ chapterId: s.chapterId, sentenceId: s.id, text: s.text, characterId: s.characterId });
      }
    }
    return out;
  }, [source, sentences]);

  const spansSpeakers = useMemo(() => new Set(rows.map((r) => r.characterId)).size > 1, [rows]);

  // --- filters ---
  const [textFilter, setTextFilter] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState<string>(''); // '' = all
  const filteredRows = useMemo(() => {
    const t = textFilter.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!t || r.text.toLowerCase().includes(t)) &&
        (!speakerFilter || r.characterId === speakerFilter),
    );
  }, [rows, textFilter, speakerFilter]);

  // --- selection (render-independent Set over the FULL candidate list) ---
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => keyOf(r.chapterId, r.sentenceId))));
  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const selectAll = () => setSelected(new Set(rows.map((r) => keyOf(r.chapterId, r.sentenceId))));
  const selectNone = () => setSelected(new Set());
  const invert = () =>
    setSelected((prev) => {
      const next = new Set<string>();
      for (const r of rows) {
        const k = keyOf(r.chapterId, r.sentenceId);
        if (!prev.has(k)) next.add(k);
      }
      return next;
    });
  const selectAllMatching = () =>
    setSelected(new Set(filteredRows.map((r) => keyOf(r.chapterId, r.sentenceId))));
  const selectChapter = (chapterId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) if (r.chapterId === chapterId) next.add(keyOf(r.chapterId, r.sentenceId));
      return next;
    });

  // --- target picker ---
  const defaultTarget = source.kind === 'unlink' ? source.aliasCharacterId : '';
  const [targetId, setTargetId] = useState<string>(defaultTarget);
  const sourceCharacterId = source.kind === 'character' ? source.characterId : undefined;
  // No pending-removal state exists on Character in part (c) (spec Round 3), so
  // every roster character except the disabled source is a valid target.
  const targetOptions = characters;

  // --- confirm gating ---
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const affectedChapters = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) if (selected.has(keyOf(r.chapterId, r.sentenceId))) set.add(r.chapterId);
    return [...set];
  }, [rows, selected]);

  const selectedCount = selected.size;
  const isEmpty = rows.length === 0;
  const canApply = selectedCount > 0 && targetId !== '' && targetId !== sourceCharacterId;

  function apply() {
    // Re-validate each selected key against the LIVE store (m9 — drift).
    const liveKeys = new Set(sentences.map((s) => keyOf(s.chapterId, s.id)));
    const requested = [...selected];
    const resolvable = requested.filter((k) => liveKeys.has(k));
    const skipped = requested.length - resolvable.length;
    const keys: SentenceKey[] = resolvable.map((k) => {
      const [c, s] = k.split(':');
      return { chapterId: Number(c), sentenceId: Number(s) };
    });
    dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys,
        characterId: targetId,
        targetLabel: nameById.get(targetId) ?? 'Character',
      }),
    );
    for (const chapterId of new Set(keys.map((k) => k.chapterId))) {
      dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 }));
    }
    if (skipped > 0) {
      setResult(`Moved ${keys.length} lines; ${skipped} no longer existed and were skipped.`);
      setConfirming(false);
    } else {
      onClose();
    }
  }

  // --- virtualization over filteredRows ---
  // `useVirtualizer` measures its scroll container via ResizeObserver, which
  // jsdom (unit tests) never fires — a zero-height container would mount
  // zero rows there. Below a small-list threshold we skip the virtualizer
  // and render every row directly (same "flat render below N" idiom as
  // `chapterVirtEnabled` in listen-player-region.tsx); real 1k/10k-row
  // candidate lists still go through the virtualizer.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtEnabled = filteredRows.length >= 40;
  const virtualizer = useVirtualizer({
    count: rowVirtEnabled ? filteredRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  const targetName = nameById.get(targetId) ?? '';
  const sourceName = sourceCharacterId ? nameById.get(sourceCharacterId) ?? '' : 'the current speaker';
  const isNarratorTarget = targetName.toLowerCase() === 'narrator';

  function renderRow(r: Row, style?: React.CSSProperties, index?: number) {
    const k = keyOf(r.chapterId, r.sentenceId);
    return (
      <label
        key={k}
        data-index={index}
        ref={rowVirtEnabled ? virtualizer.measureElement : undefined}
        style={style}
        className="flex items-start gap-3 py-2.5 border-b border-ink/8 cursor-pointer"
      >
        <input
          type="checkbox"
          checked={selected.has(k)}
          onChange={() => toggle(k)}
          className="mt-1 w-4 h-4 shrink-0"
        />
        <span className="flex-1 text-sm text-ink/80 leading-relaxed">
          <span className="text-[11px] text-ink/45 mr-2">
            {chapterTitleById.get(r.chapterId) ?? `Ch ${r.chapterId}`} · {r.sentenceId}
          </span>
          {truncate(r.text, CHAR_PREVIEW)}
        </span>
      </label>
    );
  }

  // The confirm step REPLACES the main form (rather than overlaying it) so
  // there's no lingering "Reassign to" <select> (with its own "Narrator"
  // option) still in the DOM to collide with the confirm copy's mention of
  // the target name.
  if (confirming) {
    return (
      <>
        <div onClick={onClose} className="fixed inset-0 bg-ink/30 z-50 fade-in" />
        <div className="fixed inset-0 bg-ink/40 z-[60]" />
        <div role="alertdialog" aria-label="Confirm reassignment" className="fixed left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100vw-32px))] bg-white rounded-2xl shadow-drawer p-6">
          <h4 className="text-base font-bold text-ink mb-2">
            Reassign {selectedCount} lines from {sourceName} to {targetName} across {affectedChapters.length} chapter{affectedChapters.length === 1 ? '' : 's'}?
          </h4>
          {isNarratorTarget && (
            <p className="text-sm text-amber-700 mb-3">
              Re-check this is intended — merging speech back into narration is easy to do by accident.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirming(false)} className="px-4 py-2 rounded-full text-sm font-semibold bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Cancel</button>
            <button onClick={apply} className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 min-h-[44px] fine-pointer:min-h-0">Confirm</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/30 z-50 fade-in" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reassign lines"
        className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(760px,calc(100vw-32px))] max-h-[min(84vh,calc(100vh-64px))] bg-white rounded-3xl shadow-drawer flex flex-col"
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-md rounded-t-3xl border-b border-ink/10 px-6 py-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Reassign lines</p>
            <h3 className="text-lg font-bold text-ink leading-tight truncate">
              {selectedCount} selected
            </h3>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-w-[44px] min-h-[44px] fine-pointer:min-w-0 fine-pointer:min-h-0"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        {isEmpty ? (
          <div className="px-6 py-8 text-sm text-ink/65">
            <p className="font-semibold text-ink mb-1">Nothing to reassign here — 0 lines to move for this selection.</p>
          </div>
        ) : (
          <>
            {/* controls */}
            <div className="px-6 py-3 border-b border-ink/10 flex flex-wrap items-center gap-2">
              <button onClick={selectAll} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Select all</button>
              <button onClick={selectNone} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Clear</button>
              <button onClick={invert} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink/6 hover:bg-ink/10 min-h-[44px] fine-pointer:min-h-0">Invert</button>
              <input
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
                placeholder="Filter text…"
                className="flex-1 min-w-[140px] text-sm px-3 py-1.5 rounded-full border border-ink/15 bg-canvas/40"
              />
              {spansSpeakers && (
                <select
                  aria-label="Filter by current speaker"
                  value={speakerFilter}
                  onChange={(e) => setSpeakerFilter(e.target.value)}
                  className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white"
                >
                  <option value="">All speakers</option>
                  {[...new Set(rows.map((r) => r.characterId))].map((id) => (
                    <option key={id} value={id}>{nameById.get(id) ?? id}</option>
                  ))}
                </select>
              )}
              {[...new Set(rows.map((r) => r.chapterId))].length > 1 && (
                <select
                  aria-label="Select all in chapter"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) selectChapter(Number(e.target.value));
                  }}
                  className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white"
                >
                  <option value="">Select all in chapter…</option>
                  {[...new Set(rows.map((r) => r.chapterId))].map((cid) => (
                    <option key={cid} value={cid}>
                      {chapterTitleById.get(cid) ?? `Chapter ${cid}`}
                    </option>
                  ))}
                </select>
              )}
              <button onClick={selectAllMatching} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-magenta/12 text-magenta hover:bg-magenta/20 min-h-[44px] fine-pointer:min-h-0">
                Select all matching
              </button>
            </div>

            {/* rows: virtualized above the threshold, flat below it (see rowVirtEnabled) */}
            <div ref={scrollRef} className="px-6 py-2 overflow-y-auto scrollbar-thin flex-1">
              {rowVirtEnabled ? (
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((vi) =>
                    renderRow(
                      filteredRows[vi.index],
                      { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` },
                      vi.index,
                    ),
                  )}
                </div>
              ) : (
                filteredRows.map((r) => renderRow(r))
              )}
            </div>

            {/* footer */}
            <div className="sticky bottom-0 bg-white/95 backdrop-blur-md border-t border-ink/10 px-6 py-3 flex flex-wrap items-center justify-end gap-2 rounded-b-3xl">
              {result && <p className="flex-1 text-xs text-ink/60">{result}</p>}
              <label className="text-sm text-ink/70 flex items-center gap-2">
                Reassign to
                <select
                  aria-label="Reassign to"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white"
                >
                  <option value="">Choose…</option>
                  {targetOptions.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.id === sourceCharacterId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!canApply}
                onClick={() => setConfirming(true)}
                className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 disabled:opacity-40 min-h-[44px] fine-pointer:min-h-0"
              >
                Reassign {selectedCount} lines
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
