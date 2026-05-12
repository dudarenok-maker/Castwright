import { useState } from 'react';
import {
  IconLink, IconAlertTri, IconChevR, IconSearch, IconFilter, IconCheck,
  IconRefresh, IconMore,
} from '../lib/icons';
import {
  SectionLabel, MixedHeading, Avatar, Pill, VoiceSwatch,
} from '../components/primitives';
import { VoiceLibraryPanel } from '../components/voice-library-panel';
import { ProfileDrawer } from '../modals/profile-drawer';
import type { Character, Voice, DriftEvent, CharColor } from '../lib/types';

interface Props {
  characters: Character[];
  setCharacters: (next: Character[] | ((prev: Character[]) => Character[])) => void;
  library: Voice[];
  onOpenProfile: (id: string | null) => void;
  openProfileId: string | null;
  onShowMatchDetail: (id: string) => void;
  onRegenerateCharacter: (id: string) => void;
  onBatchRegenerate: (ids: string[]) => void;
  driftEvents: DriftEvent[];
  onShowDrift: () => void;
}

export function CastView({
  characters, setCharacters, library, onOpenProfile, openProfileId,
  onShowMatchDetail, onRegenerateCharacter, onBatchRegenerate, driftEvents, onShowDrift,
}: Props) {
  const [query, setQuery] = useState('');
  const [showLibrary, setShowLibrary] = useState(true);
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const [dropTargetCharId, setDropTargetCharId] = useState<string | null>(null);
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);

  const filtered = characters.filter(c => c.name.toLowerCase().includes(query.toLowerCase()));
  const toggleSelect = (id: string) =>
    setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const driftByChar = (id: string) => driftEvents.filter(d => d.characterId === id);
  const totalDriftEvents = driftEvents.length;
  const findVoice = (id?: string) => library.find(v => v.id === id);

  function handleDrop(charId: string) {
    if (!draggingVoiceId) return;
    const voice = findVoice(draggingVoiceId);
    if (!voice) return;
    setCharacters(prev => prev.map(c => c.id === charId ? {
      ...c,
      voiceId: voice.id,
      voiceState: voice.source === 'library' ? 'reused' : 'tuned',
      attributes: voice.attributes,
      matchedFrom: voice.source === 'library' ? { bookTitle: voice.bookTitle, confidence: 0.92 } : undefined,
    } : c));
    setDraggingVoiceId(null);
    setDropTargetCharId(null);
  }

  const profileCharacter = openProfileId ? characters.find(c => c.id === openProfileId) : undefined;
  const profileVoice = findVoice(profileCharacter?.voiceId);

  return (
    <div className={`max-w-[1500px] mx-auto px-6 py-10 grid ${showLibrary ? 'grid-cols-[1fr_360px]' : 'grid-cols-1'} gap-6 relative ${draggingVoiceId ? 'dragging-voice' : ''}`}>
      <div>
        <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
          <div>
            <SectionLabel>Your cast</SectionLabel>
            <div className="mt-4">
              <MixedHeading regular="Voices generated from" bold="The Northern Star" level="h1"/>
            </div>
            <p className="mt-3 text-ink/60 max-w-xl">Each voice is synthesised from how the character actually speaks in the book. Tune the profile, regenerate, or drop in a voice from your library to keep continuity across a series.</p>
          </div>
          <button onClick={() => setShowLibrary(!showLibrary)} className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2">
            <IconLink className="w-4 h-4"/>{showLibrary ? 'Hide' : 'Show'} library
          </button>
        </div>

        {totalDriftEvents > 0 && (
          <button onClick={onShowDrift} className="w-full mb-4 p-4 rounded-3xl border border-amber-200 bg-amber-50/60 hover:bg-amber-50 transition-colors flex items-center gap-4 text-left">
            <span className="w-10 h-10 rounded-full bg-amber-100 grid place-items-center text-amber-700 shrink-0"><IconAlertTri className="w-5 h-5"/></span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-ink">Voice drift detected in {totalDriftEvents} chapter{totalDriftEvents === 1 ? '' : 's'}</p>
              <p className="text-xs text-ink/65 mt-0.5">Some chapters have voices that don't match their established profiles. Click to review and decide what to regenerate.</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 shrink-0">
              See report <IconChevR className="w-3.5 h-3.5"/>
            </span>
          </button>
        )}

        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 relative">
            <IconSearch className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink/40"/>
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search characters" className="w-full pl-11 pr-4 py-2.5 rounded-full bg-white border border-ink/10 text-sm focus:outline-none focus:border-ink/30"/>
          </div>
          <button className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"><IconFilter className="w-4 h-4"/>Filter</button>
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          <div className="grid grid-cols-[40px_1.5fr_1.2fr_1.6fr_0.6fr_1.2fr_1fr_60px] px-6 py-3 text-[11px] uppercase tracking-wider font-semibold text-ink/50 border-b border-ink/10">
            <span></span>
            <span>Character</span><span>Role</span><span>Voice</span>
            <span className="text-right tabular-nums">Lines</span>
            <span>Tone</span><span>Status</span><span></span>
          </div>
          {filtered.map((c, i) => {
            const voice = findVoice(c.voiceId);
            const isDropTarget = dropTargetCharId === c.id;
            return (
              <div key={c.id}
                   onDragOver={(e) => { if (draggingVoiceId) { e.preventDefault(); setDropTargetCharId(c.id); } }}
                   onDragLeave={() => setDropTargetCharId(t => t === c.id ? null : t)}
                   onDrop={(e) => { e.preventDefault(); handleDrop(c.id); }}
                   onClick={() => onOpenProfile(c.id)}
                   className={`w-full grid grid-cols-[40px_1.5fr_1.2fr_1.6fr_0.6fr_1.2fr_1fr_60px] px-6 py-4 items-center text-left text-sm hover:bg-ink/[0.02] transition-colors cursor-pointer ${i < filtered.length - 1 ? 'border-b border-ink/5' : ''} ${isDropTarget ? 'drop-active' : ''} ${selectedCharIds.includes(c.id) ? 'bg-peach/[0.04]' : ''}`}>
                <span onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }} className="grid place-items-center">
                  <span className={`w-5 h-5 rounded-md grid place-items-center transition-colors ${selectedCharIds.includes(c.id) ? 'bg-peach' : 'bg-white border border-ink/20 hover:border-ink/40'}`}>
                    {selectedCharIds.includes(c.id) && <IconCheck className="w-3 h-3 text-white"/>}
                  </span>
                </span>
                <span className="flex items-center gap-3 min-w-0">
                  <Avatar name={c.name} color={c.color as CharColor} size={36}/>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold text-ink truncate">{c.name}</span>
                      {driftByChar(c.id).length > 0 && (
                        <span title={`${driftByChar(c.id).length} chapter${driftByChar(c.id).length === 1 ? '' : 's'} with voice drift`}
                              onClick={(e) => { e.stopPropagation(); onShowDrift(); }}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">
                          <IconAlertTri className="w-2.5 h-2.5"/>{driftByChar(c.id).length}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-ink/50 truncate">{c.attributes?.slice(0, 2).join(' · ')}</span>
                  </span>
                </span>
                <span className="text-ink/70 truncate">{c.role}</span>
                <span className="flex items-center gap-3 min-w-0">
                  {voice ? (
                    <>
                      <VoiceSwatch voice={voice} size="sm" showLabel={false}/>
                      <span className="min-w-0">
                        <span className="block text-ink/80 truncate font-medium">{voice.character}</span>
                        {c.matchedFrom && (
                          <button onClick={(e) => { e.stopPropagation(); onShowMatchDetail(c.id); }} className="block text-[11px] text-purple-deep/70 hover:text-purple-deep truncate underline-offset-2 hover:underline">
                            From {c.matchedFrom.bookTitle} · {Math.round((c.matchedFrom.confidence ?? 0) * 100)}%
                          </button>
                        )}
                      </span>
                    </>
                  ) : <span className="text-ink/40 italic">Generating…</span>}
                </span>
                <span className="text-right tabular-nums text-ink/80 font-medium">{c.lines}</span>
                <span className="flex flex-wrap gap-1">
                  {c.attributes?.slice(2, 4).map(a => <Pill key={a}>{a}</Pill>)}
                </span>
                <span>
                  {c.voiceState === 'generated' && <Pill color="success">Generated</Pill>}
                  {c.voiceState === 'tuned'     && <Pill color="warning">Tuned</Pill>}
                  {c.voiceState === 'reused'    && <Pill color="library">Reused</Pill>}
                  {c.voiceState === 'locked'    && <Pill>Locked</Pill>}
                </span>
                <span className="grid place-items-center text-ink/40"><IconMore className="w-4 h-4"/></span>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-ink/50 text-center">
          {draggingVoiceId ? 'Drop the voice on any character row to reassign.' : 'Drag a voice from the library onto a character to reuse it across this book and others in the series.'}
        </p>

        {selectedCharIds.length > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 fade-in">
            <div className="bg-ink text-canvas rounded-full shadow-float px-4 py-2 flex items-center gap-3">
              <span className="text-xs text-canvas/60">Selected</span>
              <span className="px-2 py-0.5 rounded-full bg-canvas/15 text-canvas font-bold text-sm tabular-nums">{selectedCharIds.length}</span>
              <span className="flex items-center -space-x-1.5">
                {selectedCharIds.slice(0, 4).map(id => {
                  const c = characters.find(x => x.id === id);
                  return c ? <Avatar key={id} name={c.name} color={c.color as CharColor} size={24}/> : null;
                })}
              </span>
              <span className="w-px h-5 bg-canvas/20"/>
              <button onClick={() => onBatchRegenerate(selectedCharIds)} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-peach text-ink text-xs font-bold hover:bg-peach/90">
                <IconRefresh className="w-3.5 h-3.5"/> Regenerate
              </button>
              <button onClick={() => setSelectedCharIds([])} className="text-xs text-canvas/70 hover:text-canvas font-medium">Clear</button>
            </div>
          </div>
        )}
      </div>

      {showLibrary && (
        <aside className="self-start sticky top-24">
          <VoiceLibraryPanel library={library} draggingVoiceId={draggingVoiceId} setDraggingVoiceId={setDraggingVoiceId} compact/>
        </aside>
      )}

      {profileCharacter && (
        <ProfileDrawer
          character={profileCharacter}
          voice={profileVoice}
          onClose={() => onOpenProfile(null)}
          onSave={(updated) => {
            setCharacters(prev => prev.map(c => c.id === updated.id ? updated : c));
            onOpenProfile(null);
          }}
          onShowMatchDetail={onShowMatchDetail}
          onRegenerateCharacter={onRegenerateCharacter}
        />
      )}
    </div>
  );
}
