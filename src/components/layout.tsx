import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { fetchAccountSettings } from '../store/account-slice';
import { chaptersActions, STALL_THRESHOLD_MS } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { analysisActions } from '../store/analysis-slice';
import { revisionsActions } from '../store/revisions-slice';
import { libraryActions } from '../store/library-slice';
import { voicesActions } from '../store/voices-slice';
import { changeLogActions } from '../store/change-log-slice';
import { bookMetaActions, narratorNameFromCast } from '../store/book-meta-slice';
import { notificationsActions } from '../store/notifications-slice';
import {
  buildChapterRegenEvent,
  buildCharacterRegenEvent,
  buildBatchCharacterRegenEvent,
  buildVoiceTuneEvent,
  buildVoiceLockEvent,
} from '../lib/change-log';
import { api, type SeriesRosterEntry } from '../lib/api';
import { engineForModelKey } from '../lib/tts-models';
import { stageToHash } from '../lib/router';
import { TopBar, type GenerationPillData, type AnalysisPillData } from './top-bar';
import { ModelControlPill } from './ModelControlPill';
import { useTtsLifecycle, type TtsLifecycle } from '../lib/use-tts-lifecycle';
import { useTheme } from '../lib/use-theme';
import { useReverseLocalAnalyzerGuard } from '../hooks/use-reverse-local-analyzer-guard';
import { MiniPlayer } from './mini-player';
import { PreviewListenerView } from '../views/preview-listener';
import { MatchDetailDrawer } from '../modals/match-detail';
import { AppHandoffModal } from '../modals/app-handoff';
import { RegenerateModal } from '../modals/regenerate';
import { CharacterRegenerateModal } from '../modals/character-regenerate';
import { BatchCharacterRegenerateModal } from '../modals/batch-character-regenerate';
import { DriftReportModal } from '../modals/drift-report';
import { ProfileDrawer } from '../modals/profile-drawer';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { ToastStack } from './toast-stack';
import { RevisionDiffPlayer } from '../views/revision-diff';
import { IconRefresh, IconWarning } from '../lib/icons';

/* Lifted from App.tsx's resultDialog state. Routes that need to surface a
   styled post-action dialog (e.g. BooksRoute after delete/reparse) pull
   showInfo/showError from outlet context.

   `ttsLifecycle` is the single source of truth for TTS pill state and the
   Load/Stop side-effects (plan 30). Layout owns the only `useTtsLifecycle()`
   call site; descendant views (Generation today, others as they arrive) read
   the same state via this context instead of spinning up a parallel /health
   poll. Routes that don't need TTS state ignore the field. */
export interface LayoutContext {
  showInfo: (args: {
    title: string;
    body: ReactNode;
    eyebrow?: string;
    primaryLabel?: string;
    onPrimary?: () => void;
  }) => void;
  showError: (title: string, body: ReactNode, eyebrow?: string) => void;
  /* Plan 48: transient toast surface for stream / network errors.
     Coexists with showError (modal-level errors with a CTA) and
     <StaleAudioBanner/> (domain banner anchored under chapter audio).
     Routes call this when a SSE stream halts, an export 5xx fires,
     or any other "did anything happen?" signal needs surfacing
     without interrupting focus. dedupeKey collapses repeated pushes
     into a single timer-bumped toast. */
  pushToast: (args: { kind: 'error' | 'warn' | 'info'; message: string; dedupeKey?: string }) => void;
  ttsLifecycle: TtsLifecycle;
}

export function Layout() {
  const dispatch = useAppDispatch();
  const stage = useAppSelector((s) => s.ui.stage);
  const ui = useAppSelector((s) => s.ui);
  const userDisplayName = useAppSelector((s) => s.account.displayName);
  const characters = useAppSelector((s) => s.cast.characters);
  const chapters = useAppSelector((s) => s.chapters.chapters);
  const activeStream = useAppSelector((s) => s.chapters.activeStream);
  const analysisStream = useAppSelector((s) => s.analysis.activeStream);
  const drift = useAppSelector((s) => s.revisions.drift);
  const pending = useAppSelector((s) => s.revisions.pending);
  const manuscript = useAppSelector((s) => s.manuscript);
  const library = useAppSelector((s) => s.library);
  const voices = useAppSelector((s) => s.voices.voices);

  const stageKind = stage.kind;
  const bookId = (stage as { bookId?: string }).bookId ?? null;
  const view = stage.kind === 'ready' ? stage.view : null;
  /* Drawer is also reachable from the cast-confirmation stage — clicking a
     card on "Meet the cast" sets stage.openProfileId there, so we must read
     it from either stage variant. */
  const openProfileId =
    stage.kind === 'ready' || stage.kind === 'confirm' ? stage.openProfileId : null;

  const matchCharacter = ui.matchDetailFor
    ? (characters.find((c) => c.id === ui.matchDetailFor) ?? null)
    : null;
  const matchVoice = matchCharacter
    ? (voices.find((v) => v.id === matchCharacter.voiceId) ?? null)
    : null;
  const profileCharacter = openProfileId
    ? (characters.find((c) => c.id === openProfileId) ?? null)
    : null;
  const profileVoice = profileCharacter
    ? (voices.find((v) => v.id === profileCharacter.voiceId) ?? null)
    : null;
  const regenCharacter = ui.regenCharacterCtx
    ? (characters.find((c) => c.id === ui.regenCharacterCtx!.characterId) ?? null)
    : null;
  const activeBook = library.books.find((b) => b.bookId === bookId);
  /* Prefer the manuscript slice's title only when it actually reflects the
     book the user is looking at. When the user navigates from analysing
     Book A → generating Book B (via the global generation pill, say),
     the manuscript slice still holds Book A's title until the per-book
     disk hydrate below completes. Reading `manuscript.title` unguarded
     would render "A" on Book B's screen for the duration of that gap;
     anchoring on `manuscript.bookId === bookId` and falling back to the
     library entry keeps the top-bar honest. */
  const manuscriptMatchesBook = bookId != null && manuscript.bookId === bookId;
  const projectTitle =
    stageKind === 'upload' || stageKind === 'books'
      ? null
      : (manuscriptMatchesBook ? manuscript.title : null) || activeBook?.title || null;
  const trackChapter =
    ui.currentTrack != null ? (chapters.find((c) => c.id === ui.currentTrack) ?? null) : null;
  const trackIdx = trackChapter ? chapters.indexOf(trackChapter) : -1;
  const prevTrackAvailable = trackIdx > 0;
  const nextTrackAvailable = trackIdx >= 0 && trackIdx < chapters.length - 1;

  const [resultDialog, setResultDialog] = useState<{
    open: boolean;
    kind: 'info' | 'error';
    eyebrow?: string;
    title: string;
    body: ReactNode;
    primaryLabel?: string;
    onPrimary?: () => void;
  } | null>(null);
  const showInfo: LayoutContext['showInfo'] = (args) =>
    setResultDialog({ open: true, kind: 'info', ...args });
  const showError: LayoutContext['showError'] = (title, body, eyebrow) =>
    setResultDialog({ open: true, kind: 'error', title, body, eyebrow });
  const pushToast: LayoutContext['pushToast'] = (args) =>
    dispatch(notificationsActions.pushToast(args));

  /* Redux → URL sync. Skip the first effect run so a deep-link mount
     (e.g. user opens #/books/abc/cast?chapter=5) doesn't race the route
     element's URL → Redux hydration and clobber back to '/'. After that,
     any dispatch that changes ui.stage gets pushed to the URL via
     react-router's navigate (replace semantics to match the old behavior). */
  const navigate = useNavigate();
  const location = useLocation();
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const target = stageToHash(stage).slice(1);
    const current = location.pathname + location.search;
    if (current !== target) navigate(target, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  /* Account hydration — fetch user-level account settings once on mount so
     the avatar can show the persisted display name and book hydration can
     read defaults from the account slice. Fires once per app boot. */
  useEffect(() => {
    void dispatch(fetchAccountSettings());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Prior-series roster cache, keyed by source bookId. Lazily fetched the
     first time the user opens the profile drawer for a given book so
     the manual continuity-link picker (ProfileDrawer's "From prior books
     in this series" optgroup) has data to render. Cached so reopening
     the drawer within the same book doesn't refetch.
     Errors are stored as empty arrays so a failing fetch doesn't loop. */
  const [priorRosterByBook, setPriorRosterByBook] = useState<Map<string, SeriesRosterEntry[]>>(
    new Map(),
  );
  useEffect(() => {
    if (!openProfileId || !bookId) return;
    if (priorRosterByBook.has(bookId)) return;
    let cancelled = false;
    void api
      .getSeriesRoster(bookId)
      .then((res) => {
        if (cancelled) return;
        setPriorRosterByBook((prev) => new Map(prev).set(bookId, res.characters));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[series-roster] fetch failed', err);
        setPriorRosterByBook((prev) => new Map(prev).set(bookId, []));
      });
    return () => {
      cancelled = true;
    };
  }, [openProfileId, bookId, priorRosterByBook]);

  /* Library hydration — fetch the on-disk workspace whenever the user
     returns to the books stage, and once at mount. */
  useEffect(() => {
    if (stageKind !== 'books' && library.loaded) return;
    let cancelled = false;
    api
      .getLibrary()
      .then((res) => {
        if (!cancelled) dispatch(libraryActions.hydrate(res));
      })
      .catch((err) => {
        console.error('[library] hydrate failed', err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKind]);

  /* Cold-boot active-analyses discovery — surfaces the top-bar
     AnalysisPill on the library route without requiring the user to
     navigate to the specific book's analysing route first to discover
     that there's a paused analysis on disk.

     Fires once at mount. The dispatched action (`hydrateColdBoot`)
     only writes when `analysis.activeStream === null`, so it safely
     loses to a live SSE if the analysing view's own effect runs first
     (e.g. cold-boot directly into `#/books/X/analysing`). Empty
     snapshots list → no-op. Mock mode returns an empty list. */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(api.getActiveAnalyses?.())
      .then((res) => {
        if (cancelled || !res) return;
        /* Fan the same snapshot list into two slices on one network
         round-trip: the analysis slice gets the freshest entry (drives
         the top-bar pill); the library slice gets the whole list
         (drives per-card "Paused — resume?" badges on the library
         home). Order matters: dispatch the library hydrate first so a
         visible badge never leads its top-bar pill by a render. */
        dispatch(libraryActions.hydratePausedSnapshots(res.snapshots));
        if (res.snapshots.length === 0) return;
        const top = res.snapshots[0];
        dispatch(
          analysisActions.hydrateColdBoot({
            bookId: top.bookId,
            manuscriptId: top.manuscriptId,
            bookTitle: top.bookTitle,
            engine: top.engine,
            phaseId: top.phaseId,
            phaseLabel: top.phaseLabel,
            phaseProgress: top.phaseProgress,
            remainingMs: null,
            lastTickAt: top.lastTickAt,
            state: top.state,
            haltReason: top.haltReason,
            haltCode: top.haltCode,
            kind: top.kind,
            subsetChapterIds: top.subsetChapterIds,
          }),
        );
      })
      .catch((err) => {
        console.warn('[analysis] cold-boot scan failed', err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Voice library hydration — derived from every confirmed cast on disk.
     Re-fires when the active book or selected TTS engine changes so
     `source: 'current'` and the engine-specific ttsVoice labels are correct
     for the current UI state. */
  const ttsEngine = useAppSelector((s) => engineForModelKey(s.ui.ttsModelKey));
  useEffect(() => {
    let cancelled = false;
    api
      .getVoices({ currentBookId: bookId ?? undefined, engine: ttsEngine })
      .then((res) => {
        if (!cancelled) dispatch(voicesActions.hydrate(res));
      })
      .catch((err) => {
        console.error('[voices] hydrate failed', err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind, ttsEngine]);

  /* Base-voice catalog — used by the Profile Drawer override picker and
     the Voices view's Base voices tab. Hydrate once at app start (the
     catalog is small and only changes when the sidecar's loaded model
     changes; we let the user re-hit the Voices tab to refresh it).
     Fire-and-forget — the picker shows a "Loading base voices…"
     placeholder when this hasn't completed yet. */
  useEffect(() => {
    let cancelled = false;
    api
      .getBaseVoices()
      .then((res) => {
        if (!cancelled) dispatch(voicesActions.hydrateBaseVoices(res.voices));
      })
      .catch((err) => {
        console.error('[voices] base catalog hydrate failed', err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Per-book hydration. When the user opens a book whose redux state isn't
     populated (page refresh, library click on a previously analysed book, or
     library click on a book mid-analysis), fetch the on-disk .audiobook/*.json
     and seed each slice. */
  useEffect(() => {
    if (!bookId) return;
    if (stageKind !== 'analysing' && stageKind !== 'confirm' && stageKind !== 'ready') return;
    /* Short-circuit only when the slice already reflects THIS book. Without
       the bookId check, navigating from analysing Book A to generating Book B
       (e.g. the user clicks the global generation pill) would skip the disk
       hydrate and leave every per-book slice — manuscript title, chapters,
       cast, revisions, change log, book meta — pinned to Book A.

       The cast-non-empty leg only applies to confirm/ready: analysing
       legitimately starts with cast=[] and grows it via streamed Phase 0a
       cast-update events, so demanding cast there would re-fetch from disk
       mid-stream and clobber the live roster. Confirm/ready can't survive
       cast=[] (the views render "0 speaking characters detected"), so when
       manuscript hydrated but cast did NOT — analyseManuscript's `result`
       event landed with characters absent, or the streaming flow skipped
       the merge-characters path on a Phase 0 cache resume — fall through
       to the fetch so disk fills the gap. */
    const needsCast = stageKind === 'confirm' || stageKind === 'ready';
    const castReady = !needsCast || characters.length > 0;
    if (manuscript.bookId === bookId && manuscript.manuscriptId && manuscript.title && castReady)
      return;
    let cancelled = false;
    api
      .getBookState(bookId)
      .then((res) => {
        if (cancelled) return;
        /* null = no persisted state for this book (mock fresh boot, or
           real backend hasn't seen this book yet). Leave the per-book
           slices on their in-memory defaults; the library-fallback
           hydrate below seeds bookMeta from the library entry. */
        if (res === null) return;
        dispatch(
          manuscriptActions.hydrateFromBookState({
            state: res.state,
            sentences: res.manuscriptEdits?.sentences ?? null,
            wordCount: res.manuscript?.wordCount ?? null,
            format: res.manuscript?.format ?? null,
          }),
        );
        /* Always overwrite the cast slice from disk — including the empty
           case. A reparse deletes cast.json server-side, and without this
           the previous run's roster would survive in redux and the
           Analysing view's "Cast so far" pill would start at 24 instead
           of 0 as Phase 0a streams in fresh detections. */
        dispatch(castActions.setCharacters(res.cast?.characters ?? []));
        dispatch(
          chaptersActions.hydrateFromBookState({
            bookId,
            chapters: res.state.chapters,
            completedSlugs: res.completedSlugs ?? [],
            characters: res.cast?.characters ?? [],
            chapterCharacters: res.chapterCharacters,
          }),
        );
        dispatch(revisionsActions.hydrateFromBookState(res.revisions ?? null));
        dispatch(changeLogActions.hydrateFromBookState(res.changeLog ?? null));
        /* Editable Listen-view metadata: seed from state.json's editorial
           fields, falling back to the cast narrator's name when the book
           predates the narratorCredit field. */
        dispatch(
          bookMetaActions.hydrateFromBookState({
            bookId,
            state: {
              title: res.state.title,
              author: res.state.author,
              series: res.state.series,
              narratorCredit: res.state.narratorCredit ?? null,
              genre: res.state.genre ?? null,
              publicationDate: res.state.publicationDate ?? null,
            },
            narratorFallback: narratorNameFromCast(res.cast?.characters ?? []),
          }),
        );

        /* Cold-boot rehydration for the top-bar AnalysisPill (plan 32, E2).
           If the server has an in-flight or paused/halted analysis for
           this book, restore the snapshot so the pill reappears even
           after a browser reload or full server restart. Returns null
           when there's no rehydratable state — we leave the slice
           alone in that case so opening a book with no analysis
           doesn't clobber another book's still-live pill. */
        api
          .getAnalysisState(bookId)
          .then((snap) => {
            if (cancelled || !snap) return;
            dispatch(
              analysisActions.setActiveStream({
                bookId,
                manuscriptId: snap.manuscriptId,
                bookTitle: res.state.title,
                engine: snap.engine,
                phaseId: snap.phaseId,
                phaseLabel: snap.phaseLabel,
                phaseProgress: snap.phaseProgress,
                remainingMs: null,
                lastTickAt: snap.lastTickAt,
                state: snap.state,
                haltCode: snap.haltCode,
                haltReason: snap.haltReason,
                /* Plan 32 D2: thread the subset discriminator + chapter ids
                 through to the pill so a cold-boot rehydrated subset retry
                 renders "Retrying N chapters" copy instead of the generic
                 phase label. */
                kind: snap.kind,
                subsetChapterIds: snap.subsetChapterIds,
              }),
            );
          })
          .catch((err) => {
            console.warn('[analysis-state] cold-boot fetch failed:', err?.message);
          });
      })
      .catch((err) => {
        console.warn('[book-state] hydrate skipped:', err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind]);

  /* Book-meta fallback hydration — covers the mock-mode path where
     getBookState rejects (no disk workspace) and the realer flow where the
     library lands before the per-book state fetch. Seeds saved[bookId] from
     the library entry the first time the user opens a book; the on-disk
     fetch above overwrites it with the authoritative state.json values when
     it lands. */
  const libraryBooks = useAppSelector((s) => s.library.books);
  const bookMetaSavedKeys = useAppSelector((s) => Object.keys(s.bookMeta.saved).join('|'));
  useEffect(() => {
    if (!bookId || stageKind !== 'ready') return;
    if (bookMetaSavedKeys.split('|').includes(bookId)) return;
    const entry = libraryBooks.find((b) => b.bookId === bookId);
    if (!entry) return;
    dispatch(
      bookMetaActions.hydrateFromBookState({
        bookId,
        state: { title: entry.title, author: entry.author, series: entry.series },
        narratorFallback: narratorNameFromCast(characters),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind, libraryBooks, bookMetaSavedKeys]);

  /* Voice matching — fires once per (stage=confirm, bookId) once the cast
     roster has actually been hydrated. The `characters.length > 0` guard +
     the `voiceMatchFiredFor` ref together solve a race: on a fresh book
     open, the hydrate effect above is still in flight when this effect
     first runs, so `characters` is []. Without the guard we'd fire
     voice-match with an empty roster, the response would carry no
     candidates, and the stale `matchedFrom` already on disk would survive
     unchallenged — keeping older books' cached matches from picking up
     the new `bookId` / `characterId` fields the override flow depends
     on. The ref guard then stops re-firing on every subsequent cast
     mutation (Phase 0a snapshots, applyVoiceMatches itself, profile
     edits). */
  const voiceMatchFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (stageKind !== 'confirm') {
      /* Clear the once-guard when leaving the confirm stage so a
         subsequent re-analyse (books → analysing → confirm) gets a
         fresh voice-match run for the same bookId. Without this, the
         user could re-parse + re-analyse a book and never see updated
         matches. */
      voiceMatchFiredFor.current = null;
      return;
    }
    if (!bookId) return;
    if (characters.length === 0) return;
    if (voiceMatchFiredFor.current === bookId) return;
    voiceMatchFiredFor.current = bookId;
    let cancelled = false;
    api.matchVoices({ bookId, characters }).then((res) => {
      if (!cancelled) dispatch(castActions.applyVoiceMatches(res));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKind, bookId, characters.length]);

  /* Revisions + drift poll — runs while the book is open ('ready'). */
  useEffect(() => {
    if (stageKind !== 'ready' || !bookId) return;
    let cancelled = false;
    const fetchOnce = () =>
      api.pollRevisions({ bookId }).then((res) => {
        if (!cancelled) dispatch(revisionsActions.applyPoll(res));
      });
    fetchOnce();
    const t = setInterval(fetchOnce, 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [stageKind, bookId, dispatch]);

  if (ui.previewMode) {
    return (
      <PreviewListenerView
        chapters={chapters}
        characters={characters}
        onExit={() => dispatch(uiActions.setPreviewMode(false))}
        currentTrack={ui.currentTrack}
        setCurrentTrack={(t) => dispatch(uiActions.setCurrentTrack(t))}
      />
    );
  }

  /* Top-bar TTS pill — shown whenever a book is in scope (Confirm Cast,
     Analysing, Ready). Books/upload don't render it since TTS only matters
     once a manuscript is loaded. Single /health poll owned here; the
     Generation view's local pill reads the same state via LayoutContext
     (plan 30 G1 consolidation). */
  const ttsLifecycle = useTtsLifecycle();
  /* Plan 41 — single mount of the theme hook. Writes the resolved
     theme to <html data-theme> on every change (override, account
     hydrate, OS scheme flip). Return value unused at this layer —
     the paint surface is CSS, not React. */
  useTheme();
  const ctx: LayoutContext = { showInfo, showError, pushToast, ttsLifecycle };

  /* Reverse local-analyzer guard for the regenerate modals (D2 in
     plan 32). The modals' onConfirm callbacks all dispatch a
     chaptersActions.regenerate* action that the
     generation-stream-middleware reconciles into a fresh openHandle —
     i.e. an explicit user-driven start of TTS work. When a local
     analysis is alive, gate that start behind the prompt; otherwise
     pass through. The Resume / Pause toggle in generation.tsx has its
     own instance of this hook so the Generate view's button is
     gated symmetrically. */
  const { guard: reverseAnalyzerGuard, modal: reverseAnalyzerGuardModal } =
    useReverseLocalAnalyzerGuard();
  const showGlobalTtsPill =
    stageKind === 'analysing' || stageKind === 'confirm' || stageKind === 'ready';
  const ttsPillElement = showGlobalTtsPill ? (
    <ModelControlPill
      kind="tts"
      state={ttsLifecycle.state}
      unreachableLabel="Sidecar process not running"
      onLoad={() => {
        void ttsLifecycle.onLoad();
      }}
      onStop={() => {
        void ttsLifecycle.onStop();
      }}
    />
  ) : null;

  /* Re-render once per second while a generation run is alive so the global
     pill's "stalled" computation has a clock to react against. The middleware
     keeps the SSE open across all navigation; this is purely a UI tick to
     surface elapsed-since-last-tick. */
  const [, forceClockTick] = useState(0);
  const pillAlive = activeStream != null;
  useEffect(() => {
    if (!pillAlive) return;
    const id = setInterval(() => forceClockTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [pillAlive]);

  /* Pill is anchored to the middleware's cross-book snapshot, NOT the live
     chapters slice. The snapshot keeps moving while the user is on the
     generating book; it freezes (but keeps rendering) once they navigate
     into a different book, so the pill remains a clickable shortcut back
     to /books/{generatingBookId}/generate from anywhere in the app.
     Computed inline (not memoised) so the per-second forceClockTick above
     keeps the "stalled" check fresh against Date.now(). */
  const generationPill: GenerationPillData | null = (() => {
    if (!activeStream) return null;
    const { bookId: streamBookId, done, total, inProgress, lastTickAt, halted } = activeStream;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const stalled =
      !halted &&
      inProgress > 0 &&
      lastTickAt != null &&
      Date.now() - lastTickAt > STALL_THRESHOLD_MS;
    const state: GenerationPillData['state'] = halted ? 'halted' : stalled ? 'stalled' : 'running';
    return {
      state,
      done,
      total,
      percent,
      onClick: () => navigate(`/books/${streamBookId}/generate`),
    };
  })();

  /* Sibling pill for in-flight analysis (B3). Same shape as the
     generation pill: anchored to the cross-book snapshot in
     `analysis.activeStream`, recomputed inline so the per-second
     forceClockTick refreshes the stalled check. The pill survives
     navigation away from the analysing view; clicking routes back
     to the analysing route for the manuscript that's still in flight. */
  const analysisPill: AnalysisPillData | null = (() => {
    if (!analysisStream) return null;
    const {
      bookId: streamBookId,
      phaseId,
      phaseLabel,
      phaseProgress,
      lastTickAt,
      state: streamState,
      haltReason,
      kind,
      subsetChapterIds,
    } = analysisStream;
    /* Per-phase progress + a coarse phase-weighted overall: phase 0 covers
       the first 45%, phase 1 the next 50%, phase 2 the final 5% (matches
       ANALYSIS_PHASES weighting used by the analysing view's overall
       bar). */
    const phaseWeights = [0.45, 0.5, 0.05];
    const phaseBase = phaseWeights.slice(0, phaseId).reduce((sum, w) => sum + w, 0);
    const phaseShare = phaseWeights[phaseId] ?? 0;
    const overall = Math.min(1, phaseBase + Math.max(0, Math.min(1, phaseProgress)) * phaseShare);
    const percent = Math.round(overall * 100);
    const stalled =
      streamState === 'running' && lastTickAt > 0 && Date.now() - lastTickAt > STALL_THRESHOLD_MS;
    const pillState: AnalysisPillData['state'] =
      streamState === 'halted'
        ? 'halted'
        : streamState === 'paused'
          ? 'paused'
          : stalled
            ? 'stalled'
            : 'running';
    return {
      state: pillState,
      phaseLabel,
      percent,
      haltReason,
      /* Plan 32 D2: pass through the subset discriminator so the pill
         renders "Retrying N chapters" copy instead of the generic
         "Analysing · <phaseLabel>". The pill defaults to main when
         undefined. */
      kind,
      subsetChapterCount: kind === 'subset' ? (subsetChapterIds?.length ?? 0) : undefined,
      onClick: () => {
        if (streamBookId) {
          navigate(`/books/${streamBookId}/analysing`);
        }
      },
    };
  })();

  return (
    <div className={`min-h-screen ${trackChapter ? 'pb-24' : 'pb-20'}`}>
      <TopBar
        stage={stageKind}
        view={view}
        setView={(v) => dispatch(uiActions.changeView(v))}
        projectTitle={projectTitle}
        onHome={() => dispatch(uiActions.goHome())}
        onTitleClick={stageKind === 'confirm' ? () => dispatch(uiActions.reanalyse()) : undefined}
        pendingRevisionsCount={pending.length}
        generationPill={generationPill}
        analysisPill={analysisPill}
        ttsPill={ttsPillElement}
        onOpenRevisions={() => dispatch(uiActions.setShowRevisionPlayer(true))}
        onOpenVoices={() => dispatch(uiActions.openVoices())}
        onOpenChangelog={() => dispatch(uiActions.openChangelog())}
        onOpenAccount={() => dispatch(uiActions.openAccount())}
        userDisplayName={userDisplayName}
      />

      <Outlet context={ctx} />

      <ToastStack />

      {stageKind === 'ready' && bookId && (
        <MiniPlayer
          chapter={trackChapter}
          bookId={bookId}
          onClose={() => dispatch(uiActions.setCurrentTrack(null))}
          onPrev={() =>
            prevTrackAvailable && dispatch(uiActions.setCurrentTrack(chapters[trackIdx - 1].id))
          }
          onNext={() =>
            nextTrackAvailable && dispatch(uiActions.setCurrentTrack(chapters[trackIdx + 1].id))
          }
          prevAvailable={prevTrackAvailable}
          nextAvailable={nextTrackAvailable}
        />
      )}

      {ui.matchDetailFor && (
        <MatchDetailDrawer
          character={matchCharacter}
          voice={matchVoice}
          onClose={() => dispatch(uiActions.setMatchDetailFor(null))}
          onConfirm={() => dispatch(uiActions.setMatchDetailFor(null))}
          onDecline={() => {
            if (ui.matchDetailFor) dispatch(castActions.declineMatch(ui.matchDetailFor));
            dispatch(uiActions.setMatchDetailFor(null));
          }}
        />
      )}
      {ui.handoffApp && (
        <AppHandoffModal
          app={ui.handoffApp}
          onClose={() => dispatch(uiActions.setHandoffApp(null))}
          onComplete={() => dispatch(uiActions.setHandoffApp(null))}
        />
      )}
      {ui.regenChapter && (
        <RegenerateModal
          chapter={ui.regenChapter}
          defaultScope={ui.regenInitialScope ?? 'this'}
          forwardCount={chapters.filter((c) => c.id >= ui.regenChapter!.id).length}
          onClose={() => dispatch(uiActions.setRegenChapter(null))}
          onConfirm={({ reason, scope, note }) => {
            const chapter = ui.regenChapter;
            /* Close the regen modal first so the reverse-guard modal
               (rendered below) doesn't stack on top of it. */
            dispatch(uiActions.setRegenChapter(null));
            reverseAnalyzerGuard(() => {
              if (chapter) {
                const affectedCount =
                  scope === 'forward' ? chapters.filter((c) => c.id >= chapter.id).length : 1;
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildChapterRegenEvent({
                      chapter,
                      scope,
                      reason,
                      note,
                      affectedChapterCount: affectedCount,
                    }),
                  ),
                );
                dispatch(chaptersActions.regenerateChapter({ chapterId: chapter.id, scope }));
              }
              dispatch(uiActions.changeView('generate'));
            });
          }}
        />
      )}
      {ui.regenCharacterCtx && (
        <CharacterRegenerateModal
          character={regenCharacter}
          chapters={chapters}
          defaultChapterId={ui.regenCharacterCtx.defaultChapterId}
          onClose={() => dispatch(uiActions.setRegenCharacterCtx(null))}
          onConfirm={({ characterId, chapterIds, reason, note }) => {
            dispatch(uiActions.setRegenCharacterCtx(null));
            reverseAnalyzerGuard(() => {
              if (regenCharacter) {
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildCharacterRegenEvent({
                      character: regenCharacter,
                      chapterIds,
                      reason,
                      note,
                    }),
                  ),
                );
              }
              dispatch(chaptersActions.regenerateCharacter({ characterId, chapterIds }));
              dispatch(uiActions.changeView('generate'));
            });
          }}
        />
      )}
      {ui.batchRegenIds && (
        <BatchCharacterRegenerateModal
          characterIds={ui.batchRegenIds}
          characters={characters}
          chapters={chapters}
          onClose={() => dispatch(uiActions.setBatchRegenIds(null))}
          onConfirm={({ characterIds, chapterIds, reason, note }) => {
            dispatch(uiActions.setBatchRegenIds(null));
            reverseAnalyzerGuard(() => {
              const targets = characters.filter((c) => characterIds.includes(c.id));
              if (targets.length) {
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildBatchCharacterRegenEvent({
                      characters: targets,
                      chapterIds,
                      reason,
                      note,
                    }),
                  ),
                );
              }
              dispatch(chaptersActions.batchRegenerateCharacters({ characterIds, chapterIds }));
              dispatch(uiActions.changeView('generate'));
            });
          }}
        />
      )}
      {ui.showDriftReport && (
        <DriftReportModal
          events={drift}
          characters={characters}
          onClose={() => dispatch(uiActions.setShowDriftReport(false))}
          onRegenerateChapter={(charId, chapterId) => {
            dispatch(uiActions.setShowDriftReport(false));
            dispatch(
              uiActions.setRegenCharacterCtx({ characterId: charId, defaultChapterId: chapterId }),
            );
          }}
          /* Plan 20 C1+C2: severe drift events skip the regen-modal confirmation.
             Same change-log entry + same regenerateCharacter dispatch the modal's
             onConfirm would have fired, just without the intermediate click. The
             reverse local-analyzer guard still gates the action so a live local
             analysis prompts before TTS starts. */
          onAutoQueueRegenerate={(charId, chapterId) => {
            dispatch(uiActions.setShowDriftReport(false));
            const character = characters.find((c) => c.id === charId);
            reverseAnalyzerGuard(() => {
              if (character) {
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildCharacterRegenEvent({
                      character,
                      chapterIds: [chapterId],
                      reason: 'drift_auto_queued',
                      note: 'Auto-queued from severe drift event.',
                    }),
                  ),
                );
              }
              dispatch(
                chaptersActions.regenerateCharacter({
                  characterId: charId,
                  chapterIds: [chapterId],
                }),
              );
              dispatch(uiActions.changeView('generate'));
            });
          }}
          onDismiss={(eventId) => dispatch(revisionsActions.dismissDrift(eventId))}
        />
      )}
      {profileCharacter &&
        (() => {
          /* Build the manual-link picker's prior-roster list. Strip any
           entries that have already been auto-matched (any local cast
           member's matchedFrom points at them) — re-linking would just
           be a no-op alias re-write. Bucket on (bookId, characterId)
           since two different prior books could each have a character
           named "Sophie" with the same id. */
          const priorRoster = bookId ? (priorRosterByBook.get(bookId) ?? []) : [];
          const alreadyLinked = new Set<string>();
          for (const c of characters) {
            const mf = c.matchedFrom;
            if (mf?.bookId && mf?.characterId) {
              alreadyLinked.add(`${mf.bookId}::${mf.characterId}`);
            }
          }
          const mergeCandidatesPrior = priorRoster
            .filter((p) => !alreadyLinked.has(`${p.bookId}::${p.id}`))
            .map((p) => ({ id: p.id, name: p.name, bookId: p.bookId, bookTitle: p.bookTitle }));
          return (
            <ProfileDrawer
              character={profileCharacter}
              voice={profileVoice ?? undefined}
              mergeCandidates={
                bookId ? characters.filter((c) => c.id !== profileCharacter.id) : undefined
              }
              mergeCandidatesPrior={bookId ? mergeCandidatesPrior : undefined}
              onMerge={
                bookId
                  ? async (sourceId, targetId) => {
                      const res = await api.mergeCharacters({ bookId, sourceId, targetId });
                      dispatch(castActions.applyMerge({ characters: res.characters }));
                      /* Source character has just disappeared from the cast — drop the
               drawer so React doesn't try to render a profile for a missing
               id on the next pass. */
                      dispatch(uiActions.setOpenProfileId(null));
                    }
                  : undefined
              }
              onLinkPrior={
                bookId
                  ? async (sourceId, targetBookId, targetCharacterId) => {
                      const res = await api.linkPriorCharacter({
                        bookId,
                        sourceCharacterId: sourceId,
                        targetBookId,
                        targetCharacterId,
                      });
                      dispatch(
                        castActions.applyManualMatch({
                          characterId: sourceId,
                          matchedFrom: res.matchedFrom,
                          voiceId: res.voiceId,
                        }),
                      );
                      /* Close so the user lands back on the confirm card and can see
               the "Continuity preserved" footer + "Sync profile" checkbox
               that the new matchedFrom triggers. Mirrors onMerge's close. */
                      dispatch(uiActions.setOpenProfileId(null));
                    }
                  : undefined
              }
              onClose={() => dispatch(uiActions.setOpenProfileId(null))}
              onSave={(updated, meta) => {
                const prior = profileCharacter;
                dispatch(
                  castActions.setCharacters(
                    characters.map((c) => (c.id === updated.id ? updated : c)),
                  ),
                );
                /* Only log a tune event when the drawer actually saved a tuned
               voice — the drawer also fires onSave from the "Discard"-less
               identity edits via the same path, and we don't want to spam
               the audit trail when no real tuning happened. */
                if (updated.voiceState === 'tuned') {
                  dispatch(
                    changeLogActions.appendLogEvent(
                      buildVoiceTuneEvent({
                        character: updated,
                        hadConflict: meta.hadConflict,
                      }),
                    ),
                  );
                }
                /* Stale-audio detection: did any voice-driving field change,
               and does the character speak in any already-rendered
               (`state === 'done'`) chapter? Both must hold for the
               banner to fire. Drives the same regen pipeline the
               CharacterRegenerateModal does but bypasses the modal
               step + the 30s drift poll wait. */
                if (prior) {
                  const voiceChanged =
                    prior.voiceId !== updated.voiceId ||
                    prior.gender !== updated.gender ||
                    prior.ageRange !== updated.ageRange ||
                    JSON.stringify(prior.tone ?? {}) !== JSON.stringify(updated.tone ?? {});
                  if (voiceChanged) {
                    const affectedChapters = chapters
                      .filter(
                        (ch) => ch.state === 'done' && ch.characters && updated.id in ch.characters,
                      )
                      .map((ch) => ch.id);
                    if (affectedChapters.length > 0) {
                      dispatch(
                        uiActions.setStaleAudio({
                          characterId: updated.id,
                          characterName: updated.name,
                          chapterIds: affectedChapters,
                        }),
                      );
                    }
                  }
                }
                dispatch(uiActions.setOpenProfileId(null));
              }}
              onLock={(character) => {
                /* Idempotent: clicking Lock when already locked is a no-op for
               the slice but still useful as a manual re-acknowledge — but
               the change-log entry would be redundant, so skip it. */
                if (character.voiceState === 'locked') return;
                dispatch(castActions.lockVoice(character.id));
                dispatch(changeLogActions.appendLogEvent(buildVoiceLockEvent({ character })));
              }}
              onShowMatchDetail={(id) => dispatch(uiActions.setMatchDetailFor(id))}
              onRegenerateCharacter={(charId) =>
                dispatch(uiActions.setRegenCharacterCtx({ characterId: charId }))
              }
            />
          );
        })()}
      {ui.showRevisionPlayer && pending[0] && bookId && (
        <RevisionDiffPlayer
          revision={pending[0]}
          bookId={bookId}
          chapter={chapters.find((c) => c.id === pending[0].chapterId)}
          character={characters.find((c) => c.id === pending[0].characterId)}
          onClose={() => dispatch(uiActions.setShowRevisionPlayer(false))}
          onAccept={(selection) => {
            /* Accept = the new (B) render wins. Persist the user's
               per-segment selection on the slice (write-only; future
               per-segment regen will consume), drop the revision from
               pending, AND fire the server-side delete of the preserved
               `.previous.*` pair. Mock mode no-ops on the network call;
               real mode tells the server the prior take is dead. */
            const id = pending[0].id;
            const chapterId = pending[0].chapterId;
            dispatch(revisionsActions.acceptRevision({ revisionId: id, selection }));
            dispatch(uiActions.setShowRevisionPlayer(false));
            api.acceptChapterRevision({ bookId, chapterId }).catch((err) => {
              /* eslint-disable-next-line no-console */
              console.warn('[revision-diff] accept network call failed:', err);
            });
          }}
          onReject={() => {
            /* Reject = the prior (A) render wins. Drop the pending
               revision and ask the server to promote `.previous.*` over
               the live render. 409 surfaces as an error toast so the
               user knows to wait if a generation is mid-flight. */
            const id = pending[0].id;
            const chapterId = pending[0].chapterId;
            dispatch(revisionsActions.rejectRevision(id));
            dispatch(uiActions.setShowRevisionPlayer(false));
            api.rejectChapterRevision({ bookId, chapterId }).catch((err) => {
              /* eslint-disable-next-line no-console */
              console.warn('[revision-diff] reject network call failed:', err);
            });
          }}
        />
      )}
      {resultDialog && (
        <ConfirmDialog
          open={resultDialog.open}
          eyebrow={resultDialog.eyebrow}
          title={resultDialog.title}
          icon={
            resultDialog.kind === 'error' ? (
              <IconWarning className="w-4 h-4" />
            ) : (
              <IconRefresh className="w-4 h-4" />
            )
          }
          variant={resultDialog.kind === 'error' ? 'danger' : 'default'}
          body={resultDialog.body}
          primaryLabel={resultDialog.kind === 'info' ? resultDialog.primaryLabel : undefined}
          onPrimaryAction={resultDialog.kind === 'info' ? resultDialog.onPrimary : undefined}
          onClose={() => setResultDialog(null)}
        />
      )}
      {reverseAnalyzerGuardModal}
    </div>
  );
}
