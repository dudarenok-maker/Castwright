import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import {
  IconChevR, IconChevL, IconPlus, IconCheck, IconClose, IconArrowDn,
  IconSpinner, IconWarning, IconEye,
} from '../lib/icons';
import { SectionLabel, ColorDot, Pill } from '../components/primitives';
import { CHAR_COLORS } from '../lib/colors';
import { initialSentences } from '../data/sentences';
import { useAppDispatch } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import type { Character, Chapter, Sentence, CharColor } from '../lib/types';

interface Props {
  characters: Character[];
  chapters: Chapter[];
  currentChapterId: number | null;
  setCurrentChapterId: (id: number) => void;
  sentencesFromStore?: Sentence[];
  onOpenProfile?: (id: string) => void;
  onStartGenerating?: () => void;
}

interface IndexedSentence extends Sentence { absIdx: number; }
interface Segment { id: string; characterId: string; sentences: IndexedSentence[]; }
interface Drag { boundaryIdx: number; anchorY: number; candidateSentenceIdx: number | null; }

export function ManuscriptView({ characters, chapters, currentChapterId, setCurrentChapterId, sentencesFromStore, onOpenProfile, onStartGenerating }: Props) {
  const dispatch = useAppDispatch();
  /* Sentences are the single source of truth in Redux. All edits go via
     dispatch(manuscriptActions.*) — no local copy. */
  const sentences: Sentence[] = sentencesFromStore ?? initialSentences;
  const [selectedSeg, setSelectedSeg] = useState<string | null>(null);
  const [filterChar, setFilterChar] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const currentChapter = chapters.find(c => c.id === currentChapterId) || chapters[0];
  const currentIdx = chapters.findIndex(c => c.id === currentChapterId);
  const prevChapter = chapters[currentIdx - 1];
  const nextChapter = chapters[currentIdx + 1];
  const containerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const selection = useSentenceSelection(articleRef);

  const segments: Segment[] = useMemo(() => {
    const segs: Segment[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const last = segs[segs.length - 1];
      if (last && last.characterId === s.characterId) last.sentences.push({ ...s, absIdx: i });
      else segs.push({ id: `seg_${segs.length}`, characterId: s.characterId, sentences: [{ ...s, absIdx: i }] });
    }
    return segs;
  }, [sentences]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sentences) m[s.characterId] = (m[s.characterId] || 0) + 1;
    return m;
  }, [sentences]);

  const findChar = useCallback((id: string) => characters.find(c => c.id === id), [characters]);

  const onBoundaryMouseDown = (boundaryIdx: number, e: MouseEvent) => {
    e.preventDefault();
    setDrag({ boundaryIdx, anchorY: e.clientY, candidateSentenceIdx: null });
    document.body.classList.add('dragging-boundary');
  };

  function commitBoundaryMove(d: Drag) {
    const segAbove = segments[d.boundaryIdx - 1];
    const segBelow = segments[d.boundaryIdx];
    if (!segAbove || !segBelow || d.candidateSentenceIdx == null) return;
    const anchorIdx = segBelow.sentences[0].absIdx;
    const candIdx = d.candidateSentenceIdx;
    const ids: number[] = [];
    let newCharacterId: string;
    if (candIdx < anchorIdx) {
      newCharacterId = segBelow.characterId;
      for (let i = candIdx; i < anchorIdx; i++) ids.push(sentences[i].id);
    } else {
      newCharacterId = segAbove.characterId;
      for (let i = anchorIdx; i <= candIdx; i++) ids.push(sentences[i].id);
    }
    if (ids.length) dispatch(manuscriptActions.setSentencesCharacter({ sentenceIds: ids, characterId: newCharacterId }));
  }

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: globalThis.MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const sentenceEl = el?.closest?.('[data-sentence-idx]') as HTMLElement | null;
      if (sentenceEl) {
        const idx = Number(sentenceEl.dataset.sentenceIdx);
        setDrag(d => d && d.candidateSentenceIdx !== idx ? { ...d, candidateSentenceIdx: idx } : d);
      }
    };
    const onUp = () => {
      setDrag(d => {
        if (d && d.candidateSentenceIdx != null) commitBoundaryMove(d);
        return null;
      });
      document.body.classList.remove('dragging-boundary');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.boundaryIdx]);

  function reassignSegment(seg: Segment, newCharId: string) {
    dispatch(manuscriptActions.setSentencesCharacter({
      sentenceIds: seg.sentences.map(s => s.id),
      characterId: newCharId,
    }));
  }

  function assignSelectionTo(newCharacterId: string) {
    if (!selection) return;
    const sentence = sentences.find(s => s.id === selection.sentenceId);
    if (!sentence) return;
    const len = sentence.text.length;
    /* Whole sentence selected → simple reassign. Otherwise split into
       three pieces with the middle reassigned. The reducer drops empty
       pieces, so leading/trailing zero-length splits are safe. */
    if (selection.start <= 0 && selection.end >= len) {
      dispatch(manuscriptActions.setSentenceCharacter({ sentenceId: selection.sentenceId, characterId: newCharacterId }));
    } else {
      dispatch(manuscriptActions.splitSentence({
        sentenceId: selection.sentenceId,
        offsets: [selection.start, selection.end],
        characterIds: [sentence.characterId, newCharacterId, sentence.characterId],
      }));
    }
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div className="max-w-[1500px] mx-auto px-6 py-8 grid grid-cols-[280px_1fr_360px] gap-6" ref={containerRef}>
      <div className="self-start sticky top-24 space-y-4 max-h-[calc(100vh-100px)] overflow-y-auto pr-1">
        <aside className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-ink">Chapters</h2>
            <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-ink/[0.06] text-[11px] font-semibold text-ink/60 tabular-nums">
              {chapters.length}
            </span>
          </div>
          <ul className="space-y-0.5">
            {chapters.map(ch => {
              const active = currentChapterId === ch.id;
              return (
                <li key={ch.id}>
                  <button onClick={() => setCurrentChapterId(ch.id)}
                          className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors relative ${active ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.03]'}`}>
                    {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-peach"/>}
                    <span className={`text-[11px] font-bold tabular-nums w-7 ${active ? 'text-magenta' : 'text-ink/40'}`}>CH {String(ch.id).padStart(2, '0')}</span>
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm truncate ${active ? 'font-semibold text-ink' : 'font-medium text-ink/80'}`}>{ch.title}</span>
                      <span className="block text-[11px] text-ink/50 tabular-nums">{ch.duration}</span>
                    </span>
                    {ch.state === 'in_progress' && <IconSpinner className="w-3 h-3 text-magenta shrink-0"/>}
                    {ch.state === 'done'        && <IconCheck    className="w-3 h-3 text-emerald-600 shrink-0"/>}
                    {ch.state === 'failed'      && <IconWarning  className="w-3 h-3 text-rose-600 shrink-0"/>}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <aside className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-ink">Detected</h2>
            <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-ink/[0.06] text-[11px] font-semibold text-ink/60 tabular-nums">
              {characters.length}
            </span>
          </div>
          <ul className="space-y-1">
            {characters.map(c => {
              const active = filterChar === c.id;
              const cc = CHAR_COLORS[c.color as CharColor] ?? CHAR_COLORS.narrator;
              return (
                <li key={c.id}>
                  <div className={`group/char relative w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-colors ${active ? '' : 'hover:bg-ink/[0.03]'}`}
                       style={active ? { background: cc.tint, boxShadow: `inset 0 0 0 1px ${cc.ring}` } : undefined}>
                    {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: cc.hex }}/>}
                    <button onClick={() => setFilterChar(active ? null : c.id)}
                            className="flex-1 min-w-0 flex items-center gap-3 text-left"
                            title={active ? 'Clear filter' : 'Filter manuscript to this character'}>
                      <ColorDot color={c.color as CharColor} size={10}/>
                      <span className="flex-1 min-w-0">
                        <span className={`block text-sm truncate ${active ? 'font-bold' : 'font-medium text-ink'}`}
                              style={active ? { color: cc.hex } : undefined}>
                          {c.name}
                        </span>
                        <span className="block text-xs text-ink/50 truncate">{c.role}</span>
                      </span>
                      <span className={`text-xs tabular-nums ${active ? 'font-semibold' : 'text-ink/50'}`}
                            style={active ? { color: cc.hex } : undefined}>
                        {counts[c.id] || 0}
                      </span>
                    </button>
                    {onOpenProfile && (
                      <button onClick={() => onOpenProfile(c.id)}
                              title={`Open ${c.name} profile`}
                              className={`p-1.5 rounded-lg text-ink/40 hover:text-ink hover:bg-ink/[0.05] transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover/char:opacity-100 focus:opacity-100'}`}>
                        <IconEye className="w-4 h-4"/>
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <button className="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-dashed border-ink/20 text-sm text-ink/60 hover:border-peach hover:text-peach transition-colors">
            <IconPlus className="w-4 h-4"/> Add character
          </button>
          <hr className="my-5 border-ink/10"/>
          <div className="text-xs text-ink/50 leading-relaxed space-y-2">
            <p><span className="font-semibold text-ink/70">Move a boundary:</span> drag the line between paragraphs and drop onto any sentence.</p>
            <p><span className="font-semibold text-ink/70">Reassign:</span> hover any paragraph and use the dropdown.</p>
            <p><span className="font-semibold text-ink/70">Profile:</span> click a character's name to open their full profile.</p>
          </div>
        </aside>
      </div>

      <main>
        <div className="mb-6">
          <SectionLabel>Manuscript analysis</SectionLabel>
          <div className="mt-4 flex items-start gap-6">
            <h1 className="flex-1 text-3xl md:text-4xl font-medium leading-[1.1] tracking-tight">
              Chapter {currentChapter.id} — <span className="font-bold">{currentChapter.title}</span>
            </h1>
            {onStartGenerating && (
              <button onClick={onStartGenerating}
                      className="shrink-0 inline-flex items-center gap-2 px-5 py-3 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink/90 shadow-card">
                Approve cast &amp; start generating
                <IconChevR className="w-4 h-4"/>
              </button>
            )}
          </div>
          <div className="mt-3 flex items-center gap-4 text-sm text-ink/60">
            <span>{segments.length} segments</span><span>·</span>
            <span>{Object.keys(counts).length} speakers</span><span>·</span>
            <span className="text-amber-700">{sentences.filter(s => s.confidence != null && s.confidence < 0.75).length} low-confidence</span>
            <span className="ml-auto flex items-center gap-1">
              <button onClick={() => prevChapter && setCurrentChapterId(prevChapter.id)} disabled={!prevChapter}
                      className="px-2 py-1 rounded-lg border border-ink/10 bg-white text-ink/70 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1 text-xs font-medium">
                <IconChevL className="w-3.5 h-3.5"/> Prev
              </button>
              <button onClick={() => nextChapter && setCurrentChapterId(nextChapter.id)} disabled={!nextChapter}
                      className="px-2 py-1 rounded-lg border border-ink/10 bg-white text-ink/70 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1 text-xs font-medium">
                Next <IconChevR className="w-3.5 h-3.5"/>
              </button>
            </span>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10">
          <article ref={articleRef} className="font-serif text-[17px] leading-[1.8] text-ink/90">
            {segments.map((seg, segIdx) => (
              <Fragment key={seg.id}>
                <SegmentRow
                  seg={seg}
                  characters={characters}
                  selected={selectedSeg === seg.id}
                  dimmed={!!filterChar && filterChar !== seg.characterId}
                  drag={drag}
                  onSelect={() => setSelectedSeg(seg.id)}
                  onReassignSegment={(newCharId) => reassignSegment(seg, newCharId)}
                  onOpenProfile={onOpenProfile}
                  findChar={findChar}
                />
                {segIdx < segments.length - 1 && (
                  <BoundaryHandle boundaryIdx={segIdx + 1} drag={drag} onMouseDown={onBoundaryMouseDown}/>
                )}
              </Fragment>
            ))}
          </article>
        </div>
      </main>

      <aside className="self-start sticky top-24">
        <SegmentInspector
          seg={segments.find(s => s.id === selectedSeg)}
          characters={characters}
          findChar={findChar}
          onClose={() => setSelectedSeg(null)}
          onReassignSegment={(seg, newCharId) => {
            reassignSegment(seg, newCharId);
            setSelectedSeg(null);
          }}
          onReassignSentence={(sentenceId, newCharId) => {
            dispatch(manuscriptActions.setSentenceCharacter({ sentenceId, characterId: newCharId }));
          }}
          onOpenProfile={onOpenProfile}
        />
      </aside>

      <SelectionPopover sel={selection} characters={characters} onAssign={assignSelectionTo}/>
    </div>
  );
}

interface SegmentRowProps {
  seg: Segment;
  characters: Character[];
  selected: boolean;
  dimmed: boolean;
  drag: Drag | null;
  onSelect: () => void;
  onReassignSegment: (newCharId: string) => void;
  onOpenProfile?: (id: string) => void;
  findChar: (id: string) => Character | undefined;
}

function SegmentRow({ seg, characters, selected, dimmed, drag, onSelect, onReassignSegment, onOpenProfile, findChar }: SegmentRowProps) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const char = findChar(seg.characterId);
  const c = CHAR_COLORS[(char?.color as CharColor)] ?? CHAR_COLORS.narrator;

  return (
    <div className={`group relative -mx-4 px-4 py-2 rounded-xl transition-all cursor-pointer ${dimmed ? 'opacity-40' : ''} ${selected ? 'ring-1 ring-peach/40' : 'hover:bg-ink/[0.02]'}`}
         onMouseEnter={() => setHovered(true)}
         onMouseLeave={() => { setHovered(false); setMenuOpen(false); }}
         onClick={onSelect}>
      <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: c.hex }}/>
      <span className="absolute inset-0 rounded-xl pointer-events-none" style={{ background: c.tint }}/>
      <div className="relative">
        <div className="flex items-center gap-2 mb-1">
          {onOpenProfile && char ? (
            <button onClick={(e) => { e.stopPropagation(); onOpenProfile(char.id); }}
                    title={`Open ${char.name} profile`}
                    className="text-[11px] uppercase tracking-wider font-semibold hover:underline underline-offset-2"
                    style={{ color: c.hex }}>
              {char.name}
            </button>
          ) : (
            <span className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: c.hex }}>
              {char?.name}
            </span>
          )}
          {seg.sentences.some(s => s.confidence != null && s.confidence < 0.75) && (
            <Pill color="warning">Low confidence</Pill>
          )}
          <span className={`ml-auto flex items-center gap-1 transition-opacity ${hovered || selected ? 'opacity-100' : 'opacity-0'}`}>
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
                      className="px-2 py-1 rounded-md bg-white border border-ink/10 text-[11px] font-medium text-ink/70 hover:text-ink hover:border-ink/30 inline-flex items-center gap-1">
                Reassign <IconArrowDn className="w-3 h-3"/>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-ink/10 rounded-xl shadow-card py-1 z-10" onClick={(e) => e.stopPropagation()}>
                  {characters.map(cc => (
                    <button key={cc.id} onClick={() => { onReassignSegment(cc.id); setMenuOpen(false); }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-ink/[0.04] text-left text-sm">
                      <ColorDot color={cc.color as CharColor}/><span className="flex-1">{cc.name}</span>
                      {cc.id === seg.characterId && <IconCheck className="w-3.5 h-3.5 text-ink/60"/>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </span>
        </div>
        <div>
          {seg.sentences.map((s, i) => {
            const isCandidate = drag && drag.candidateSentenceIdx === s.absIdx;
            const isLast = i === seg.sentences.length - 1;
            return (
              <Fragment key={s.id}>
                <span data-sentence-id={s.id}
                      data-sentence-idx={s.absIdx}
                      className={`inline transition-colors ${isCandidate ? 'sentence-candidate' : ''}`}>
                  {s.text}
                </span>
                {!isLast && ' '}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BoundaryHandle({ boundaryIdx, drag, onMouseDown }: { boundaryIdx: number; drag: Drag | null; onMouseDown: (idx: number, e: MouseEvent) => void }) {
  const isThisDragging = drag?.boundaryIdx === boundaryIdx;
  return (
    <div className="relative h-3 -my-1 group">
      <span onMouseDown={(e) => onMouseDown(boundaryIdx, e)}
            className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] cursor-ns-resize transition-colors ${isThisDragging ? 'bg-peach' : 'bg-transparent group-hover:bg-peach/40'}`}/>
      <span className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2 py-0.5 rounded-full bg-white border text-[10px] font-medium uppercase tracking-wider transition-opacity ${isThisDragging ? 'opacity-100 border-peach text-magenta pulse-ring' : 'opacity-0 group-hover:opacity-100 border-ink/15 text-ink/50'}`}>
        {isThisDragging ? 'drop on a sentence' : 'drag to move'}
      </span>
    </div>
  );
}

interface InspectorProps {
  seg: Segment | undefined;
  characters: Character[];
  findChar: (id: string) => Character | undefined;
  onClose: () => void;
  onReassignSegment: (seg: Segment, newCharId: string) => void;
  onReassignSentence: (sentenceId: number, newCharId: string) => void;
  onOpenProfile?: (id: string) => void;
}

function SegmentInspector({ seg, characters, findChar, onClose, onReassignSegment, onReassignSentence, onOpenProfile }: InspectorProps) {
  if (!seg) return (
    <div className="bg-white rounded-3xl border border-dashed border-ink/15 p-6 text-sm text-ink/50">
      <p className="font-medium text-ink/70">Select a paragraph to inspect or reassign.</p>
      <p className="mt-2 leading-relaxed">
        Or <span className="font-medium text-ink/70">highlight any text</span> inside a sentence to split it off
        and assign that piece to a different character — useful when a dialogue tag got lumped in with the spoken line.
      </p>
    </div>
  );
  const c  = findChar(seg.characterId);
  if (!c) return null;
  const cc = CHAR_COLORS[c.color as CharColor] ?? CHAR_COLORS.narrator;
  const minConf = Math.min(...seg.sentences.map(s => s.confidence ?? 1));
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
      <div className="p-5 pb-0 flex items-center gap-3">
        <span className="w-1 h-8 rounded-full" style={{ background: cc.hex }}/>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Selected segment</p>
          <h3 className="text-base font-bold text-ink truncate">{c.name}</h3>
        </div>
        {onOpenProfile && (
          <button onClick={() => onOpenProfile(c.id)}
                  title={`Open ${c.name} profile`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold text-ink/70 hover:text-ink hover:bg-ink/[0.05]">
            <IconEye className="w-3.5 h-3.5"/> Profile
          </button>
        )}
        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-ink/5 text-ink/60"><IconClose className="w-4 h-4"/></button>
      </div>
      <div className="px-5 mt-4">
        <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Confidence</p>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-ink/10 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${minConf * 100}%`, background: minConf < 0.75 ? '#C58B2B' : cc.hex }}/>
          </div>
          <span className="text-sm font-semibold text-ink tabular-nums">{Math.round(minConf * 100)}%</span>
        </div>
      </div>
      <div className="px-5 mt-5">
        <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Reassign whole segment to</p>
        <div className="flex flex-col gap-1">
          {characters.map(cand => {
            const active = cand.id === seg.characterId;
            const candCc = CHAR_COLORS[cand.color as CharColor] ?? CHAR_COLORS.narrator;
            return (
              <button key={cand.id} onClick={() => onReassignSegment(seg, cand.id)}
                      className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${active ? '' : 'hover:bg-ink/[0.03]'}`}
                      style={active ? { background: candCc.tint, boxShadow: `inset 0 0 0 1px ${candCc.ring}` } : undefined}>
                {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: candCc.hex }}/>}
                <ColorDot color={cand.color as CharColor}/>
                <span className={`text-sm flex-1 ${active ? 'font-bold' : 'text-ink'}`}
                      style={active ? { color: candCc.hex } : undefined}>
                  {cand.name}
                </span>
                {active && <IconCheck className="w-4 h-4" style={{ color: candCc.hex }}/>}
              </button>
            );
          })}
        </div>
      </div>
      {seg.sentences.length > 1 && (
        <div className="px-5 mt-5">
          <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Per-sentence reassign</p>
          <ul className="space-y-2">
            {seg.sentences.map(s => (
              <li key={s.id} className="bg-canvas/60 rounded-xl p-3">
                <p className="text-xs text-ink/80 leading-snug line-clamp-3 font-serif">{s.text}</p>
                <details className="mt-2">
                  <summary className="text-[11px] text-ink/60 cursor-pointer hover:text-ink">Reassign just this one</summary>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {characters.map(cand => (
                      <button key={cand.id} onClick={() => onReassignSentence(s.id, cand.id)}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] ${cand.id === seg.characterId ? 'bg-ink/[0.06] text-ink/60' : 'bg-white border border-ink/10 hover:border-ink/30'}`}>
                        <ColorDot color={cand.color as CharColor} size={8}/>
                        <span>{cand.name}</span>
                      </button>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="p-5 mt-4 border-t border-ink/10 text-xs text-ink/50 leading-relaxed space-y-1">
        <p><span className="font-semibold text-ink/70">Highlight text</span> inside any sentence to split it and assign that piece elsewhere.</p>
        <p><span className="font-semibold text-ink/70">Drag a boundary</span> onto a sentence to move the whole-paragraph cut.</p>
      </div>
    </div>
  );
}

/* ── Selection-based split popover ─────────────────────────────────────── */

interface SelectionInfo {
  sentenceId: number;
  start: number;
  end: number;
  rect: DOMRect;
}

function useSentenceSelection(containerRef: RefObject<HTMLElement | null>): SelectionInfo | null {
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  useEffect(() => {
    const handler = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) { setSel(null); return; }
      const range = s.getRangeAt(0);
      const startEl = (range.startContainer.parentElement)?.closest('[data-sentence-id]') as HTMLElement | null;
      const endEl   = (range.endContainer.parentElement)?.closest('[data-sentence-id]')   as HTMLElement | null;
      if (!startEl || startEl !== endEl) { setSel(null); return; }
      if (containerRef.current && !containerRef.current.contains(startEl)) { setSel(null); return; }
      const sentenceId = Number(startEl.getAttribute('data-sentence-id'));
      if (!Number.isFinite(sentenceId)) { setSel(null); return; }
      const start = range.startOffset;
      const end   = range.endOffset;
      if (start === end) { setSel(null); return; }
      const rect = range.getBoundingClientRect();
      setSel({ sentenceId, start: Math.min(start, end), end: Math.max(start, end), rect });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [containerRef]);
  return sel;
}

interface SelectionPopoverProps {
  sel: SelectionInfo | null;
  characters: Character[];
  onAssign: (characterId: string) => void;
}

function SelectionPopover({ sel, characters, onAssign }: SelectionPopoverProps) {
  if (!sel) return null;
  const top  = sel.rect.top - 8;
  const left = sel.rect.left + sel.rect.width / 2;
  return (
    <div style={{ position: 'fixed', top, left, transform: 'translate(-50%, -100%)', zIndex: 60 }}
         className="bg-white rounded-2xl border border-ink/10 shadow-card p-2 min-w-[200px]"
         /* preventDefault on mousedown keeps the text selection alive until
            we read it inside onAssign. */
         onMouseDown={(e) => e.preventDefault()}>
      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold px-2 pt-1">Assign selection to</p>
      <div className="flex flex-col gap-0.5 mt-1 max-h-64 overflow-y-auto">
        {characters.map(c => (
          <button key={c.id}
                  onMouseDown={(e) => { e.preventDefault(); onAssign(c.id); }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink/[0.04] text-left">
            <ColorDot color={c.color as CharColor}/>
            <span className="text-sm text-ink">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
