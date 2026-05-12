import { useState } from 'react';
import { IconStar } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { VoiceCard } from '../components/voice-library-panel';
import type { TtsModelKey, Voice } from '../lib/types';
import { TTS_MODEL_OPTIONS } from '../lib/tts-models';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { voicesActions } from '../store/voices-slice';
import { api } from '../lib/api';

type Tab = 'all' | 'current' | 'library';

interface Props { library: Voice[]; }

export function LibraryView({ library }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const dispatch = useAppDispatch();
  const ttsModelKey = useAppSelector(s => s.ui.ttsModelKey);
  const filtered = library.filter(v => tab === 'all' || v.source === tab);
  const books = [...new Set(library.map(v => v.bookTitle))];

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
          <label className="inline-flex items-center gap-2 text-xs text-ink/60">
            <span className="font-medium">TTS model</span>
            <select
              value={ttsModelKey}
              onChange={(e) => dispatch(uiActions.setTtsModelKey(e.target.value as TtsModelKey))}
              className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/[0.04] focus:outline-none focus:ring-2 focus:ring-magenta/30"
            >
              {TTS_MODEL_OPTIONS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
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
        <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 ${draggingVoiceId ? 'dragging-voice' : ''}`}>
          {filtered.map(v => (
            <div key={v.id} className="bg-white rounded-3xl border border-ink/10 shadow-card p-5 relative">
              <button
                onClick={() => togglePin(v)}
                aria-label={v.pinned ? 'Unpin voice' : 'Pin voice'}
                className={`absolute top-4 right-4 w-8 h-8 grid place-items-center rounded-full transition-colors ${v.pinned ? 'bg-peach text-ink' : 'bg-ink/[0.04] text-ink/40 hover:text-ink hover:bg-ink/[0.08]'}`}
              >
                <IconStar className="w-4 h-4"/>
              </button>
              <VoiceCard voice={v} draggingVoiceId={draggingVoiceId} setDraggingVoiceId={setDraggingVoiceId} compact={false}/>
              <div className="mt-4 pt-4 border-t border-ink/10 flex items-center justify-between text-xs text-ink/60">
                <span>Used in <span className="font-semibold text-ink">{v.usedIn || 1}</span> {(v.usedIn || 1) === 1 ? 'book' : 'books'}</span>
                <span className="text-ink/40 truncate ml-3">{v.bookTitle}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
