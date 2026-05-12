import { useState } from 'react';
import { IconUpload } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { VoiceCard } from '../components/voice-library-panel';
import type { Voice } from '../lib/types';

type Tab = 'all' | 'current' | 'library';

interface Props { library: Voice[]; }

export function LibraryView({ library }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const filtered = library.filter(v => tab === 'all' || v.source === tab);
  const books = [...new Set(library.map(v => v.bookTitle))];

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all',     label: `All (${library.length})` },
    { id: 'current', label: `This book (${library.filter(v => v.source === 'current').length})` },
    { id: 'library', label: `Series & older (${library.filter(v => v.source === 'library').length})` },
  ];

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Voice library</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Every voice you've" bold="ever generated" level="h1"/>
          </div>
          <p className="mt-3 text-ink/60 max-w-2xl">Voices are kept across books in a series, so a character who appears in book one can carry the same voice into book seven. Drag any voice onto a character on the Cast page to reuse it.</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"><IconUpload className="w-4 h-4"/>Import voice</button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Voices"    value={library.length}/>
        <StatTile label="Books"     value={books.length}/>
        <StatTile label="Reused"    value={library.filter(v => v.usedIn > 1).length}/>
        <StatTile label="This book" value={library.filter(v => v.source === 'current').length}/>
      </div>

      <div className="flex items-center gap-1 mb-6">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${tab === t.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}>{t.label}</button>
        ))}
      </div>

      <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 ${draggingVoiceId ? 'dragging-voice' : ''}`}>
        {filtered.map(v => (
          <div key={v.id} className="bg-white rounded-3xl border border-ink/10 shadow-card p-5">
            <VoiceCard voice={v} draggingVoiceId={draggingVoiceId} setDraggingVoiceId={setDraggingVoiceId} compact={false}/>
            <div className="mt-4 pt-4 border-t border-ink/10 flex items-center justify-between text-xs text-ink/60">
              <span>Used in <span className="font-semibold text-ink">{v.usedIn || 1}</span> {(v.usedIn || 1) === 1 ? 'book' : 'books'}</span>
              <button className="text-ink/70 font-medium hover:text-ink hover:underline">View details</button>
            </div>
          </div>
        ))}
      </div>
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
