import { useMemo, useState } from 'react';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { VoiceCard } from '../components/voice-library-panel';
import type { TtsModelKey, Voice } from '../lib/types';
import {
  TTS_ENGINES,
  engineGroupForModelKey,
  type TtsEngineId,
} from '../lib/tts-models';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { voicesActions } from '../store/voices-slice';
import { api } from '../lib/api';

type Tab = 'all' | 'current' | 'library';

interface Props { library: Voice[]; }

interface BookGroup {
  bookId: string;
  bookTitle: string;
  source: Voice['source'];
  voices: Voice[];
}

export function LibraryView({ library }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const dispatch = useAppDispatch();
  const ttsModelKey = useAppSelector(s => s.ui.ttsModelKey);
  const characters = useAppSelector(s => s.cast.characters);
  const sentences = useAppSelector(s => s.manuscript.sentences);
  const filtered = library.filter(v => tab === 'all' || v.source === tab);
  const books = [...new Set(library.map(v => v.bookId))];

  /* Line count per voiceId for the currently-loaded book. Prefer the
     analysis-supplied `Character.lines`; fall back to counting sentences when
     the analyser hasn't stamped a count (older cached analyses). Library
     voices that don't belong to the currently-open book aren't covered here —
     they sort by `usedIn` instead, since their per-book line counts live on
     the server and aren't shipped in the voice payload. */
  const linesByVoiceId = useMemo(() => {
    const counts = new Map<string, number>();
    const sentenceCounts = new Map<string, number>();
    for (const s of sentences) {
      sentenceCounts.set(s.characterId, (sentenceCounts.get(s.characterId) ?? 0) + 1);
    }
    for (const c of characters) {
      const voiceId = c.voiceId ?? c.id;
      const fromAnalysis = typeof c.lines === 'number' ? c.lines : undefined;
      const fromSentences = sentenceCounts.get(c.id) ?? 0;
      counts.set(voiceId, fromAnalysis ?? fromSentences);
    }
    return counts;
  }, [characters, sentences]);

  const groups: BookGroup[] = useMemo(() => {
    const byId = new Map<string, BookGroup>();
    for (const v of filtered) {
      const existing = byId.get(v.bookId);
      if (existing) existing.voices.push(v);
      else byId.set(v.bookId, { bookId: v.bookId, bookTitle: v.bookTitle, source: v.source, voices: [v] });
    }
    const ordered = [...byId.values()].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'current' ? -1 : 1;
      return a.bookTitle.localeCompare(b.bookTitle);
    });
    for (const g of ordered) {
      g.voices.sort((a, b) => {
        const al = linesByVoiceId.get(a.id);
        const bl = linesByVoiceId.get(b.id);
        if (al !== undefined && bl !== undefined && al !== bl) return bl - al;
        if (al !== undefined && bl === undefined) return -1;
        if (al === undefined && bl !== undefined) return 1;
        if (a.usedIn !== b.usedIn) return b.usedIn - a.usedIn;
        return a.character.localeCompare(b.character);
      });
    }
    return ordered;
  }, [filtered, linesByVoiceId]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all',     label: `All (${library.length})` },
    { id: 'current', label: `This book (${library.filter(v => v.source === 'current').length})` },
    { id: 'library', label: `Series & older (${library.filter(v => v.source === 'library').length})` },
  ];

  function togglePin(voice: Voice) {
    const next = !voice.pinned;
    dispatch(voicesActions.setPinned({ voiceId: voice.id, pinned: next }));
    api.setVoicePin(voice.id, next).catch(err => {
      console.error('[voices] pin failed', err);
      dispatch(voicesActions.setPinned({ voiceId: voice.id, pinned: !next }));
    });
  }

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Voice library</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Every voice you've" bold="ever generated" level="h1"/>
          </div>
          <p className="mt-3 text-ink/60 max-w-2xl">Voices come from confirmed casts. Every character in a book you've finished setting up joins your library, ready to be reused in the next one. Drag any voice onto a character on the Cast page to carry it across.</p>
        </div>
        <div className="flex items-center gap-3">
          <TtsEngineModelPicker
            modelKey={ttsModelKey}
            onChange={(next) => dispatch(uiActions.setTtsModelKey(next))}
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Voices"    value={library.length}/>
        <StatTile label="Books"     value={books.length}/>
        <StatTile label="Reused"    value={library.filter(v => v.usedIn > 1).length}/>
        <StatTile label="Pinned"    value={library.filter(v => v.pinned).length}/>
      </div>

      <div className="flex items-center gap-1 mb-6">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${tab === t.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}>{t.label}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
          <p className="text-sm font-bold text-ink">No voices yet</p>
          <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">Finish setting up a book — once you confirm its cast, every character will appear here as a reusable voice.</p>
        </div>
      ) : (
        <div className={`space-y-8 ${draggingVoiceId ? 'dragging-voice' : ''}`}>
          {groups.map(g => (
            <section key={g.bookId} aria-label={g.bookTitle}>
              <header className="mb-3 flex items-baseline justify-between gap-3 flex-wrap">
                <div className="flex items-baseline gap-3 min-w-0">
                  <h2 className="text-lg font-bold text-ink truncate">{g.bookTitle}</h2>
                  <span className="text-xs text-ink/50 shrink-0">
                    {g.voices.length} {g.voices.length === 1 ? 'voice' : 'voices'}
                  </span>
                </div>
                <span className={`text-[11px] uppercase tracking-wider font-semibold ${g.source === 'current' ? 'text-magenta' : 'text-ink/40'}`}>
                  {g.source === 'current' ? 'This book' : 'Series & older'}
                </span>
              </header>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {g.voices.map(v => (
                  <VoiceCard
                    key={v.id}
                    voice={v}
                    draggingVoiceId={draggingVoiceId}
                    setDraggingVoiceId={setDraggingVoiceId}
                    compact={false}
                    showBookTitle={false}
                    pinned={!!v.pinned}
                    onTogglePin={togglePin}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/* Engine + model dropdowns. Switching engine resets the model to the engine
   group's first option so the selection never lands on a Gemini model while
   the engine reads "Local" (and vice versa). */
interface TtsEngineModelPickerProps {
  modelKey: TtsModelKey;
  onChange: (next: TtsModelKey) => void;
}
function TtsEngineModelPicker({ modelKey, onChange }: TtsEngineModelPickerProps) {
  const currentEngine = engineGroupForModelKey(modelKey);
  const engineGroup = TTS_ENGINES.find(g => g.id === currentEngine) ?? TTS_ENGINES[0];
  return (
    <>
      <label className="inline-flex items-center gap-2 text-xs text-ink/60">
        <span className="font-medium">Engine</span>
        <select
          value={currentEngine}
          onChange={(e) => {
            const nextGroup = TTS_ENGINES.find(g => g.id === (e.target.value as TtsEngineId));
            if (!nextGroup) return;
            onChange(nextGroup.models[0].id);
          }}
          className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/[0.04] focus:outline-none focus:ring-2 focus:ring-magenta/30"
          title={engineGroup.hint}
        >
          {TTS_ENGINES.map(g => (
            <option key={g.id} value={g.id}>{g.label}</option>
          ))}
        </select>
      </label>
      <label className="inline-flex items-center gap-2 text-xs text-ink/60">
        <span className="font-medium">Model</span>
        <select
          value={modelKey}
          onChange={(e) => onChange(e.target.value as TtsModelKey)}
          className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/[0.04] focus:outline-none focus:ring-2 focus:ring-magenta/30"
        >
          {engineGroup.models.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </label>
    </>
  );
}

export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white rounded-2xl border border-ink/10 p-4">
      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-ink tabular-nums mt-1">{value}</p>
    </div>
  );
}
