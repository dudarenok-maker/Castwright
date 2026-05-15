import { useEffect, useMemo, useState } from 'react';
import { SectionLabel, MixedHeading, VoiceSwatch } from '../components/primitives';
import { VoiceCard } from '../components/voice-library-panel';
import { IconPlay } from '../lib/icons';
import type { BaseVoice, TtsEngine, TtsModelKey, Voice } from '../lib/types';
import {
  TTS_ENGINES,
  engineForModelKey,
  engineGroupForModelKey,
  type TtsEngineId,
} from '../lib/tts-models';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { voicesActions } from '../store/voices-slice';
import { api } from '../lib/api';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playBaseVoiceSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { gradientForTtsVoice } from '../lib/voice-palette';

type Tab = 'all' | 'current' | 'library' | 'base';

interface Props {
  library: Voice[];
  /* Click handler for a voice/character card. The Voices view sits in two
     places: the global `#/voices` page (no book loaded) and the per-book
     "Voices" tab (`#/books/:bookId/library`). Both wire this prop to open
     the linked character's profile drawer — in-place when the voice belongs
     to the currently-open book, by navigating to the source book otherwise.
     When unset, cards stay drag-only (legacy behavior used by tests). */
  onOpenCharacter?: (voice: Voice) => void;
}

/* A voice "family" — every cast Voice that resolves to the same model
   speaker (e.g. every character mapped to Coqui · Asya Anara). Each family
   is the primary axis of the Voices view; cast members hang off it nested
   by book series → book → character. */
interface VoiceFamily {
  key: string;
  engine: TtsEngine;
  name: string;
  description: string;
  members: Voice[];
  totalUsedIn: number;
  primary: Voice;
  anyPinned: boolean;
  gradient: [string, string];
}

interface SeriesGroup {
  series: string | null;
  books: BookGroup[];
}

interface BookGroup {
  bookId: string;
  bookTitle: string;
  voices: Voice[];
}

const ENGINE_LABEL: Record<TtsEngine, string> = {
  coqui: 'Coqui',
  gemini: 'Gemini',
  piper: 'Piper',
  kokoro: 'Kokoro',
};

export function LibraryView({ library, onOpenCharacter }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const [familyStatus, setFamilyStatus] = useState<{ key: string; label: string } | null>(null);
  const dispatch = useAppDispatch();
  const ttsModelKey = useAppSelector(s => s.ui.ttsModelKey);
  const baseVoices = useAppSelector(s => s.voices.baseVoices);
  const baseVoicesLoaded = useAppSelector(s => s.voices.baseVoicesLoaded);
  const playback = useSamplePlayback();
  const activeEngine = engineForModelKey(ttsModelKey);

  /* Hydrate the base-voice catalog once when the Voices view mounts. The
     catalog is small and changes only when the sidecar's loaded model
     changes — refreshing on every mount is cheap and keeps the picker
     honest after a sidecar bounce. */
  useEffect(() => {
    let cancelled = false;
    api.getBaseVoices()
      .then(res => { if (!cancelled) dispatch(voicesActions.hydrateBaseVoices(res.voices)); })
      .catch(err => { console.error('[voices] base catalog hydrate failed', err); });
    return () => { cancelled = true; };
  }, [dispatch]);

  /* Group voices into families. The key is (engine, name) on ttsVoice —
     that's what's resolved server-side after honouring overrides, so two
     characters with the same engine+name appear under the same family
     regardless of how they got there. */
  const families = useMemo(() => buildFamilies(library, tab), [library, tab]);
  const books = [...new Set(library.map(v => v.bookId))];

  function togglePin(voice: Voice) {
    const next = !voice.pinned;
    dispatch(voicesActions.setPinned({ voiceId: voice.id, pinned: next }));
    api.setVoicePin(voice.id, next).catch(err => {
      console.error('[voices] pin failed', err);
      dispatch(voicesActions.setPinned({ voiceId: voice.id, pinned: !next }));
    });
  }

  async function playFamilySample(family: VoiceFamily) {
    setFamilyStatus({ key: family.key, label: 'Preparing…' });
    try {
      await playBaseVoiceSampleWithAutoLoad({
        args: { engine: family.engine, speakerName: family.name, modelKey: ttsModelKey },
        playback,
        onStatus: (status) => {
          if (status === 'evicting')     setFamilyStatus({ key: family.key, label: 'Freeing memory…' });
          if (status === 'loading-tts')  setFamilyStatus({ key: family.key, label: 'Loading TTS…' });
          if (status === 'synthesizing') setFamilyStatus({ key: family.key, label: 'Synthesising…' });
        },
      });
    } catch (err) {
      console.error('[voices] family play failed', err);
      setFamilyStatus({ key: family.key, label: (err as Error).message || 'Failed' });
      return;
    }
    setFamilyStatus(null);
  }

  /* Per-base-voice play state — keyed by `${engine}|${name}`. Lets each row
     show its own in-progress label without thrashing the whole tab. */
  async function playBaseVoice(bv: BaseVoice) {
    const key = `${bv.engine}|${bv.name}`;
    setFamilyStatus({ key, label: 'Preparing…' });
    try {
      await playBaseVoiceSampleWithAutoLoad({
        args: { engine: bv.engine, speakerName: bv.name, modelKey: ttsModelKey },
        playback,
        onStatus: (status) => {
          if (status === 'evicting')     setFamilyStatus({ key, label: 'Freeing memory…' });
          if (status === 'loading-tts')  setFamilyStatus({ key, label: 'Loading TTS…' });
          if (status === 'synthesizing') setFamilyStatus({ key, label: 'Synthesising…' });
        },
      });
    } catch (err) {
      console.error('[voices] base voice play failed', err);
      setFamilyStatus({ key, label: (err as Error).message || 'Failed' });
      return;
    }
    setFamilyStatus(null);
  }

  /* Usage count for a base voice — how many cast members across the
     workspace resolve to this (engine, name). Drives the "Used by N" chip
     in the Base voices tab. */
  const usageByBaseVoice = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of library) {
      if (!v.ttsVoice) continue;
      const k = `${v.ttsVoice.provider}|${v.ttsVoice.name}`;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [library]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all',     label: `All (${library.length})` },
    { id: 'current', label: `This book (${library.filter(v => v.source === 'current').length})` },
    { id: 'library', label: `Series & older (${library.filter(v => v.source === 'library').length})` },
    { id: 'base',    label: `Base voices${baseVoicesLoaded ? ` (${baseVoices.length})` : ''}` },
  ];

  const familyCount = new Set(library.filter(v => v.ttsVoice).map(v => `${v.ttsVoice!.provider}|${v.ttsVoice!.name}`)).size;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Voice library</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Every voice you've" bold="ever generated" level="h1"/>
          </div>
          <p className="mt-3 text-ink/60 max-w-2xl">Voices are grouped by the model voice they resolve to. Expand a family to see every cast member using it across books — handy when one base voice carries through a whole series.</p>
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
        <StatTile label="Families"  value={familyCount}/>
        <StatTile label="Books"     value={books.length}/>
        <StatTile label="Pinned"    value={library.filter(v => v.pinned).length}/>
      </div>

      <div className="flex items-center gap-1 mb-6 flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${tab === t.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'base' ? (
        <BaseVoiceCatalogPanel
          baseVoices={baseVoices}
          baseVoicesLoaded={baseVoicesLoaded}
          usage={usageByBaseVoice}
          activeEngine={activeEngine}
          onPlay={playBaseVoice}
          status={familyStatus}
        />
      ) : families.length === 0 ? (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
          <p className="text-sm font-bold text-ink">No voices yet</p>
          <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">Finish setting up a book — once you confirm its cast, every character will appear here as a reusable voice.</p>
        </div>
      ) : (
        <div className={`space-y-8 ${draggingVoiceId ? 'dragging-voice' : ''}`}>
          {families.map(f => (
            <VoiceFamilySection
              key={f.key}
              family={f}
              draggingVoiceId={draggingVoiceId}
              setDraggingVoiceId={setDraggingVoiceId}
              onTogglePin={togglePin}
              onPlay={playFamilySample}
              status={familyStatus}
              onOpenCharacter={onOpenCharacter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* Internal accumulator — kept module-local so the public VoiceFamily type
   stays free of the per-build Map plumbing. */
interface FamilyAccumulator extends VoiceFamily {
  books: Map<string, BookGroup>;
  seriesOrder: Map<string, string | null>;
  seriesBuckets: Map<string, BookGroup[]>;
}

/* Build voice families from the flat library list. Filters by tab first
   (so 'current' / 'library' don't leak voices the user isn't asking about
   into the family count), then groups, then sub-groups by series → book. */
function buildFamilies(library: Voice[], tab: Tab): Array<VoiceFamily & { seriesGroups: SeriesGroup[] }> {
  const filtered = library.filter(v => {
    if (tab === 'all' || tab === 'base') return true;
    return v.source === tab;
  });
  const byKey = new Map<string, FamilyAccumulator>();
  for (const v of filtered) {
    if (!v.ttsVoice) continue;
    const key = `${v.ttsVoice.provider}|${v.ttsVoice.name}`;
    let fam = byKey.get(key);
    if (!fam) {
      fam = {
        key,
        engine: v.ttsVoice.provider as TtsEngine,
        name: v.ttsVoice.name,
        description: v.ttsVoice.description ?? '',
        members: [],
        totalUsedIn: 0,
        primary: v,
        anyPinned: false,
        gradient: gradientForTtsVoice(v.ttsVoice.name, key) as [string, string],
        books: new Map(),
        seriesOrder: new Map(),
        seriesBuckets: new Map(),
      };
      byKey.set(key, fam);
    }
    fam.members.push(v);
    fam.totalUsedIn += v.usedIn;
    if (v.pinned) fam.anyPinned = true;
    /* Nested grouping. `bookSeries` is null for standalones — bucket those
       under a synthetic 'standalone' key so the render path can flatten. */
    const seriesKey = v.bookSeries ?? 'standalone';
    let bg = fam.books.get(v.bookId);
    if (!bg) {
      bg = { bookId: v.bookId, bookTitle: v.bookTitle, voices: [] };
      fam.books.set(v.bookId, bg);
      const bucket = fam.seriesBuckets.get(seriesKey) ?? [];
      bucket.push(bg);
      fam.seriesBuckets.set(seriesKey, bucket);
      fam.seriesOrder.set(seriesKey, v.bookSeries ?? null);
    }
    bg.voices.push(v);
  }
  /* Project each accumulator into a clean public VoiceFamily with a
     flattened seriesGroups list. */
  const out: Array<VoiceFamily & { seriesGroups: SeriesGroup[] }> = [];
  for (const fam of byKey.values()) {
    const seriesGroups: SeriesGroup[] = [];
    for (const [seriesKey, books] of fam.seriesBuckets) {
      seriesGroups.push({
        series: seriesKey === 'standalone' ? null : (fam.seriesOrder.get(seriesKey) as string | null),
        books: books.sort((a, b) => a.bookTitle.localeCompare(b.bookTitle)),
      });
    }
    seriesGroups.sort((a, b) => (a.series ?? '~').localeCompare(b.series ?? '~'));
    out.push({
      key: fam.key,
      engine: fam.engine,
      name: fam.name,
      description: fam.description,
      members: fam.members,
      totalUsedIn: fam.totalUsedIn,
      primary: fam.primary,
      anyPinned: fam.anyPinned,
      gradient: fam.gradient,
      seriesGroups,
    });
  }
  /* Family sort: pinned (any member) first, then total usedIn desc, then
     by speaker name so the order is stable across renders. */
  out.sort((a, b) => {
    if (a.anyPinned !== b.anyPinned) return a.anyPinned ? -1 : 1;
    if (a.totalUsedIn !== b.totalUsedIn) return b.totalUsedIn - a.totalUsedIn;
    return a.name.localeCompare(b.name);
  });
  return out;
}

interface FamilyProps {
  family: VoiceFamily & { seriesGroups: SeriesGroup[] };
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  onTogglePin: (v: Voice) => void;
  onPlay: (f: VoiceFamily) => void;
  status: { key: string; label: string } | null;
  onOpenCharacter?: (voice: Voice) => void;
}
function VoiceFamilySection({ family, draggingVoiceId, setDraggingVoiceId, onTogglePin, onPlay, status, onOpenCharacter }: FamilyProps) {
  const seriesGroups = family.seriesGroups;
  const isBusy = status?.key === family.key;
  /* Build a Voice-shaped stand-in for the family header swatch so VoiceSwatch
     reuses its existing radial-gradient render path. */
  const headerVoice: Voice = {
    ...family.primary,
    id: family.key,
    character: family.name,
    gradient: family.gradient,
  };
  return (
    <section aria-label={`${ENGINE_LABEL[family.engine]} · ${family.name}`}>
      <header className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span onClick={(e) => e.stopPropagation()}>
            <VoiceSwatch voice={headerVoice} size="sm" showLabel={false} onSelect={() => onPlay(family)}/>
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-ink truncate">{family.name}</h2>
              <span className="text-[11px] uppercase tracking-wider font-semibold text-ink/40 shrink-0">
                {ENGINE_LABEL[family.engine]}
              </span>
              {family.description && (
                <span className="text-xs text-ink/50 truncate">· {family.description}</span>
              )}
            </div>
            <p className="text-xs text-ink/50">
              {family.members.length} {family.members.length === 1 ? 'cast member' : 'cast members'} ·{' '}
              {seriesGroups.length} {seriesGroups.length === 1 ? 'series/standalone bucket' : 'series/standalone buckets'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isBusy && (
            <span className="text-[11px] text-ink/60 italic" aria-live="polite">{status?.label}</span>
          )}
          <button
            type="button"
            onClick={() => onPlay(family)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink/[0.04] hover:bg-ink/[0.08] text-xs font-medium text-ink transition-colors"
          >
            <IconPlay className="w-3.5 h-3.5"/> Audition base voice
          </button>
        </div>
      </header>
      <div className="space-y-4">
        {seriesGroups.map(sg => (
          <div key={sg.series ?? '~standalone'} className="pl-2 border-l-2 border-ink/[0.06]">
            {sg.series && (
              <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/40 mb-2 pl-2">{sg.series}</p>
            )}
            <div className="space-y-3">
              {sg.books.map(b => (
                <div key={b.bookId}>
                  <p className="text-xs font-semibold text-ink/70 mb-1.5 pl-2">{b.bookTitle}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pl-2">
                    {b.voices.map(v => (
                      <VoiceCard
                        key={v.id}
                        voice={v}
                        draggingVoiceId={draggingVoiceId}
                        setDraggingVoiceId={setDraggingVoiceId}
                        compact={false}
                        showBookTitle={false}
                        pinned={!!v.pinned}
                        onTogglePin={onTogglePin}
                        onSelect={onOpenCharacter}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface BasePanelProps {
  baseVoices: BaseVoice[];
  baseVoicesLoaded: boolean;
  usage: Map<string, number>;
  activeEngine: TtsEngine;
  onPlay: (bv: BaseVoice) => void;
  status: { key: string; label: string } | null;
}
function BaseVoiceCatalogPanel({ baseVoices, baseVoicesLoaded, usage, activeEngine, onPlay, status }: BasePanelProps) {
  if (!baseVoicesLoaded) {
    return (
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
        <p className="text-sm font-bold text-ink">Loading base voices…</p>
        <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">If this stays empty, load the TTS sidecar from the model pill — the Coqui catalog is fetched live from the loaded model.</p>
      </div>
    );
  }
  if (baseVoices.length === 0) {
    return (
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
        <p className="text-sm font-bold text-ink">No base voices available</p>
        <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">The TTS sidecar isn't reachable, or the loaded model has no published speakers. Load a model to populate this list.</p>
      </div>
    );
  }
  /* Group by engine so Coqui / Gemini / Piper / Kokoro form their own
     sections — same visual rhythm as the voice-family view. */
  const byEngine = new Map<TtsEngine, BaseVoice[]>();
  for (const bv of baseVoices) {
    const list = byEngine.get(bv.engine) ?? [];
    list.push(bv);
    byEngine.set(bv.engine, list);
  }
  return (
    <div className="space-y-8">
      {Array.from(byEngine.entries()).map(([engine, list]) => (
        <section key={engine} aria-label={ENGINE_LABEL[engine]}>
          <header className="mb-3 flex items-baseline gap-3">
            <h2 className="text-base font-bold text-ink">{ENGINE_LABEL[engine]}</h2>
            <span className="text-xs text-ink/50">{list.length} voices</span>
            {engine !== activeEngine && (
              <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                Not the active engine — switch your TTS model to assign these
              </span>
            )}
          </header>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {list.map(bv => {
              const key = `${bv.engine}|${bv.name}`;
              const inUse = usage.get(key) ?? 0;
              const isBusy = status?.key === key;
              const swatchVoice: Voice = {
                id: key,
                character: bv.name,
                bookId: '',
                bookTitle: '',
                attributes: [],
                usedIn: inUse,
                source: 'library',
                gradient: gradientForTtsVoice(bv.name, key) as [string, string],
                ttsVoice: { provider: bv.engine, name: bv.name, description: '' },
              };
              return (
                <div key={key} className="flex items-start gap-3 p-3 rounded-2xl border bg-canvas border-ink/10">
                  <span onClick={(e) => e.stopPropagation()}>
                    <VoiceSwatch voice={swatchVoice} size="sm" showLabel={false} onSelect={() => onPlay(bv)}/>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-ink truncate">{bv.name}</p>
                    <p className="text-[11px] text-ink/50">
                      {inUse > 0 ? `Used by ${inUse} cast ${inUse === 1 ? 'member' : 'members'}` : 'Unused'}
                    </p>
                    {isBusy && (
                      <p className="text-[11px] text-ink/60 italic mt-1" aria-live="polite">{status?.label}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
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
