import { useState } from 'react';
import { IconStar, IconDrag, IconCheck } from '../lib/icons';
import { VoiceSwatch, Pill } from './primitives';
import type { Character, Voice } from '../lib/types';
import { findCharacterForVoice } from '../lib/voice-character-link';

type Tab = 'all' | 'current' | 'library';

interface VoiceLibraryPanelProps {
  library: Voice[];
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  compact?: boolean;
  /* Optional Cast-view interactions: when a panel voice is also used by a
     character in the current book, clicking the card opens that character's
     profile drawer, and clicking the swatch bubble plays a voice sample.
     Library/series voices with no matching character stay drag-only. */
  characters?: Character[];
  onOpenProfile?: (id: string) => void;
  onPlaySample?: (character: Character, voice: Voice) => void;
}

export function VoiceLibraryPanel({
  library, draggingVoiceId, setDraggingVoiceId, compact = false,
  characters, onOpenProfile, onPlaySample,
}: VoiceLibraryPanelProps) {
  const [tab, setTab] = useState<Tab>('all');
  const filtered = library.filter(v => tab === 'all' || v.source === tab);
  const bookCount = new Set(library.map(v => v.bookId)).size;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all',     label: 'All' },
    { id: 'current', label: 'This book' },
    { id: 'library', label: 'Series' },
  ];
  const findCharacter = (v: Voice) => characters ? findCharacterForVoice(v, characters) : undefined;
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden flex flex-col max-h-[calc(100vh-120px)]">
      <div className="p-5 pb-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-ink">Voice library</h2>
          <span className="text-xs text-ink/50">{library.length} voices · {bookCount} {bookCount === 1 ? 'book' : 'books'}</span>
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
      <div data-testid="voice-library-scroll"
           className="p-5 overflow-y-auto scrollbar-thin space-y-2">
        {filtered.map(v => (
          <VoiceCard key={v.id} voice={v} draggingVoiceId={draggingVoiceId} setDraggingVoiceId={setDraggingVoiceId}
            compact={compact}
            character={findCharacter(v)}
            onOpenProfile={onOpenProfile}
            onPlaySample={onPlaySample}/>
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
  showBookTitle?: boolean;
  pinned?: boolean;
  onTogglePin?: (voice: Voice) => void;
  character?: Character;
  onOpenProfile?: (id: string) => void;
  onPlaySample?: (character: Character, voice: Voice) => void;
  /* Library-view click handler. When set, takes precedence over the
     character+onOpenProfile pair so a voice card is interactive even when
     no character from the currently-loaded cast matches — e.g. the global
     `#/voices` page, where the click navigates to the voice's source book. */
  onSelect?: (voice: Voice) => void;
  /* Multi-select affordance (plan 22a). When BOTH `selected` and
     `onToggleSelect` are set, the card renders a checkbox at top-left that
     toggles selection without firing onSelect/onOpenProfile. Mirrors the
     DOM in `src/views/cast.tsx` (~lines 200-203). When either prop is
     omitted, the legacy drag-only / click-to-open card renders unchanged. */
  selected?: boolean;
  onToggleSelect?: (voice: Voice) => void;
}

export function VoiceCard({
  voice,
  draggingVoiceId,
  setDraggingVoiceId,
  compact = false,
  showBookTitle = true,
  pinned = false,
  onTogglePin,
  character,
  onOpenProfile,
  onPlaySample,
  onSelect,
  selected,
  onToggleSelect,
}: VoiceCardProps) {
  const isDragging = draggingVoiceId === voice.id;
  const canOpenProfile = !!(character && onOpenProfile);
  const canPlay = !!(character && onPlaySample);
  const interactive = !!onSelect || canOpenProfile;
  const selectable = selected !== undefined && !!onToggleSelect;
  const activate = onSelect
    ? () => onSelect(voice)
    : canOpenProfile
      ? () => onOpenProfile!(character!.id)
      : undefined;
  return (
    <div draggable
      onDragStart={(e) => { setDraggingVoiceId(voice.id); e.dataTransfer.effectAllowed = 'copy'; }}
      onDragEnd={() => setDraggingVoiceId(null)}
      onClick={activate}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={activate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } } : undefined}
      className={`group flex items-start gap-3 p-3 rounded-2xl border bg-canvas hover:bg-white border-ink/10 cursor-grab active:cursor-grabbing transition-all ${isDragging ? 'opacity-40 scale-[0.98]' : ''} ${selectable && selected ? 'bg-peach/[0.04]' : ''}`}>
      {selectable && (
        <span
          onClick={(e) => { e.stopPropagation(); onToggleSelect!(voice); }}
          onMouseDown={(e) => e.stopPropagation()}
          className="grid place-items-center pt-0.5"
          aria-label={selected ? 'Deselect voice' : 'Select voice for compare'}
        >
          <span className={`w-5 h-5 rounded-md grid place-items-center transition-colors ${selected ? 'bg-peach' : 'bg-white border border-ink/20 hover:border-ink/40'}`}>
            {selected && <IconCheck className="w-3 h-3 text-white"/>}
          </span>
        </span>
      )}
      <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <VoiceSwatch voice={voice} size="sm" showLabel={false}
          onSelect={canPlay ? () => onPlaySample!(character!, voice) : undefined}/>
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-ink truncate">{voice.character}</p>
          {voice.source === 'library' && voice.usedIn > 1 && (
            <Pill color="library"><IconStar className="w-2.5 h-2.5 mr-0.5"/>×{voice.usedIn}</Pill>
          )}
          {onTogglePin && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onTogglePin(voice); }}
              aria-label={pinned ? 'Unpin voice' : 'Pin voice'}
              aria-pressed={pinned}
              className={`ml-auto w-6 h-6 grid place-items-center rounded-full transition-colors shrink-0 ${pinned ? 'bg-peach text-ink' : 'text-ink/30 hover:text-ink hover:bg-ink/[0.06]'}`}
            >
              <IconStar className="w-3.5 h-3.5"/>
            </button>
          )}
        </div>
        {showBookTitle && (
          <p className="text-[11px] text-ink/60 truncate">{voice.bookTitle}</p>
        )}
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
