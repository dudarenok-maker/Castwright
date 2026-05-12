/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
function ManuscriptView({ characters, chapters, currentChapterId, setCurrentChapterId, onStartGenerating, sentencesFromStore }) {
  const [sentences, setSentences] = useState(sentencesFromStore || initialSentences);
  const [selectedSeg, setSelectedSeg] = useState(null);
  const [filterChar, setFilterChar] = useState(null);
  const [drag, setDrag] = useState(null);
  const currentChapter = chapters.find(c => c.id === currentChapterId) || chapters[0];
  const currentIdx = chapters.findIndex(c => c.id === currentChapterId);
  const prevChapter = chapters[currentIdx - 1];
  const nextChapter = chapters[currentIdx + 1];
  /* drag = { boundaryIdx, anchorY, candidateSentenceIdx, direction }
     boundaryIdx is the index in the segments array; candidateSentenceIdx is
     the absolute sentence index in `sentences` to which we're moving the boundary. */
  const containerRef = useRef(null);

  /* Group consecutive same-char sentences into segments */
  const segments = useMemo(() => {
    const segs = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const last = segs[segs.length - 1];
      if (last && last.charId === s.charId) last.sentences.push({ ...s, absIdx: i });
      else segs.push({ id: `seg_${segs.length}`, charId: s.charId, sentences: [{ ...s, absIdx: i }] });
    }
    return segs;
  }, [sentences]);

  const counts = useMemo(() => {
    const m = {};
    for (const s of sentences) m[s.charId] = (m[s.charId] || 0) + 1;
    return m;
  }, [sentences]);

  const findChar = useCallback((id) => characters.find(c => c.id === id), [characters]);

  /* === Boundary drag === */
  const onBoundaryMouseDown = (boundaryIdx, e) => {
    e.preventDefault();
    setDrag({ boundaryIdx, anchorY: e.clientY, candidateSentenceIdx: null });
    document.body.classList.add("dragging-boundary");
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const sentenceEl = el?.closest?.("[data-sentence-idx]");
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
      document.body.classList.remove("dragging-boundary");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag?.boundaryIdx]);

  function commitBoundaryMove(d) {
    /* Find the sentence index of the original boundary. The boundary at index B is
       between segments[B-1] and segments[B]. The first sentence of segments[B] is the
       boundary's "anchor sentence". Moving boundary up = relabel sentences from the
       new candidate to the anchor (exclusive) with the previous segment's charId.
       Moving down = relabel from the anchor forward to the candidate (inclusive)
       with the previous segment's charId.  */
    const segAbove = segments[d.boundaryIdx - 1];
    const segBelow = segments[d.boundaryIdx];
    if (!segAbove || !segBelow) return;
    const anchorIdx = segBelow.sentences[0].absIdx;
    const candIdx = d.candidateSentenceIdx;

    setSentences(prev => prev.map((s, i) => {
      if (candIdx < anchorIdx) {
        /* boundary moves up — sentences candIdx..anchorIdx-1 take segBelow.charId */
        if (i >= candIdx && i < anchorIdx) return { ...s, charId: segBelow.charId };
      } else if (candIdx >= anchorIdx) {
        /* boundary moves down — sentences anchorIdx..candIdx take segAbove.charId */
        if (i >= anchorIdx && i <= candIdx) return { ...s, charId: segAbove.charId };
      }
      return s;
    }));
  }

  /* Reassign a single sentence to a different character */
  function reassignSentence(absIdx, newCharId) {
    setSentences(prev => prev.map((s, i) => i === absIdx ? { ...s, charId: newCharId } : s));
  }

  return (
    <div className="max-w-[1500px] mx-auto px-6 py-8 grid grid-cols-[280px_1fr_360px] gap-6" ref={containerRef}>

      {/* LEFT — CHAPTERS + DETECTED CHARACTERS */}
      <div className="self-start sticky top-24 space-y-4 max-h-[calc(100vh-100px)] overflow-y-auto pr-1">

        {/* Chapters */}
        <aside className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-ink">Chapters</h2>
            <span className="text-xs text-ink/50">{chapters.length}</span>
          </div>
          <ul className="space-y-0.5">
            {chapters.map(ch => {
              const active = currentChapterId === ch.id;
              return (
                <li key={ch.id}>
                  <button onClick={() => setCurrentChapterId(ch.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors relative ${active ? "bg-ink/[0.05]" : "hover:bg-ink/[0.03]"}`}>
                    {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-peach"/>}
                    <span className={`text-[11px] font-bold tabular-nums w-7 ${active ? "text-magenta" : "text-ink/40"}`}>CH {String(ch.id).padStart(2,"0")}</span>
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm truncate ${active ? "font-semibold text-ink" : "font-medium text-ink/80"}`}>{ch.title}</span>
                      <span className="block text-[11px] text-ink/50 tabular-nums">{ch.duration}</span>
                    </span>
                    {ch.state === "in_progress" && <IconSpinner className="w-3 h-3 text-magenta shrink-0"/>}
                    {ch.state === "done"        && <IconCheck    className="w-3 h-3 text-emerald-600 shrink-0"/>}
                    {ch.state === "failed"      && <IconWarning  className="w-3 h-3 text-rose-600 shrink-0"/>}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Characters */}
        <aside className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-ink">Detected</h2>
            <span className="text-xs text-ink/50">{characters.length}</span>
          </div>
          <ul className="space-y-1">
            {characters.map(c => {
              const active = filterChar === c.id;
              return (
                <li key={c.id}>
                  <button onClick={() => setFilterChar(active ? null : c.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${active ? "bg-ink/[0.05]" : "hover:bg-ink/[0.03]"}`}>
                    <ColorDot color={c.color} size={10}/>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-ink truncate">{c.name}</span>
                      <span className="block text-xs text-ink/50 truncate">{c.role}</span>
                    </span>
                    <span className="text-xs text-ink/50 tabular-nums">{counts[c.id] || 0}</span>
                  </button>
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
          </div>
        </aside>
      </div>

      {/* CENTRE — MANUSCRIPT */}
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
            <span className="text-amber-700">{sentences.filter(s => s.confidence && s.confidence < 0.75).length} low-confidence</span>
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
          <article className="font-serif text-[17px] leading-[1.8] text-ink/90">
            {segments.map((seg, segIdx) => (
              <React.Fragment key={seg.id}>
                <Segment
                  seg={seg}
                  characters={characters}
                  selected={selectedSeg === seg.id}
                  dimmed={filterChar && filterChar !== seg.charId}
                  drag={drag}
                  onSelect={() => setSelectedSeg(seg.id)}
                  onReassign={(absIdx, newCharId) => reassignSentence(absIdx, newCharId)}
                  findChar={findChar}
                />
                {segIdx < segments.length - 1 && (
                  <BoundaryHandle boundaryIdx={segIdx + 1} drag={drag} onMouseDown={onBoundaryMouseDown}/>
                )}
              </React.Fragment>
            ))}
          </article>
        </div>
      </main>

      {/* RIGHT — INSPECTOR */}
      <aside className="self-start sticky top-24">
        <SegmentInspector
          seg={segments.find(s => s.id === selectedSeg)}
          characters={characters}
          findChar={findChar}
          onClose={() => setSelectedSeg(null)}
          onReassignSegment={(seg, newCharId) => {
            setSentences(prev => prev.map((s, i) => seg.sentences.some(ss => ss.absIdx === i) ? { ...s, charId: newCharId } : s));
            setSelectedSeg(null);
          }}
        />
      </aside>
    </div>
  );
}

function Segment({ seg, characters, selected, dimmed, drag, onSelect, onReassign, findChar }) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const c = CHAR_COLORS[findChar(seg.charId)?.color || "narrator"];

  return (
    <div className={`group relative -mx-4 px-4 py-2 rounded-xl transition-all cursor-pointer ${dimmed ? "opacity-40" : ""} ${selected ? "ring-1 ring-peach/40" : "hover:bg-ink/[0.02]"}`}
         onMouseEnter={() => setHovered(true)}
         onMouseLeave={() => { setHovered(false); setMenuOpen(false); }}
         onClick={onSelect}>
      <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: c.hex }}/>
      <span className="absolute inset-0 rounded-xl pointer-events-none" style={{ background: c.tint }}/>
      <div className="relative">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: c.hex }}>
            {findChar(seg.charId)?.name}
          </span>
          {seg.sentences.some(s => s.confidence && s.confidence < 0.75) && (
            <Pill color="warning">Low confidence</Pill>
          )}
          <span className={`ml-auto flex items-center gap-1 transition-opacity ${hovered || selected ? "opacity-100" : "opacity-0"}`}>
            <div className="relative">
              <button onClick={(e)=>{e.stopPropagation(); setMenuOpen(!menuOpen);}} className="px-2 py-1 rounded-md bg-white border border-ink/10 text-[11px] font-medium text-ink/70 hover:text-ink hover:border-ink/30 inline-flex items-center gap-1">
                Reassign <IconArrowDn className="w-3 h-3"/>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-ink/10 rounded-xl shadow-card py-1 z-10" onClick={(e)=>e.stopPropagation()}>
                  {characters.map(cc => (
                    <button key={cc.id} onClick={()=>{ onReassign(seg.sentences[0].absIdx, cc.id); setMenuOpen(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-ink/[0.04] text-left text-sm">
                      <ColorDot color={cc.color}/><span className="flex-1">{cc.name}</span>
                      {cc.id === seg.charId && <IconCheck className="w-3.5 h-3.5 text-ink/60"/>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </span>
        </div>
        <div>
          {seg.sentences.map(s => {
            const isCandidate = drag && drag.candidateSentenceIdx === s.absIdx;
            return (
              <span key={s.id}
                data-sentence-idx={s.absIdx}
                className={`inline transition-colors ${isCandidate ? "sentence-candidate" : ""}`}>
                {s.text}{" "}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BoundaryHandle({ boundaryIdx, drag, onMouseDown }) {
  const isThisDragging = drag?.boundaryIdx === boundaryIdx;
  return (
    <div className="relative h-3 -my-1 group">
      <span
        onMouseDown={(e)=>onMouseDown(boundaryIdx, e)}
        className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] cursor-ns-resize transition-colors ${isThisDragging ? "bg-peach" : "bg-transparent group-hover:bg-peach/40"}`}/>
      <span className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2 py-0.5 rounded-full bg-white border text-[10px] font-medium uppercase tracking-wider transition-opacity ${isThisDragging ? "opacity-100 border-peach text-magenta pulse-ring" : "opacity-0 group-hover:opacity-100 border-ink/15 text-ink/50"}`}>
        {isThisDragging ? "drop on a sentence" : "drag to move"}
      </span>
    </div>
  );
}

function SegmentInspector({ seg, characters, findChar, onClose, onReassignSegment }) {
  if (!seg) return (
    <div className="bg-white rounded-3xl border border-dashed border-ink/15 p-6 text-sm text-ink/50">
      Select a paragraph to inspect or reassign all of it at once.
    </div>
  );
  const c  = findChar(seg.charId);
  const cc = CHAR_COLORS[c.color];
  const minConf = Math.min(...seg.sentences.map(s => s.confidence ?? 1));
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
      <div className="p-5 pb-0 flex items-center gap-3">
        <span className="w-1 h-8 rounded-full" style={{ background: cc.hex }}/>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Selected segment</p>
          <h3 className="text-base font-bold text-ink truncate">{c.name}</h3>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-ink/5 text-ink/60"><IconClose className="w-4 h-4"/></button>
      </div>
      <div className="px-5 mt-4">
        <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Confidence</p>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-ink/10 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${minConf*100}%`, background: minConf < 0.75 ? "#C58B2B" : cc.hex }}/>
          </div>
          <span className="text-sm font-semibold text-ink tabular-nums">{Math.round(minConf*100)}%</span>
        </div>
      </div>
      <div className="px-5 mt-5">
        <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Reassign whole segment to</p>
        <div className="flex flex-col gap-1">
          {characters.map(cand => (
            <button key={cand.id} onClick={()=>onReassignSegment(seg, cand.id)} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${cand.id === seg.charId ? "bg-ink/[0.04]" : "hover:bg-ink/[0.03]"}`}>
              <ColorDot color={cand.color}/>
              <span className="text-sm text-ink flex-1">{cand.name}</span>
              {cand.id === seg.charId && <IconCheck className="w-4 h-4 text-ink/70"/>}
            </button>
          ))}
        </div>
      </div>
      <div className="p-5 mt-4 border-t border-ink/10 text-xs text-ink/50 leading-relaxed">
        Tip: to split this segment further, drag the boundary line above or below it onto a sentence inside.
      </div>
    </div>
  );
}

Object.assign(window, { ManuscriptView, Segment, BoundaryHandle, SegmentInspector });
