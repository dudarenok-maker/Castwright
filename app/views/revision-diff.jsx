/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
function RevisionDiffPlayer({ revision, chapter, character, onClose, onAccept, onReject }) {
  const [selected, setSelected] = useState(() => {
    /* default: choose B (new) for every changed segment, A for unchanged */
    const m = {};
    revision.segments.forEach(s => { m[s.id] = s.changed ? "B" : "A"; });
    return m;
  });
  const [playing, setPlaying]   = useState(null); // { segId, version: "A"|"B" }
  const [autoCompare, setAutoCompare] = useState(false);

  if (!revision) return null;

  const c = CHAR_COLORS[character?.color || "narrator"];
  const totalChanged = revision.segments.filter(s => s.changed).length;
  const acceptedNew = revision.segments.filter(s => s.changed && selected[s.id] === "B").length;

  const acceptAllNew = () => setSelected(Object.fromEntries(revision.segments.map(s => [s.id, s.changed ? "B" : "A"])));
  const rejectAll    = () => setSelected(Object.fromEntries(revision.segments.map(s => [s.id, "A"])));

  return (
    <div className="fixed inset-0 z-50 bg-canvas overflow-y-auto fade-in">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur-md border-b border-ink/10">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center gap-4">
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60"><IconArrowLeft className="w-4 h-4"/></button>
          <span className="w-8 h-8 rounded-full bg-peach/20 grid place-items-center text-magenta"><IconAB className="w-4 h-4"/></span>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Revision review · A/B</p>
            <h1 className="text-base font-bold text-ink leading-tight truncate">CH {String(chapter.id).padStart(2,"0")} · {chapter.title}{character ? ` · ${character.name}` : ""}</h1>
          </div>
          <span className="text-xs text-ink/55 hidden md:inline-flex items-center gap-1.5"><IconClock className="w-3.5 h-3.5"/>Triggered {revision.triggeredAgo}</span>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60"><IconClose className="w-4 h-4"/></button>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        <main>

          {/* Top — A/B summary cards */}
          <section className="grid grid-cols-2 gap-4 mb-6">
            <ABCard label="A · Current" sub="Already in your audiobook" duration={revision.oldDuration} variant="current"/>
            <ABCard label="B · New draft" sub={revision.triggeredBy} duration={revision.newDuration} variant="new" character={character}/>
          </section>

          {/* Auto-compare toggle */}
          <section className="mb-6 flex items-center justify-between gap-3 p-4 rounded-2xl bg-white border border-ink/10">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-ink text-canvas grid place-items-center"><IconAB className="w-4 h-4"/></span>
              <div>
                <p className="text-sm font-bold text-ink">Auto-compare</p>
                <p className="text-xs text-ink/55">Plays each changed segment A then B in sequence.</p>
              </div>
            </div>
            <button onClick={()=>setAutoCompare(!autoCompare)} className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${autoCompare ? "bg-peach text-ink" : "bg-ink/[0.04] text-ink hover:bg-ink/[0.08]"}`}>
              {autoCompare ? <><IconPause className="w-3.5 h-3.5 inline mr-1"/> Stop</> : <><IconPlay className="w-3.5 h-3.5 inline mr-1"/> Listen back-to-back</>}
            </button>
          </section>

          {/* Per-segment diff */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>Per-segment review</SectionLabel>
              <span className="text-xs text-ink/50">{totalChanged} segments changed · {acceptedNew} taking B</span>
            </div>
            <div className="space-y-2">
              {revision.segments.map(seg => (
                <SegmentDiffRow
                  key={seg.id}
                  seg={seg}
                  charColor={c}
                  selectedVersion={selected[seg.id]}
                  onSelect={(v) => setSelected({ ...selected, [seg.id]: v })}
                  playing={playing}
                  onPlay={(version) => setPlaying({ segId: seg.id, version })}
                />
              ))}
            </div>
          </section>
        </main>

        <aside className="self-start sticky top-24 space-y-4">

          {/* Confidence + summary */}
          <div className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Confidence</p>
            <p className="text-4xl font-bold text-ink tabular-nums leading-none">{Math.round(revision.confidence*100)}<span className="text-xl text-ink/50">%</span></p>
            <p className="mt-2 text-xs text-ink/60 leading-relaxed">The new take aligns closely with {character?.name}'s voice profile. No anomalies detected.</p>

            <hr className="my-4 border-ink/10"/>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between"><dt className="text-ink/55 text-xs">Old duration</dt><dd className="font-bold text-ink tabular-nums">{revision.oldDuration}</dd></div>
              <div className="flex items-center justify-between"><dt className="text-ink/55 text-xs">New duration</dt><dd className="font-bold text-ink tabular-nums">{revision.newDuration}</dd></div>
              <div className="flex items-center justify-between"><dt className="text-ink/55 text-xs">Segments changed</dt><dd className="font-bold text-ink tabular-nums">{totalChanged} of {revision.segments.length}</dd></div>
            </dl>
          </div>

          {/* Quick actions */}
          <div className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card space-y-2">
            <button onClick={acceptAllNew} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-sm font-semibold transition-colors">
              <IconChecks className="w-4 h-4"/> Accept all changes
            </button>
            <button onClick={rejectAll} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-rose-50 hover:bg-rose-100 text-rose-700 text-sm font-semibold transition-colors">
              <IconReject className="w-4 h-4"/> Reject all changes
            </button>
          </div>
        </aside>
      </div>

      {/* Bottom action bar */}
      <footer className="sticky bottom-0 bg-white border-t border-ink/10">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-3">
          <span className="text-sm">
            <span className="font-bold text-ink tabular-nums">{acceptedNew}</span> <span className="text-ink/60">of <span className="tabular-nums">{totalChanged}</span> changed segments taking the new take</span>
          </span>
          <span className="ml-auto flex items-center gap-3">
            <button onClick={onReject} className="px-4 py-2.5 text-sm font-medium text-ink/70 hover:text-ink">Reject draft</button>
            <PrimaryButton variant="dark" onClick={()=>onAccept(selected)}>Commit selection</PrimaryButton>
          </span>
        </div>
      </footer>
    </div>
  );
}

function ABCard({ label, sub, duration, variant, character }) {
  const isNew = variant === "new";
  const c = character ? CHAR_COLORS[character.color] : null;
  return (
    <div className={`rounded-3xl border p-5 transition-all ${isNew ? "border-peach bg-peach/[0.06]" : "border-ink/10 bg-white"} shadow-card`}>
      <div className="flex items-center justify-between mb-3">
        <p className={`text-[11px] uppercase tracking-wider font-bold ${isNew ? "text-magenta" : "text-ink/55"}`}>{label}</p>
        {isNew && <Pill color="peach">Draft</Pill>}
      </div>
      <p className="text-xs text-ink/60 leading-relaxed mb-4">{sub}</p>
      <div className="flex items-center gap-3 mb-3">
        <button className={`w-12 h-12 rounded-full grid place-items-center transition-colors ${isNew ? "bg-ink text-canvas hover:bg-ink-soft" : "bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas"}`}>
          <IconPlay className="w-5 h-5 ml-0.5"/>
        </button>
        <Waveform progress={0} active={false}/>
        <span className="text-sm tabular-nums text-ink/70 ml-auto">{duration}</span>
      </div>
      {c && isNew && (
        <p className="text-[11px] text-magenta font-semibold inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: c.hex }}/>
          Voice: {character.name}
        </p>
      )}
    </div>
  );
}

function SegmentDiffRow({ seg, charColor, selectedVersion, onSelect, playing, onPlay }) {
  const isPlayingA = playing?.segId === seg.id && playing?.version === "A";
  const isPlayingB = playing?.segId === seg.id && playing?.version === "B";
  const isSelectedB = selectedVersion === "B";
  return (
    <div className={`p-4 rounded-2xl border transition-all ${seg.changed ? (isSelectedB ? "border-peach bg-peach/[0.04]" : "border-ink/10 bg-white") : "border-ink/5 bg-canvas/60"}`}>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 w-1 h-6 rounded-full shrink-0" style={{ background: seg.narratorOnly ? CHAR_COLORS.narrator.hex : charColor.hex }}/>
        <div className="flex-1 min-w-0">
          <p className="font-serif text-[15px] text-ink/90 leading-relaxed mb-3">{seg.text}</p>

          {seg.narratorOnly ? (
            <Pill>Narrator-only · unchanged</Pill>
          ) : seg.changed ? (
            <div className="grid grid-cols-2 gap-2">
              {/* A version */}
              <button onClick={()=>{ onSelect("A"); onPlay("A"); }}
                className={`group flex items-center gap-2 p-2 rounded-xl transition-all border text-left ${selectedVersion === "A" ? "border-ink bg-ink/[0.04]" : "border-ink/10 hover:border-ink/20"}`}>
                <span className={`w-7 h-7 rounded-full grid place-items-center transition-colors ${isPlayingA ? "bg-ink text-canvas" : "bg-white border border-ink/15 text-ink/60 group-hover:text-ink"}`}>
                  {isPlayingA ? <IconPause className="w-3 h-3"/> : <IconPlay className="w-3 h-3 ml-0.5"/>}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] uppercase tracking-wider font-bold text-ink/50">A · current</span>
                  <span className="block text-[11px] tabular-nums text-ink/60">{seg.oldDuration}</span>
                </span>
                {selectedVersion === "A" && <span className="w-3.5 h-3.5 rounded-full bg-ink text-canvas grid place-items-center"><IconCheck className="w-2 h-2"/></span>}
              </button>

              {/* B version */}
              <button onClick={()=>{ onSelect("B"); onPlay("B"); }}
                className={`group flex items-center gap-2 p-2 rounded-xl transition-all border text-left ${selectedVersion === "B" ? "border-peach bg-peach/[0.10]" : "border-ink/10 hover:border-ink/20"}`}>
                <span className={`w-7 h-7 rounded-full grid place-items-center transition-colors ${isPlayingB ? "bg-magenta text-white" : "bg-white border border-ink/15 text-ink/60 group-hover:text-magenta"}`}>
                  {isPlayingB ? <IconPause className="w-3 h-3"/> : <IconPlay className="w-3 h-3 ml-0.5"/>}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] uppercase tracking-wider font-bold text-magenta">B · new</span>
                  <span className="block text-[11px] tabular-nums text-ink/60">{seg.newDuration}{seg.newDuration !== seg.oldDuration ? ` (${seg.newDuration > seg.oldDuration ? "+" : ""}${parseFloat(seg.newDuration) - parseFloat(seg.oldDuration)}s)` : ""}</span>
                </span>
                {selectedVersion === "B" && <span className="w-3.5 h-3.5 rounded-full bg-peach text-ink grid place-items-center"><IconCheck className="w-2 h-2"/></span>}
              </button>
            </div>
          ) : (
            <Pill>Unchanged</Pill>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RevisionDiffPlayer, ABCard, SegmentDiffRow });
