/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
function BookLibraryView({ books, activeBookId, onOpenBook, onStartNew }) {
  const [filter, setFilter] = useState("all");
  const filtered = books.filter(b => {
    if (filter === "all") return true;
    if (filter === "in_progress") return b.status === "generating" || b.status === "analysing" || b.status === "cast_pending";
    if (filter === "complete") return b.status === "complete";
    return true;
  });
  const totals = {
    books: books.length,
    runtime: books.reduce((s,b) => s + (b.runtime ? parseRuntime(b.runtime) : 0), 0),
    voices: books.reduce((s,b) => s + (b.voiceCount || 0), 0),
    inProgress: books.filter(b => b.status !== "complete").length,
  };
  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      {/* HEADER */}
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Your audiobooks</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Welcome back," bold="Mike" level="h1"/>
          </div>
          <p className="mt-3 text-ink/60 max-w-xl">Pick up where you left off, or start a new book. Voices stay consistent across a series — characters who appear in book one carry through to book seven.</p>
        </div>
        <PrimaryButton variant="dark" onClick={onStartNew}>
          <span className="inline-flex items-center gap-2"><IconPlus className="w-4 h-4"/>Start a new book</span>
        </PrimaryButton>
      </div>

      {/* TOTALS */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Books"        value={totals.books}/>
        <StatTile label="Total runtime" value={formatHours(totals.runtime)}/>
        <StatTile label="Voices"       value={totals.voices}/>
        <StatTile label="In progress"  value={totals.inProgress}/>
      </div>

      {/* FILTERS */}
      <div className="flex items-center gap-1 mb-6">
        {[
          { id: "all",          label: `All (${books.length})` },
          { id: "in_progress",  label: `In progress (${books.filter(b => b.status !== "complete").length})` },
          { id: "complete",     label: `Complete (${books.filter(b => b.status === "complete").length})` },
        ].map(f => (
          <button key={f.id} onClick={()=>setFilter(f.id)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === f.id ? "bg-ink text-canvas" : "text-ink/60 hover:text-ink hover:bg-ink/[0.04]"}`}>{f.label}</button>
        ))}
      </div>

      {/* BOOK GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filtered.map(b => <BookCard key={b.id} book={b} active={b.id === activeBookId} onOpen={()=>onOpenBook(b)}/>)}
        <NewBookCard onStartNew={onStartNew}/>
      </div>
    </div>
  );
}

function parseRuntime(s) {
  /* "11h 24m" → minutes */
  const m = s.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
  if (!m) return 0;
  return (parseInt(m[1]||"0") * 60) + parseInt(m[2]||"0");
}
function formatHours(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function BookCard({ book, active, onOpen }) {
  const [from, to] = book.coverGradient;
  const grad = `linear-gradient(135deg, ${from}, ${to})`;
  const statusUI = {
    analysing:    { color: "purple",  label: "Analysing",            icon: <IconSpinner className="w-3.5 h-3.5"/> },
    cast_pending: { color: "warning", label: "Cast confirmation",    icon: <IconCheckCircle className="w-3.5 h-3.5"/> },
    generating:   { color: "peach",   label: "Generating",            icon: <IconSpinner className="w-3.5 h-3.5"/> },
    complete:     { color: "success", label: "Complete",              icon: <IconCheck className="w-3.5 h-3.5"/> },
    failed:       { color: "danger",  label: "Failed",                icon: <IconWarning className="w-3.5 h-3.5"/> },
  }[book.status];
  return (
    <article onClick={onOpen} className={`group relative bg-white rounded-3xl border shadow-card hover:shadow-float transition-all cursor-pointer overflow-hidden ${active ? "border-peach ring-1 ring-peach/30" : "border-ink/10 hover:border-ink/20"}`}>
      {/* COVER */}
      <div className="aspect-[16/10] relative overflow-hidden" style={{ background: grad }}>
        <svg viewBox="0 0 320 200" className="absolute inset-0 w-full h-full opacity-20">
          <circle cx="60" cy="100" r="80" fill="none" stroke="white" strokeWidth="0.5"/>
          <circle cx="60" cy="100" r="60" fill="none" stroke="white" strokeWidth="0.5"/>
          <circle cx="60" cy="100" r="40" fill="none" stroke="white" strokeWidth="0.5"/>
        </svg>
        <div className="absolute top-4 left-4 right-4 flex items-center justify-between">
          <p className="text-[9px] uppercase tracking-[0.2em] text-white/70 font-semibold">Audiobook</p>
          {book.pinned && <IconStar className="w-3.5 h-3.5 text-white/80"/>}
        </div>
        <div className="absolute bottom-4 left-4 right-4">
          <h3 className="font-serif text-2xl font-bold text-white leading-tight">{book.title}</h3>
          <p className="text-[10px] text-white/70 mt-1">{book.series}</p>
        </div>
        {active && (
          <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-peach text-ink text-[10px] font-bold uppercase tracking-wider">Open</span>
        )}
      </div>

      {/* META */}
      <div className="p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <Pill color={statusUI.color}><span className="inline-flex items-center gap-1.5">{statusUI.icon}{statusUI.label}</span></Pill>
          <span className="text-[11px] text-ink/50">{book.lastWorkedOn}</span>
        </div>

        {book.status === "generating" && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[11px] text-ink/60 mb-1.5">
              <span>{book.completedChapters} of {book.chapterCount} chapters</span>
              <span className="tabular-nums font-bold text-ink">{Math.round(book.progress*100)}%</span>
            </div>
            <div className="h-1 rounded-full bg-ink/[0.06] overflow-hidden">
              <div className="h-full bg-gradient-progress rounded-full" style={{ width: `${book.progress*100}%` }}/>
            </div>
          </div>
        )}
        {book.status === "analysing" && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[11px] text-ink/60 mb-1.5">
              <span>Reading manuscript…</span>
              <span className="tabular-nums font-bold text-ink">{Math.round(book.progress*100)}%</span>
            </div>
            <div className="h-1 rounded-full bg-ink/[0.06] overflow-hidden">
              <div className="h-full bg-gradient-progress rounded-full pulse-bar" style={{ width: `${book.progress*100}%` }}>
                <div className="absolute inset-0 stripe-travel"/>
              </div>
            </div>
          </div>
        )}
        {book.status === "cast_pending" && book.matchedFromLibrary > 0 && (
          <p className="mb-3 text-xs text-purple-deep/80 leading-relaxed">
            <span className="font-semibold">{book.matchedFromLibrary} of {book.characterCount}</span> characters matched from your library — review and confirm.
          </p>
        )}
        {book.status === "complete" && (
          <p className="mb-3 text-xs text-emerald-700 leading-relaxed">
            <span className="font-semibold">{book.runtime}</span> · ready to listen and share.
          </p>
        )}

        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-3 text-center pt-3 border-t border-ink/5">
          <Stat label="Chapters" value={book.chapterCount ?? "—"}/>
          <Stat label="Voices"   value={book.voiceCount ?? "—"}/>
          <Stat label="Runtime"  value={book.runtime ?? "—"} small/>
        </div>
      </div>
    </article>
  );
}

function NewBookCard({ onStartNew }) {
  return (
    <button onClick={onStartNew} className="group bg-canvas rounded-3xl border-2 border-dashed border-ink/15 hover:border-peach hover:bg-peach/[0.04] transition-all min-h-[420px] grid place-items-center text-center p-8">
      <div>
        <span className="w-14 h-14 mx-auto rounded-full bg-white border border-ink/10 grid place-items-center group-hover:bg-peach group-hover:border-peach group-hover:text-white transition-colors text-ink">
          <IconPlus className="w-6 h-6"/>
        </span>
        <p className="mt-4 text-base font-bold text-ink">Start a new book</p>
        <p className="mt-1 text-xs text-ink/55 max-w-[220px] mx-auto leading-relaxed">Drop in a manuscript and we'll meet your cast within a couple of minutes.</p>
      </div>
    </button>
  );
}

/* Local Stat with both label and value (for book card) */
/* (uses existing Stat component if compatible — local override) */

Object.assign(window, { BookLibraryView, BookCard, NewBookCard });
