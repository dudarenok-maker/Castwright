import { useState } from 'react';
import {
  IconLink,
  IconAlertTri,
  IconChevR,
  IconSearch,
  IconFilter,
  IconCheck,
  IconRefresh,
  IconPlay,
  IconPause,
  IconSpinner,
} from '../lib/icons';
import { SectionLabel, MixedHeading, Avatar, Pill, VoiceSwatch } from '../components/primitives';
import { VoiceLibraryPanel } from '../components/voice-library-panel';
import type { Character, Voice, DriftEvent, CharColor, TtsModelKey } from '../lib/types';
import { useAppSelector } from '../store';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';
import { gradientForTtsVoice } from '../lib/voice-palette';
import { TTS_MODEL_OPTIONS, engineForModelKey } from '../lib/tts-models';
import { findVoiceForCharacter } from '../lib/voice-character-link';
import { buildCharacterHint } from '../lib/build-character-hint';
import { CompareCastModal } from '../modals/compare-cast-modal';
import { StaleAudioBanner } from '../components/stale-audio-banner';

interface Props {
  characters: Character[];
  setCharacters: (next: Character[] | ((prev: Character[]) => Character[])) => void;
  library: Voice[];
  title?: string | null;
  onOpenProfile: (id: string | null) => void;
  onShowMatchDetail: (id: string) => void;
  onBatchRegenerate: (ids: string[]) => void;
  driftEvents: DriftEvent[];
  onShowDrift: () => void;
}

export function CastView({
  characters,
  setCharacters,
  library,
  title,
  onOpenProfile,
  onShowMatchDetail,
  onBatchRegenerate,
  driftEvents,
  onShowDrift,
}: Props) {
  const [query, setQuery] = useState('');
  const [showLibrary, setShowLibrary] = useState(true);
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const [dropTargetCharId, setDropTargetCharId] = useState<string | null>(null);
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const ttsEngine = engineForModelKey(ttsModelKey);
  const playback = useSamplePlayback();
  /* Per-row sample state: { [characterId]: 'loading' | 'error: msg' }. The
     "playing" indicator is derived from the singleton playback hook by
     comparing currentUrl, so multiple rows can't show as "playing" at once. */
  const [rowState, setRowState] = useState<Record<string, { loading?: boolean; error?: string }>>(
    {},
  );
  /* Inline auto-evict banner. Surfaces above the cast table the first
     time a Play click triggers the JIT TTS load and actually unloads the
     analyzer. One-shot per view mount — the user reads it once and the
     pill on the Generation view takes over as the authoritative state. */
  const [evictionBanner, setEvictionBanner] = useState<string | null>(null);
  const setRow = (id: string, patch: { loading?: boolean; error?: string } | null) =>
    setRowState((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[id];
      else next[id] = { ...next[id], ...patch };
      return next;
    });

  const filtered = characters.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const toggleSelect = (id: string) =>
    setSelectedCharIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const driftByChar = (id: string) => driftEvents.filter((d) => d.characterId === id);
  const totalDriftEvents = driftEvents.length;
  const findVoice = (id?: string) => library.find((v) => v.id === id);

  async function playSampleFor(c: Character, voice: Voice | undefined) {
    const sampleVoiceId = voice ? voice.id : `char-${c.id}`;
    /* Server appends a hash of (text, voiceName) to the cached filename so
       attribute edits don't return stale audio. Match by prefix so we still
       detect "this character's sample is what's playing". */
    const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${ttsModelKey}`;
    if (playback.isPlaying && playback.currentUrl?.startsWith(samplePrefix)) {
      playback.stop();
      return;
    }
    const stubTtsVoice = resolveTtsVoiceForCharacter(c, ttsEngine);
    const subject: Voice = voice ?? {
      id: sampleVoiceId,
      character: c.name,
      bookTitle: '',
      bookId: '',
      attributes: c.attributes ?? [],
      gradient: gradientForTtsVoice(stubTtsVoice.name, sampleVoiceId),
      usedIn: 0,
      source: 'current',
      ttsVoice: stubTtsVoice,
    };
    const characterHint = buildCharacterHint(c);
    setRow(c.id, { loading: true, error: undefined });
    try {
      await playSampleWithAutoLoad({
        args: { voiceId: sampleVoiceId, voice: subject, modelKey: ttsModelKey, characterHint },
        playback,
        /* The row's spinner already signals "something's happening"; the
           per-row label is too cramped for the full status word. So we
           only surface the eviction banner globally — and only when the
           helper confirms the analyzer was actually unloaded. */
        onStatus: (_status, { analyzerEvicted }) => {
          if (analyzerEvicted && !evictionBanner) {
            setEvictionBanner('Analyzer unloaded to free VRAM for TTS.');
          }
        },
      });
      setRow(c.id, { loading: false, error: undefined });
    } catch (err) {
      setRow(c.id, { loading: false, error: (err as Error).message });
    }
  }

  function handleDrop(charId: string) {
    if (!draggingVoiceId) return;
    const voice = findVoice(draggingVoiceId);
    if (!voice) return;
    setCharacters((prev) =>
      prev.map((c) =>
        c.id === charId
          ? {
              ...c,
              voiceId: voice.id,
              voiceState: voice.source === 'library' ? 'reused' : 'tuned',
              attributes: voice.attributes,
              matchedFrom:
                voice.source === 'library'
                  ? { bookTitle: voice.bookTitle, confidence: 0.92 }
                  : undefined,
            }
          : c,
      ),
    );
    setDraggingVoiceId(null);
    setDropTargetCharId(null);
  }

  return (
    <div
      className={`max-w-[1500px] mx-auto px-6 py-10 grid ${showLibrary ? 'grid-cols-[1fr_360px]' : 'grid-cols-1'} gap-6 relative ${draggingVoiceId ? 'dragging-voice' : ''}`}
    >
      <div className="col-span-full -mb-2">
        <StaleAudioBanner />
      </div>
      <div>
        <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
          <div>
            <SectionLabel>Your cast</SectionLabel>
            <div className="mt-4">
              <MixedHeading
                regular="Voices generated from"
                bold={title || 'your manuscript'}
                level="h1"
              />
            </div>
            <p className="mt-3 text-ink/60 max-w-xl">
              Each voice is synthesised from how the character actually speaks in the book. Tune the
              profile, regenerate, or drop in a voice from your library to keep continuity across a
              series.
            </p>
          </div>
          <button
            onClick={() => setShowLibrary(!showLibrary)}
            className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"
          >
            <IconLink className="w-4 h-4" />
            {showLibrary ? 'Hide' : 'Show'} library
          </button>
        </div>

        {evictionBanner && (
          <div
            role="status"
            className="w-full mb-4 px-4 py-2.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 inline-flex items-center gap-2 text-xs text-emerald-700"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>{evictionBanner}</span>
            <button
              onClick={() => setEvictionBanner(null)}
              className="ml-auto text-[11px] text-emerald-700/60 hover:text-emerald-700 font-medium"
              aria-label="Dismiss notice"
            >
              Dismiss
            </button>
          </div>
        )}

        {totalDriftEvents > 0 && (
          <button
            onClick={onShowDrift}
            className="w-full mb-4 p-4 rounded-3xl border border-amber-200 bg-amber-50/60 hover:bg-amber-50 transition-colors flex items-center gap-4 text-left"
          >
            <span className="w-10 h-10 rounded-full bg-amber-100 grid place-items-center text-amber-700 shrink-0">
              <IconAlertTri className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-ink">
                Voice drift detected in {totalDriftEvents} chapter
                {totalDriftEvents === 1 ? '' : 's'}
              </p>
              <p className="text-xs text-ink/65 mt-0.5">
                Some chapters have voices that don't match their established profiles. Click to
                review and decide what to regenerate.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 shrink-0">
              See report <IconChevR className="w-3.5 h-3.5" />
            </span>
          </button>
        )}

        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 relative">
            <IconSearch className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink/40" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search characters"
              className="w-full pl-11 pr-4 py-2.5 rounded-full bg-white border border-ink/10 text-sm focus:outline-none focus:border-ink/30"
            />
          </div>
          <button className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2">
            <IconFilter className="w-4 h-4" />
            Filter
          </button>
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          <div className="grid grid-cols-[40px_1.5fr_1.2fr_1.6fr_0.6fr_1.2fr_1fr_140px] px-6 py-3 text-[11px] uppercase tracking-wider font-semibold text-ink/50 border-b border-ink/10">
            <span></span>
            <span>Character</span>
            <span>Role</span>
            <span>Voice</span>
            <span className="text-right tabular-nums">Lines</span>
            <span>Tone</span>
            <span>Status</span>
            <span>Sample</span>
          </div>
          {filtered.map((c, i) => {
            const voice = findVoiceForCharacter(c, library);
            const ttsVoice = voice?.ttsVoice ?? resolveTtsVoiceForCharacter(c, ttsEngine);
            const isDropTarget = dropTargetCharId === c.id;
            const sampleVoiceId = voice ? voice.id : `char-${c.id}`;
            const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${ttsModelKey}`;
            const isPlayingThis =
              playback.isPlaying && !!playback.currentUrl?.startsWith(samplePrefix);
            const row = rowState[c.id];
            return (
              <div
                key={c.id}
                onDragOver={(e) => {
                  if (draggingVoiceId) {
                    e.preventDefault();
                    setDropTargetCharId(c.id);
                  }
                }}
                onDragLeave={() => setDropTargetCharId((t) => (t === c.id ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(c.id);
                }}
                onClick={() => onOpenProfile(c.id)}
                className={`w-full grid grid-cols-[40px_1.5fr_1.2fr_1.6fr_0.6fr_1.2fr_1fr_140px] px-6 py-4 items-center text-left text-sm hover:bg-ink/[0.02] transition-colors cursor-pointer ${i < filtered.length - 1 ? 'border-b border-ink/5' : ''} ${isDropTarget ? 'drop-active' : ''} ${selectedCharIds.includes(c.id) ? 'bg-peach/[0.04]' : ''}`}
              >
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(c.id);
                  }}
                  className="grid place-items-center"
                >
                  <span
                    className={`w-5 h-5 rounded-md grid place-items-center transition-colors ${selectedCharIds.includes(c.id) ? 'bg-peach' : 'bg-white border border-ink/20 hover:border-ink/40'}`}
                  >
                    {selectedCharIds.includes(c.id) && <IconCheck className="w-3 h-3 text-white" />}
                  </span>
                </span>
                <span className="flex items-center gap-3 min-w-0">
                  <Avatar name={c.name} color={c.color as CharColor} size={36} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold text-ink truncate">{c.name}</span>
                      {driftByChar(c.id).length > 0 && (
                        <span
                          title={`${driftByChar(c.id).length} chapter${driftByChar(c.id).length === 1 ? '' : 's'} with voice drift`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onShowDrift();
                          }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold"
                        >
                          <IconAlertTri className="w-2.5 h-2.5" />
                          {driftByChar(c.id).length}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-ink/50 truncate">
                      {c.attributes?.slice(0, 2).join(' · ')}
                    </span>
                  </span>
                </span>
                <span className="text-ink/70 truncate">{c.role}</span>
                <span className="flex items-center gap-3 min-w-0">
                  {voice ? (
                    <>
                      {/* Swatch click intentionally bubbles to the row's
                          onClick — so a single click opens the profile drawer
                          AND fires the sample play. The drawer's own swatch
                          coalesces with this play via the in-flight gate in
                          play-sample-with-auto-load. */}
                      <VoiceSwatch
                        voice={voice}
                        size="sm"
                        showLabel={false}
                        onSelect={() => {
                          void playSampleFor(c, voice);
                        }}
                        loading={!!rowState[c.id]?.loading}
                      />
                      <span className="min-w-0">
                        <span className="block text-ink/80 truncate font-medium">
                          {voice.character}
                        </span>
                        {/* Voice profile line is identical for generated and
                            reused rows — the match-source line stacks below
                            it so the user still sees which prebuilt voice the
                            reused character will speak with. */}
                        <TtsVoiceLine ttsVoice={ttsVoice} />
                        {c.matchedFrom && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onShowMatchDetail(c.id);
                            }}
                            className="block text-[11px] text-purple-deep/70 hover:text-purple-deep truncate underline-offset-2 hover:underline"
                          >
                            From {c.matchedFrom.bookTitle} ·{' '}
                            {Math.round((c.matchedFrom.confidence ?? 0) * 100)}%
                          </button>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0">
                      <span className="block text-ink/60 truncate italic">No library voice</span>
                      <TtsVoiceLine ttsVoice={ttsVoice} />
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums text-ink/80 font-medium">{c.lines}</span>
                <span className="flex flex-wrap gap-1">
                  {c.attributes?.slice(2, 4).map((a) => (
                    <Pill key={a}>{a}</Pill>
                  ))}
                </span>
                <span>
                  {c.voiceState === 'generated' && <Pill color="success">Generated</Pill>}
                  {c.voiceState === 'tuned' && <Pill color="warning">Tuned</Pill>}
                  {c.voiceState === 'reused' && <Pill color="library">Reused</Pill>}
                  {c.voiceState === 'locked' && <Pill>Locked</Pill>}
                </span>
                <span
                  onClick={(e) => e.stopPropagation()}
                  className="flex flex-col items-start gap-0.5"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void playSampleFor(c, voice);
                    }}
                    disabled={row?.loading}
                    title={
                      isPlayingThis
                        ? 'Stop sample'
                        : row?.loading
                          ? 'Generating…'
                          : `Generate & play a 12-second sample via ${ttsLabel(ttsModelKey)}`
                    }
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                      row?.loading
                        ? 'bg-magenta/10 text-magenta cursor-wait'
                        : isPlayingThis
                          ? 'bg-magenta text-white hover:bg-magenta/90'
                          : 'bg-ink/[0.06] text-ink/80 hover:bg-magenta/15 hover:text-magenta'
                    }`}
                  >
                    {row?.loading ? (
                      <IconSpinner className="w-3 h-3" />
                    ) : isPlayingThis ? (
                      <IconPause className="w-3 h-3" />
                    ) : (
                      <IconPlay className="w-3 h-3" />
                    )}
                    <span>
                      {row?.loading ? 'Generating…' : isPlayingThis ? 'Stop' : 'Play 12s'}
                    </span>
                  </button>
                  {row?.error && (
                    <span
                      className="text-[10px] text-red-600/80 truncate max-w-[130px]"
                      title={row.error}
                    >
                      ⚠ {row.error}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-ink/50 text-center">
          {draggingVoiceId
            ? 'Drop the voice on any character row to reassign.'
            : 'Drag a voice from the library onto a character to reuse it across this book and others in the series.'}
        </p>

        {selectedCharIds.length > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 fade-in">
            <div className="floating-pill-inverse rounded-full shadow-float px-4 py-2 flex items-center gap-3">
              <span className="text-xs text-canvas/60">Selected</span>
              <span className="px-2 py-0.5 rounded-full bg-canvas/15 text-canvas font-bold text-sm tabular-nums">
                {selectedCharIds.length}
              </span>
              <span className="flex items-center -space-x-1.5">
                {selectedCharIds.slice(0, 4).map((id) => {
                  const c = characters.find((x) => x.id === id);
                  return c ? (
                    <Avatar key={id} name={c.name} color={c.color as CharColor} size={24} />
                  ) : null;
                })}
              </span>
              <span className="w-px h-5 bg-canvas/20" />
              <button
                onClick={() => {
                  if (selectedCharIds.length === 2)
                    setCompareIds([selectedCharIds[0], selectedCharIds[1]]);
                }}
                disabled={selectedCharIds.length !== 2}
                title={
                  selectedCharIds.length === 2
                    ? 'Compare these two cast members'
                    : 'Select exactly 2 to compare'
                }
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Compare
              </button>
              <button
                onClick={() => onBatchRegenerate(selectedCharIds)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-peach text-ink text-xs font-bold hover:bg-peach/90"
              >
                <IconRefresh className="w-3.5 h-3.5" /> Regenerate
              </button>
              <button
                onClick={() => setSelectedCharIds([])}
                className="text-xs text-canvas/70 hover:text-canvas font-medium"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {compareIds &&
          (() => {
            const [aId, bId] = compareIds;
            const a = characters.find((c) => c.id === aId);
            const b = characters.find((c) => c.id === bId);
            if (!a || !b) return null;
            return (
              <CompareCastModal
                characters={[a, b]}
                library={library}
                ttsModelKey={ttsModelKey}
                onSaveSide={(next) =>
                  setCharacters((prev) => prev.map((c) => (c.id === next.id ? next : c)))
                }
                onClose={() => setCompareIds(null)}
                onOpenProfile={(id) => {
                  setCompareIds(null);
                  onOpenProfile(id);
                }}
              />
            );
          })()}
      </div>

      {showLibrary && (
        <aside className="self-start sticky top-24">
          <VoiceLibraryPanel
            library={library}
            draggingVoiceId={draggingVoiceId}
            setDraggingVoiceId={setDraggingVoiceId}
            compact
            characters={characters}
            onOpenProfile={onOpenProfile}
            onPlaySample={(c, v) => {
              void playSampleFor(c, v);
            }}
          />
        </aside>
      )}
    </div>
  );
}

function ttsLabel(key: TtsModelKey): string {
  return TTS_MODEL_OPTIONS.find((o) => o.id === key)?.label ?? key;
}

interface TtsVoiceLineProps {
  ttsVoice: { provider: string; name: string; description: string };
}
function TtsVoiceLine({ ttsVoice }: TtsVoiceLineProps) {
  return (
    <span
      title={`Prebuilt ${ttsVoice.provider} voice — ${ttsVoice.description}`}
      className="block text-[11px] text-ink/50 truncate"
    >
      <span className="font-semibold text-ink/70">{ttsVoice.name}</span>
      <span className="text-ink/40"> · {ttsVoice.description}</span>
    </span>
  );
}
