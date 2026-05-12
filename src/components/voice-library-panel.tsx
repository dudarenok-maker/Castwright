import { useState } from 'react';
import { IconStar, IconDrag } from '../lib/icons';
import { VoiceSwatch, Pill } from './primitives';
import type { Voice } from '../lib/types';

type Tab = 'all' | 'current' | 'library';

interface VoiceLibraryPanelProps {
  library: Voice[];
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  compact?: boolean;
}

export function VoiceLibraryPanel({ library, draggingVoiceId, setDraggingVoiceId, compact = false }: VoiceLibraryPanelProps) {
  const [tab, setTab] = useState<Tab>('all');
  const filtered = library.filter(v => tab === 'all' || v.source === tab);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all',     label: 'All' },
    { id: 'current', label: 'This book' },
    { id: 'library', label: 'Series' },
  ];
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden flex flex-col max-h-[calc(100vh-120px)]">
      <div className="p-5 pb-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-ink">Voice library</h2>
          <span className="text-xs text-ink/50">{library.length} voices · 3 books</span>
        </div>
        <p className="text-xs text-ink/50 mb-3">Drag onto a character to reuse.</p>
        <div className="flex items-center gap-1 bg-ink/[0.04] rounded-full p-0.5 text-xs">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 px-2 py-1 rounded-full font-medium transition-colors ${tab === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="p-5 overflow-y-auto space-y-2">
        {filtered.map(v => (
          <VoiceCard key={v.id} voice={v} draggingVoiceId={draggingVoiceId} setDraggingVoiceId={setDraggingVoiceId} compact={compact}/>
        ))}
      </div>
    </div>
  );
}

interface VoiceCardProps {
  voice: Voice;
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  compact?: boolean;
}

export function VoiceCard({ voice, draggingVoiceId, setDraggingVoiceId, compact = false }: VoiceCardProps) {
  const isDragging = draggingVoiceId === voice.id;
  return (
    <div draggable
      onDragStart={(e) => { setDraggingVoiceId(voice.id); e.dataTransfer.effectAllowed = 'copy'; }}
      onDragEnd={() => setDraggingVoiceId(null)}
      className={`group flex items-start gap-3 p-3 rounded-2xl border bg-canvas hover:bg-white border-ink/10 cursor-grab active:cursor-grabbing transition-all ${isDragging ? 'opacity-40 scale-[0.98]' : ''}`}>
      <VoiceSwatch voice={voice} size="sm" showLabel={false}/>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-ink truncate">{voice.character}</p>
          {voice.source === 'library' && voice.usedIn > 1 && (
            <Pill color="library"><IconStar className="w-2.5 h-2.5 mr-0.5"/>×{voice.usedIn}</Pill>
          )}
        </div>
        <p className="text-[11px] text-ink/60 truncate">{voice.bookTitle}</p>
        {voice.ttsVoice && (
          <p
            title={`Prebuilt ${voice.ttsVoice.provider} voice — ${voice.ttsVoice.description}`}
            className="text-[11px] mt-0.5 truncate"
          >
            <span className="font-semibold text-ink/70">TTS · {voice.ttsVoice.name}</span>
            <span className="text-ink/40"> · {voice.ttsVoice.description}</span>
          </p>
        )}
        {!compact && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {voice.attributes.slice(0, 3).map(a => <Pill key={a}>{a}</Pill>)}
          </div>
        )}
      </div>
      <span className="text-ink/30 group-hover:text-ink/60 transition-colors mt-1"><IconDrag className="w-4 h-4"/></span>
    </div>
  );
}
