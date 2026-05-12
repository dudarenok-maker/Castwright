/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
function CharacterRegenerateModal({ character, chapters, defaultChapterId, onClose, onConfirm }) {
  /* scope: "this" | "selected" | "all" — controls which chapters are affected */
  const [scope, setScope] = useState(defaultChapterId ? "this" : "all");
  const [reason, setReason] = useState("voice");
  const [note, setNote] = useState("");

  if (!character) return null;
  const c = CHAR_COLORS[character.color];

  /* Chapters where this character has spoken lines (i.e. not "skipped") */
  const speakingChapters = chapters.filter(ch => ch.characters[character.id] && ch.characters[character.id] !== "skipped");

  /* Per-chapter selection state — defaults: all selected when scope=all,
     just defaultChapterId when scope=this */
  const [selected, setSelected] = useState(() => {
    const s = {};
    speakingChapters.forEach(ch => { s[ch.id] = true; });
    return s;
  });

  const targetChapterIds = (() => {
    if (scope === "this") return defaultChapterId ? [defaultChapterId] : [];
    if (scope === "selected") return Object.entries(selected).filter(([, v]) => v).map(([k]) => Number(k));
    return speakingChapters.map(ch => ch.id);
  })();

  /* Demo line counts per chapter for this character */
  const lineCount = (chId) => Math.round((character.lines / speakingChapters.length) * (0.7 + Math.random() * 0.6));
  const [lineCounts] = useState(() => {
    const m = {};
    let remaining = character.lines;
    speakingChapters.forEach((ch, i, arr) => {
      m[ch.id] = i === arr.length - 1 ? remaining : Math.round(character.lines / arr.length);
      remaining -= m[ch.id];
    });
    return m;
  });

  const totalLines = targetChapterIds.reduce((s, id) => s + (lineCounts[id] || 0), 0);
  const eta = totalLines > 0 ? `≈${Math.max(1, Math.round(totalLines / 60))} min` : "—";

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in"/>
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-xl pointer-events-auto fade-in overflow-hidden max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <Avatar name={character.name} color={character.color} size={40}/>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Regenerate character</p>
              <h3 className="text-base font-bold text-ink truncate">{character.name}'s lines</h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60"><IconClose className="w-4 h-4"/></button>
          </div>

          {/* Body */}
          <div className="p-6 space-y-6 overflow-y-auto">

            {/* Scope */}
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Which chapters?</p>
              <div className="grid grid-cols-3 gap-2">
                {defaultChapterId && (
                  <button onClick={()=>setScope("this")} className={`text-left p-3 rounded-2xl border transition-all ${scope === "this" ? "border-peach bg-peach/[0.06]" : "border-ink/10 hover:border-ink/20"}`}>
                    <p className="text-sm font-semibold text-ink">Just CH {String(defaultChapterId).padStart(2,"0")}</p>
                    <p className="text-xs text-ink/55 mt-0.5">{lineCounts[defaultChapterId] || 0} lines</p>
                  </button>
                )}
                <button onClick={()=>setScope("selected")} className={`text-left p-3 rounded-2xl border transition-all ${scope === "selected" ? "border-peach bg-peach/[0.06]" : "border-ink/10 hover:border-ink/20"}`}>
                  <p className="text-sm font-semibold text-ink">Pick chapters</p>
                  <p className="text-xs text-ink/55 mt-0.5">{Object.values(selected).filter(Boolean).length} selected</p>
                </button>
                <button onClick={()=>setScope("all")} className={`text-left p-3 rounded-2xl border transition-all ${scope === "all" ? "border-peach bg-peach/[0.06]" : "border-ink/10 hover:border-ink/20"}`}>
                  <p className="text-sm font-semibold text-ink">All ({speakingChapters.length})</p>
                  <p className="text-xs text-ink/55 mt-0.5">{character.lines} lines</p>
                </button>
              </div>

              {scope === "selected" && (
                <div className="mt-3 p-3 rounded-2xl bg-canvas border border-ink/10 max-h-64 overflow-y-auto">
                  {speakingChapters.map(ch => {
                    const isOn = !!selected[ch.id];
                    return (
                      <button key={ch.id} onClick={()=>setSelected({ ...selected, [ch.id]: !isOn })}
                        className="w-full grid grid-cols-[20px_60px_1fr_60px] items-center gap-3 px-2 py-2 rounded-lg hover:bg-white text-left">
                        <span className={`w-4 h-4 rounded-md grid place-items-center transition-colors ${isOn ? "bg-peach" : "bg-white border border-ink/20"}`}>
                          {isOn && <IconCheck className="w-2.5 h-2.5 text-white"/>}
                        </span>
                        <span className="text-[11px] tabular-nums font-bold text-ink/50">CH {String(ch.id).padStart(2,"0")}</span>
                        <span className="text-sm font-medium text-ink truncate">{ch.title}</span>
                        <span className="text-[11px] text-ink/55 tabular-nums text-right">{lineCounts[ch.id] || 0} lines</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Reason */}
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">What changed?</p>
              <div className="space-y-2">
                {REGEN_REASONS.map(r => (
                  <button key={r.id} onClick={()=>setReason(r.id)} className={`w-full text-left p-3 rounded-2xl border transition-all flex items-start gap-3 ${reason === r.id ? "border-peach bg-peach/[0.06]" : "border-ink/10 hover:border-ink/20"}`}>
                    <span className={`w-4 h-4 rounded-full border-2 grid place-items-center mt-0.5 shrink-0 ${reason === r.id ? "border-peach" : "border-ink/20"}`}>
                      {reason === r.id && <span className="w-1.5 h-1.5 rounded-full bg-peach"/>}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{r.label}</span>
                      <span className="block text-xs text-ink/60 mt-0.5 leading-relaxed">{r.description}</span>
                      {r.custom && reason === r.id && (
                        <input value={note} onChange={(e)=>setNote(e.target.value)} placeholder="What changed?" className="mt-2 w-full px-3 py-2 rounded-xl bg-white border border-ink/10 text-sm focus:outline-none focus:border-peach"/>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* Summary tile */}
            <div className="p-4 rounded-2xl border" style={{ borderColor: c.ring, background: c.tint }}>
              <div className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-full grid place-items-center" style={{ background: c.hex, color: "white" }}>
                  <IconRefresh className="w-4 h-4"/>
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs uppercase tracking-wider text-ink/50 font-semibold">Will regenerate</p>
                  <p className="text-sm font-bold text-ink"><span className="tabular-nums">{totalLines}</span> lines across <span className="tabular-nums">{targetChapterIds.length}</span> {targetChapterIds.length === 1 ? "chapter" : "chapters"}</p>
                </div>
                <span className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold">ETA</p>
                  <p className="text-sm font-bold text-ink tabular-nums">{eta}</p>
                </span>
              </div>
              <p className="mt-3 text-xs text-ink/60 leading-relaxed">Other characters in these chapters keep their existing audio. Only {character.name}'s lines are re-voiced.</p>
            </div>

          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">Cancel</button>
            <PrimaryButton variant="dark" onClick={()=>onConfirm({ characterId: character.id, chapterIds: targetChapterIds, reason, note })}>
              Regenerate {character.name.split(" ")[0]}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { CharacterRegenerateModal });
