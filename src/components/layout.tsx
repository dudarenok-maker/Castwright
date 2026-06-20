import { useEffect, useMemo, useRef, useState, Suspense, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { DelayedSpinner } from './delayed-spinner';
import { BuildStamp } from './build-stamp';
import { useAppDispatch, useAppSelector, useAppSelectorShallow } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { fetchAccountSettings } from '../store/account-slice';
import { fetchTourStatus } from '../store/tour-slice';
import {
  aggregateStreamsByBook,
  chaptersActions,
  forwardRegenChapters,
  selectActiveStreams,
  STALL_THRESHOLD_MS,
} from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { analysisActions } from '../store/analysis-slice';
import { castDesignActions } from '../store/cast-design-slice';
import { revisionsActions, selectDriftGroupsByBook } from '../store/revisions-slice';
import { libraryActions } from '../store/library-slice';
import { voicesActions } from '../store/voices-slice';
import { changeLogActions } from '../store/change-log-slice';
import { bookMetaActions } from '../store/book-meta-slice';
import { notificationsActions } from '../store/notifications-slice';
import { listenProgressActions } from '../store/listen-progress-slice';
import {
  buildChapterRegenEvent,
  buildCharacterRegenEvent,
  buildVoiceTuneEvent,
  buildVoiceLockEvent,
  buildNameChangeEvent,
} from '../lib/change-log';
import { api, type SeriesRosterEntry } from '../lib/api';
import type { Character } from '../lib/types';
import { engineForModelKey } from '../lib/tts-models';
import { computeOverallProgress } from '../lib/analysis-progress';
import { computeReanalyseProgress } from '../lib/reanalyse-progress';
import { filterLinkablePriorCandidates } from '../lib/prior-link-candidates';
import { parseDuration } from '../lib/time';
import { stageToHash } from '../lib/router';
import {
  TopBar,
  summarizeStatus,
  type GenerationPillData,
  type AnalysisPillData,
  type DesignPillData,
  type StatusDetail,
} from './top-bar';
import { ModelControlPill } from './ModelControlPill';
import { AsrStatusBadge } from './AsrStatusBadge';
import { TtsNoticeBanner } from './tts-notice-banner';
import { WhatsNewBanner } from './whats-new-banner';
import { UpdateNotifierBanner } from './update-notifier-banner';
import { useTtsLifecycle, type TtsLifecycle } from '../lib/use-tts-lifecycle';
import {
  selectEnginesInUse,
  selectDefaultTtsEngine,
  type EngineFamily,
} from '../store/engines-in-use-selector';
import { useTheme } from '../lib/use-theme';
import { useAccessibilitySettings } from '../lib/use-accessibility-settings';
import { useReverseLocalAnalyzerGuard } from '../hooks/use-reverse-local-analyzer-guard';
import { MiniPlayer } from './mini-player';
import { PreviewListenerView } from '../views/preview-listener';
import { MatchDetailDrawer } from '../modals/match-detail';
import { RegenerateModal } from '../modals/regenerate';
import { CharacterRegenerateModal } from '../modals/character-regenerate';
import { DriftReportModal } from '../modals/drift-report';
import { ProfileDrawer } from '../modals/profile-drawer';
import { FixCharacterAudioModal } from '../modals/fix-character-audio';
import {
  DuplicateReviewModal,
  type DuplicateReviewPair,
} from '../modals/duplicate-review-modal';
import {
  detectDuplicateCandidates,
  type BookSeriesInfo,
  type DuplicateCandidate,
} from '../lib/cross-book-duplicates';
import { ReattributeLinesModal } from '../modals/reattribute-lines';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { QueueModalContainer } from '../modals/queue-modal';
import { loadQueue, enqueueQueueEntries } from '../store/queue-thunks';
import { selectGenerationActivityCount } from '../store/queue-slice';
import { importGenerationView, importUploadView } from '../routes/prefetch';
import { ToastStack } from './toast-stack';
import { TourOverlay } from './tour/tour-overlay';
import { RevisionDiffPlayer } from '../views/revision-diff';
import { RevisionTimelineModal } from './revision-timeline-modal';
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
  pushToast: (args: {
    kind: 'error' | 'warn' | 'info';
    message: string;
    dedupeKey?: string;
  }) => void;
  ttsLifecycle: TtsLifecycle;
  /* fs-26 — open the per-character "Fix audio" modal, optionally pre-scoped to
     a single chapter + segment(s) (the Listen-view per-line re-record entry).
     Routes under the Outlet call this rather than mounting their own copy. */
  openFixCharacterAudio: (args: {
    characterId: string;
    preScoped?: { mode: 'remix' | 'rerecord'; chapterId: number; segmentIndices: number[] };
  }) => void;
  /* Prior-series roster for the currently-open book. Lazily fetched
     once per book — empty array until the fetch lands or if the book
     is a standalone / has no prior series-mates. Consumers (today:
     ProfileDrawer manual-link optgroup, ManuscriptView reassign
     picker) read this without spinning up their own /series-roster
     poll. */
  priorRoster: SeriesRosterEntry[];
}

export function Layout() {
  const dispatch = useAppDispatch();
  const stage = useAppSelector((s) => s.ui.stage);
  const ui = useAppSelector((s) => s.ui);
  const userDisplayName = useAppSelector((s) => s.account.displayName);
  /* Drives the top-bar queue chip's visibility. Reflects real workspace queue
     entries when present, else the live generation run so the chip (the modal's
     entry point on non-Generate views) stays reachable while a book generates
     via the reconcile-driven path, which writes no queue entry. */
  const queueCount = useAppSelector(selectGenerationActivityCount);
  /* Plan 89 C3 — `characters` and `chapters.chapters` are large arrays the
     Layout reads every render. Use shallow equality so unrelated slice mutations
     (e.g. a foreign book's drift poll bumping `revisions`, or a heartbeat tick
     into `analysis.activeStream`) don't force a full Layout re-render when the
     array identity is structurally unchanged. */
  const characters = useAppSelectorShallow((s) => s.cast.characters);
  const chapters = useAppSelectorShallow((s) => s.chapters.chapters);
  const activeStreams = useAppSelectorShallow(selectActiveStreams);
  const analysisStream = useAppSelector((s) => s.analysis.activeStream);
  const designSnapshot = useAppSelector((s) => s.castDesign.active);
  const driftGroupsByBook = useAppSelector(selectDriftGroupsByBook);
  const bookMetaSaved = useAppSelector((s) => s.bookMeta.saved);
  const pending = useAppSelector((s) => s.revisions.pending);
  const manuscript = useAppSelector((s) => s.manuscript);
  const library = useAppSelector((s) => s.library);
  const voices = useAppSelector((s) => s.voices.voices);
  /* fe-16 — per-character render fallback engine for the profile drawer's
     Status pill (Qwen → Kokoro). Same map the cast view threads. */
  const renderedFallbackByCharacter = useAppSelector(
    (s) => s.cast.renderedFallbackByCharacter,
  );

  const stageKind = stage.kind;
  const bookId = (stage as { bookId?: string }).bookId ?? null;
  const view = stage.kind === 'ready' ? stage.view : null;
  /* Drawer is also reachable from the cast-confirmation stage — clicking a
     card on "Meet the cast" sets stage.openProfileId there, so we must read
     it from either stage variant. */
  const openProfileId =
    stage.kind === 'ready' || stage.kind === 'confirm' ? stage.openProfileId : null;

  /* Prefetch the lazy GenerationView chunk (routes/index.tsx loads it via
     React.lazy) once the user is inside a book OR any generation run is live,
     so opening the Generate view paints from cache instead of showing the
     route Suspense fallback while a cold chunk downloads — which reads as
     "stuck on Loading…" worst when the main thread is busy mid-generation.
     import() is idempotent (Vite dedupes to the same chunk the lazy awaits);
     the ref keeps it to a single fire. */
  const generationChunkWarmed = useRef(false);
  useEffect(() => {
    if (generationChunkWarmed.current) return;
    if (stageKind !== 'ready' && activeStreams.length === 0) return;
    generationChunkWarmed.current = true;
    void importGenerationView();
  }, [stageKind, activeStreams.length]);

  /* Same trick for the lazy UploadView chunk: warm it while the user sits on
     the library landing page, the page hosting the "New project" entry. The
     upload chunk graph is heavy (upload.tsx + manuscript-diff.tsx), so the
     first cold download otherwise stretches the "#/new" route Suspense
     fallback into a multi-second "Loading…". Gated on the books stage so it
     doesn't compete with first paint of any in-book view; one-shot via ref. */
  const uploadChunkWarmed = useRef(false);
  useEffect(() => {
    if (uploadChunkWarmed.current) return;
    if (stageKind !== 'books') return;
    uploadChunkWarmed.current = true;
    void importUploadView();
  }, [stageKind]);

  const matchCharacter = ui.matchDetailFor
    ? (characters.find((c) => c.id === ui.matchDetailFor) ?? null)
    : null;
  const matchVoice = matchCharacter
    ? (voices.find((v) => v.id === matchCharacter.voiceId) ?? null)
    : null;
  const profileCharacter = openProfileId
    ? (characters.find((c) => c.id === openProfileId) ?? null)
    : null;

  /* Zip the slice-level grouped drift selection with book titles + the
     active book's cast for the modal's `groupsByBook` prop. Memoised so
     unrelated re-renders don't break referential equality (the modal's
     `DriftGroupCard` is React.memo-wrapped — a stable group reference
     here is what lets it skip a render). */
  const driftGroupsByBookView = useMemo(
    () =>
      driftGroupsByBook.map((g) => ({
        bookId: g.bookId,
        /* bookMeta.saved is sparse (only books the user has actively
           opened/edited this session); library.books always carries a
           clean workspace-scan title. Fall through saved → library →
           raw bookId so cross-book drift cards don't show the slug. */
        bookTitle:
          bookMetaSaved[g.bookId]?.title ||
          library.books.find((b) => b.bookId === g.bookId)?.title ||
          g.bookId,
        characters: g.bookId === bookId ? characters : [],
        groups: g.groups,
      })),
    [driftGroupsByBook, bookMetaSaved, library.books, characters, bookId],
  );
  const profileVoice = profileCharacter
    ? (voices.find((v) => v.id === profileCharacter.voiceId) ?? null)
    : null;

  /* fe-8 — cross-book "Possible duplicate of …" chip in the profile drawer.
     Reuse the voices-view predicate (`detectDuplicateCandidates`) against the
     open book's voices + cast + the library's per-book series metadata. We
     only need the ONE candidate whose open-book side IS the character whose
     drawer is open. The foreign side's Character isn't hydrated here (it lives
     in another book's cast.json), so suppression falls back to the foreign
     Voice's own carried aliases/notLinkedTo — exactly the global-tab path the
     voices view relies on. `duplicateReviewOpen` mounts the modal; the foreign
     cast is hydrated on open so the modal's link/variant buttons enable. */
  const [duplicateReviewOpen, setDuplicateReviewOpen] = useState(false);
  const [foreignCast, setForeignCast] = useState<{ bookId: string; characters: Character[] } | null>(
    null,
  );
  const profileDuplicateCandidate = useMemo<DuplicateCandidate | null>(() => {
    if (!profileCharacter) return null;
    if (voices.length < 2 || library.books.length === 0) return null;
    const seriesByBookId = new Map<string, BookSeriesInfo>();
    for (const b of library.books) {
      seriesByBookId.set(b.bookId, {
        author: b.author,
        series: b.series,
        isStandalone: b.isStandalone,
      });
    }
    const charactersByBookId = new Map<string, Character[]>();
    if (bookId) charactersByBookId.set(bookId, characters);
    const candidates = detectDuplicateCandidates({
      library: voices,
      seriesByBookId,
      charactersByBookId,
    });
    /* Pick the candidate whose open-book side is the open-profile character.
       The open-book voice resolves via the character's voiceId (or its id). */
    const openVoiceId = profileVoice?.id ?? profileCharacter.voiceId ?? profileCharacter.id;
    return (
      candidates.find(
        (c) =>
          (c.a.voice.bookId === bookId && c.a.voice.id === openVoiceId) ||
          (c.b.voice.bookId === bookId && c.b.voice.id === openVoiceId),
      ) ?? null
    );
  }, [profileCharacter, profileVoice, voices, library.books, characters, bookId]);

  /* Orient the candidate so `near` is the open-book side and `far` is the
     other book. The chip + modal read `far` for the partner name/title. */
  const profileDuplicateOriented = useMemo(() => {
    if (!profileDuplicateCandidate) return null;
    const c = profileDuplicateCandidate;
    const aIsNear = c.a.voice.bookId === bookId;
    return { near: aIsNear ? c.a : c.b, far: aIsNear ? c.b : c.a };
  }, [profileDuplicateCandidate, bookId]);

  /* On chip-open, hydrate the FAR book's cast so the modal can resolve both
     characters and enable the link/variant actions. Mirrors the voices view's
     `hydrateForeignCast`, scoped to the single far book. */
  useEffect(() => {
    if (!duplicateReviewOpen || !profileDuplicateOriented) return;
    const farBookId = profileDuplicateOriented.far.voice.bookId;
    if (foreignCast?.bookId === farBookId) return;
    let cancelled = false;
    api
      .getBookState(farBookId)
      .then((res) => {
        if (cancelled) return;
        const cast = res?.cast?.characters ?? [];
        setForeignCast({ bookId: farBookId, characters: cast });
      })
      .catch((err) => {
        console.warn('[duplicate-review] foreign cast hydrate failed', (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [duplicateReviewOpen, profileDuplicateOriented, foreignCast?.bookId]);

  /* Build the modal pair: near side from redux, far side from the hydrated
     foreign cast (resolved by the far voice's id). Far character stays null
     until hydration lands — the modal disables its actions + shows a loading
     hint in that window. */
  const duplicateReviewPair = useMemo<DuplicateReviewPair | null>(() => {
    if (!profileDuplicateOriented) return null;
    const { near, far } = profileDuplicateOriented;
    let farCharacter = far.character;
    if (!farCharacter && foreignCast?.bookId === far.voice.bookId) {
      farCharacter =
        foreignCast.characters.find(
          (c) => c.voiceId === far.voice.id || c.id === far.voice.id,
        ) ?? null;
    }
    return { a: near, b: { voice: far.voice, character: farCharacter } };
  }, [profileDuplicateOriented, foreignCast]);

  const duplicateReviewLoading =
    !!profileDuplicateOriented &&
    (!duplicateReviewPair?.b.character || foreignCast?.bookId !== profileDuplicateOriented.far.voice.bookId);

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
  /* Reattribute Lines modal state — populated by the ProfileDrawer's
     unlink-alias callback after the server returns its `impactedChapters`
     payload. The modal renders one card per impacted chapter and reuses
     `manuscriptActions.setSentenceCharacter` for reassignment. Closing
     resets to null. */
  const [reattributeModal, setReattributeModal] = useState<{
    sourceCharacterId: string;
    sourceCharacterName: string;
    newCharacterId: string;
    aliasName: string;
    impactedChapters: { chapterId: number; candidateSentenceIds: number[] }[];
  } | null>(null);
  /* fs-26 — per-character "Fix audio" (loudness/re-record splice) modal.
     Holds the characterId opened from the ProfileDrawer; null = closed. */
  const [fixAudioFor, setFixAudioFor] = useState<string | null>(null);
  /* fs-26 — when opened from the Listen-view marker ("Fix this line") the modal
     is pre-scoped to one chapter + segment(s); null = the whole-character
     ProfileDrawer path. Cleared in lockstep with fixAudioFor on close. */
  const [fixAudioPreScoped, setFixAudioPreScoped] = useState<{
    mode: 'remix' | 'rerecord';
    chapterId: number;
    segmentIndices: number[];
  } | null>(null);
  const showInfo: LayoutContext['showInfo'] = (args) =>
    setResultDialog({ open: true, kind: 'info', ...args });
  const showError: LayoutContext['showError'] = (title, body, eyebrow) =>
    setResultDialog({ open: true, kind: 'error', title, body, eyebrow });
  const pushToast: LayoutContext['pushToast'] = (args) =>
    dispatch(notificationsActions.pushToast(args));
  const openFixCharacterAudio: LayoutContext['openFixCharacterAudio'] = ({
    characterId,
    preScoped,
  }) => {
    setFixAudioPreScoped(preScoped ?? null);
    setFixAudioFor(characterId);
  };

  /* Redux → URL sync. Skip the first effect run so a deep-link mount
     (e.g. user opens #/books/abc/cast?chapter=5) doesn't race the route
     element's URL → Redux hydration and clobber back to '/'. After that,
     any dispatch that changes ui.stage gets pushed to the URL via
     react-router's navigate (replace semantics to match the old behavior). */
  const navigate = useNavigate();
  const location = useLocation();
  const skipFirst = useRef(true);
  /* Plan 102 — cold-boot hydrate of the workspace queue. One call per app
     mount; the modal re-fetches on every open to catch cross-tab mutations
     since we deliberately don't broadcast queue actions over BroadcastChannel
     in v1 (single-writer per-workspace contract holds). */
  useEffect(() => {
    dispatch(loadQueue()).catch((e: unknown) => {
      console.warn('[layout] initial loadQueue failed', e);
    });
  }, [dispatch]);
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

  /* Reset window scroll on hash-route change. React Router v6 does not
     restore scroll for hash routes by default and we never added a
     <ScrollRestoration>, so without this the scroll position from one
     view (e.g. the new-book upload form auto-scrolled to a deeper textarea)
     leaks into the next view's landing (e.g. confirm-cast loaded at
     scrollY ≈ 157, hiding the "Cast confirmation / Meet the cast" hero).
     Watches `location.pathname` so view-toggles within a book (manuscript
     → cast → listen, all under #/books/<id>/*) also re-anchor to the top
     instead of inheriting the previous view's scroll depth. */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  /* Account hydration — fetch user-level account settings once on mount so
     the avatar can show the persisted display name and book hydration can
     read defaults from the account slice. Fires once per app boot. */
  useEffect(() => {
    void dispatch(fetchAccountSettings());
    void dispatch(fetchTourStatus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* fs-21 — boot-splash readiness gate. Probe setup readiness ONCE per app
     boot (`[]` deps — never re-fetch on navigation). While the probe is in
     flight `setupReady === null` and the splash below blocks the first paint.
     On resolve: `!ready` → redirect to #/setup (a harmless no-op if already
     there, so we don't read the current stage — Layout does NOT import
     `store`); `ready` → render normally. The boot fetch runs buildDiagnostics
     server-side (~2 s worst-case probe timeout); a failed probe fails OPEN so
     a flaky readiness endpoint never locks the user out of the app. */
  const [setupReady, setSetupReady] = useState<boolean | null>(null); // null = checking
  useEffect(() => {
    let cancelled = false;
    api
      .getSetupReadiness()
      .then((r) => {
        if (cancelled) return;
        setSetupReady(r.ready);
        // Redirecting to /setup when already there is a harmless no-op, so we
        // don't need to read the current stage (Layout does NOT import `store`).
        if (!r.ready) navigate('/setup', { replace: true });
      })
      .catch(() => {
        if (!cancelled) setSetupReady(true);
      }); // probe failure must not lock the app out
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Prior-series roster cache, keyed by source bookId. Fetched the
     first time we know there's an open book — feeds both the
     ProfileDrawer's "From prior books in this series" optgroup AND
     the manuscript-view reassign picker (so both surfaces share one
     /series-roster round-trip per book). Cached so subsequent surface
     opens within the same book don't refetch.
     Errors are stored as empty arrays so a failing fetch doesn't loop. */
  const [priorRosterByBook, setPriorRosterByBook] = useState<Map<string, SeriesRosterEntry[]>>(
    new Map(),
  );
  useEffect(() => {
    if (!bookId) return;
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
  }, [bookId, priorRosterByBook]);

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
        dispatch(libraryActions.hydrateError(err instanceof Error ? err.message : String(err)));
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

  /* Cold-boot re-subscribe to an in-flight "Design full cast" job (the
     resilience the third status pill promises — analysis only rehydrates a
     frozen disk snapshot, so the design pill needs an actual re-attach). When
     a book is open, probe its design status; if a job is live, dispatch
     `resubscribe`, which the cast-design middleware turns into a bare SSE that
     replays `resume_from` and keeps ticking. Re-fires when the open book
     changes. No-op (in-memory only) on a server with no live job; the mock
     status always returns inactive. */
  const openBookId = stage.kind === 'ready' ? stage.bookId : null;
  useEffect(() => {
    if (!openBookId) return;
    let cancelled = false;
    void Promise.resolve(api.getCastDesignStatus?.(openBookId))
      .then((res) => {
        if (cancelled || !res?.active) return;
        dispatch(castDesignActions.resubscribe({ bookId: openBookId }));
      })
      .catch((err) => {
        console.warn('[cast-design] cold-boot probe failed', err);
      });
    void Promise.resolve(api.getSingleDesignStatus?.(openBookId))
      .then((st) => {
        if (cancelled || !st?.active) return;
        dispatch(castDesignActions.resubscribeSingle({ bookId: openBookId }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openBookId, dispatch]);

  /* Voice library hydration — derived from every confirmed cast on disk.
     Re-fires when the active book or selected TTS engine changes so
     `source: 'current'` and the engine-specific ttsVoice labels are correct
     for the current UI state.

     ALSO re-fires as generation renders chapters: a bespoke Qwen voice's
     `generated` flag is derived server-side from rendered segments
     (collectRenderedQwenVoiceNames), and the cast Status column reads it to
     show "Designed" vs "Generated". `genProgress` sums the completed-chapter
     count across every active stream, so each rendered chapter (in ANY book —
     the concurrent-multibook invariant) bumps it and triggers a refetch, and
     the count drops when a stream clears on completion. Without this the table
     only refreshed on book/engine/stage change, so a voice generated while the
     user sat on the cast or voices view stayed "Designed" until they navigated
     away and back. */
  const ttsEngine = useAppSelector((s) => engineForModelKey(s.ui.ttsModelKey));
  const genProgress = useAppSelector((s) =>
    Object.values(s.chapters.activeStreams).reduce((n, st) => n + st.done, 0),
  );
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
  }, [bookId, stageKind, ttsEngine, genProgress]);

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
        /* fe-16 — per-character render fallback engine (Qwen → Kokoro). Empty
           map clears stale entries when a re-render dropped the fallback. */
        dispatch(castActions.setRenderedFallback(res.renderedFallbackByCharacter ?? {}));
        dispatch(
          chaptersActions.hydrateFromBookState({
            bookId,
            chapters: res.state.chapters,
            completedSlugs: res.completedSlugs ?? [],
            characters: res.cast?.characters ?? [],
            chapterCharacters: res.chapterCharacters,
            /* Plan 77 — book-state response now carries per-chapter
               EBU R128 sidecar payloads. Older servers omit it; the
               slice tolerates an undefined map by leaving each row's
               `lufs` field undefined (no-data state in the report
               card). */
            chapterLufs: res.chapterLufs,
            /* #650 — render-time sentence→speaker map per chapter so the
               Generate view can flag chapters reassigned since they rendered.
               Older servers omit it; the slice leaves the map empty and the
               view falls back to the time-based heuristic. */
            renderedSpeakersByChapter: res.renderedSpeakersByChapter,
          }),
        );
        dispatch(
          revisionsActions.hydrateFromBookState(
            res.revisions ? { bookId, ...res.revisions } : null,
          ),
        );
        dispatch(changeLogActions.hydrateFromBookState(res.changeLog ?? null));
        /* Editable Listen-view metadata: seed from state.json's editorial
           fields; when narratorCredit is absent the slice defaults to 'Castwright'. */
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
              description: res.state.description ?? null,
              notes: res.state.notes ?? null,
            },
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

        /* Plan 47 — hydrate the per-book listen-progress bookmark so
           the Listen view's "Resume at MM:SS" pill renders on first
           paint. Null result clears any stale slice entry for this
           book (e.g. the file was deleted on disk). */
        api
          .getListenProgress(bookId)
          .then((progress) => {
            if (cancelled) return;
            dispatch(listenProgressActions.hydrate({ bookId, progress }));
          })
          .catch((err) => {
            console.warn('[listen-progress] hydrate skipped:', (err as Error).message);
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
  /* Plan 89 C3 — library.books is a large array (one entry per book) that
     repaint-churns on every 30 / 120 s drift-poll fan-out. Shallow equality
     keeps the dependent bookMeta hydrate effect from refiring when no array
     element changed identity. */
  const libraryBooks = useAppSelectorShallow((s) => s.library.books);
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

  /* Revisions + drift poll — active book on a 30 s tick (existing behavior).
     Plan 83 layered a 120 s background fan-out across non-active books past
     the cast-pending stage so foreign-book drift surfaces in the active
     book's Drift Report modal without a navigate. The two tickers run in
     separate useEffects so changing the active book doesn't restart the
     background timer. */
  useEffect(() => {
    if (stageKind !== 'ready' || !bookId) return;
    let cancelled = false;
    const fetchOnce = () =>
      api.pollRevisions({ bookId }).then((res) => {
        if (!cancelled) dispatch(revisionsActions.applyPoll({ ...res, bookId }));
      });
    fetchOnce();
    const t = setInterval(fetchOnce, 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [stageKind, bookId, dispatch]);

  /* Plan 83 — background fan-out across non-active books past cast-pending
     (i.e. books that have actual chapter audio to drift). Excludes the
     active book (covered by the 30 s ticker above). Cadence is 120 s to
     conserve free-tier server quotas; the slice's applyPoll action is
     already multi-book-aware (per-bookId event merge). */
  const bgBookIds = useMemo(() => {
    return library.books
      .filter(
        (b) =>
          b.status !== 'not_analysed' &&
          b.status !== 'analysing' &&
          b.status !== 'cast_pending' &&
          b.status !== 'unreadable' &&
          b.status !== 'orphaned' &&
          b.bookId !== bookId,
      )
      .map((b) => b.bookId);
  }, [library.books, bookId]);
  const bgKey = bgBookIds.join('|');
  useEffect(() => {
    if (bgBookIds.length === 0) return;
    let cancelled = false;
    const fetchOnce = () =>
      api.pollRevisionsBulk({ bookIds: bgBookIds }).then((res) => {
        if (cancelled) return;
        for (const [id, r] of Object.entries(res.byBookId)) {
          dispatch(revisionsActions.applyPoll({ ...r, bookId: id }));
        }
      });
    fetchOnce();
    const t = setInterval(fetchOnce, 120000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgKey, dispatch]);

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
  /* fe-2 — apply device-local accessibility settings (high-contrast +
     text-scale) to <html>, same single-mount shape as useTheme. */
  useAccessibilitySettings();
  const priorRoster = bookId ? (priorRosterByBook.get(bookId) ?? []) : [];
  const ctx: LayoutContext = {
    showInfo,
    showError,
    pushToast,
    ttsLifecycle,
    priorRoster,
    openFixCharacterAudio,
  };

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
  /* Pills only render for engines actually in use by the current book —
     Coqui / Kokoro pills when the book synthesises with them, the Qwen
     pill when any cast member is pinned to the bespoke Qwen engine
     (plan 108). Derived from the book's effective default model key PLUS
     per-character `ttsEngine` overrides (see selectEnginesInUse).
     Gemini has no Stop pill (cloud, no VRAM to free). */
  const enginesInUse = useAppSelector(selectEnginesInUse);
  /* The user-wide default/primary engine. Its Load/Stop pill stays reachable
     on every view (incl. book-less ones like Books home) so the model can be
     pre-loaded right after launch — whereas the per-character additions in
     `enginesInUse` (e.g. a Qwen-pinned cast member) only surface once a book
     is open. Gemini has no pill (cloud, no VRAM to free), so a Gemini default
     contributes nothing here and the popover keeps its fallback text. */
  const defaultEngine = useAppSelector(selectDefaultTtsEngine);
  const enginesToShow = (() => {
    const set = new Set<EngineFamily>();
    if (defaultEngine && defaultEngine !== 'gemini') set.add(defaultEngine);
    if (showGlobalTtsPill) for (const e of enginesInUse) set.add(e);
    /* ALSO surface any model that is actually RESIDENT in the sidecar, even if
       the current book's cast doesn't use it. A model can load without being in
       `enginesInUse` — most notably Kokoro pre-warmed as the Qwen→Kokoro
       fallback target. Without this, that model holds VRAM invisibly (no pill,
       no Stop control) — the 2026-05-30 "why is Kokoro loaded and I can't kill
       it" report. `ready`/`streaming`/`loading` all mean it's holding (or about
       to hold) VRAM, so it gets a kill pill. */
    for (const e of ['kokoro', 'coqui', 'qwen'] as const) {
      const st = ttsLifecycle[e].state;
      if (st === 'ready' || st === 'streaming' || st === 'loading') set.add(e);
    }
    return set;
  })();
  const showTtsControls = enginesToShow.size > 0;
  /* GPU semaphore badge — prefixes the TTS pill cluster with
     "GPU busy · N waiting ·" when this session is waiting behind another
     session's analyzer / sidecar call. Worded to NOT collide with the
     generation queue (the "Queue · N" chip / queue modal) — this is GPU
     resource contention, a different thing. Hidden when depth is 0 or
     undefined (older server that doesn't expose /api/gpu/queue). The
     server-side semaphore in server/src/gpu/semaphore.ts serialises
     GPU-heavy ops at GPU_CONCURRENCY=1 so two parallel Claude Code
     sessions don't thrash an 8 GB GPU's VRAM. */
  const gpuQueueDepth = ttsLifecycle.gpuQueueDepth;
  const showGpuQueueBadge = typeof gpuQueueDepth === 'number' && gpuQueueDepth > 0;
  const ttsPillElement = showTtsControls ? (
    <span className="inline-flex items-center gap-2 flex-wrap">
      {showGpuQueueBadge && (
        <span
          className="text-xs text-ink/70 tabular-nums"
          aria-label={`GPU busy: ${gpuQueueDepth} waiting`}
        >
          GPU busy · {gpuQueueDepth} waiting ·
        </span>
      )}
      {enginesToShow.has('kokoro') && (
        <ModelControlPill
          kind="tts"
          engineLabel="Kokoro"
          state={ttsLifecycle.kokoro.state}
          unreachableLabel="Voice engine not running"
          onLoad={() => {
            void ttsLifecycle.kokoro.onLoad();
          }}
          onStop={() => {
            void ttsLifecycle.kokoro.onStop();
          }}
        />
      )}
      {enginesToShow.has('coqui') && (
        <ModelControlPill
          kind="tts"
          engineLabel="Coqui XTTS"
          state={ttsLifecycle.coqui.state}
          unreachableLabel="Voice engine not running"
          onLoad={() => {
            void ttsLifecycle.coqui.onLoad();
          }}
          onStop={() => {
            void ttsLifecycle.coqui.onStop();
          }}
        />
      )}
      {enginesToShow.has('qwen') && (
        <ModelControlPill
          kind="tts"
          engineLabel="Qwen"
          state={ttsLifecycle.qwen.state}
          unreachableLabel="Voice engine not running"
          onLoad={() => {
            void ttsLifecycle.qwen.onLoad();
          }}
          onStop={() => {
            void ttsLifecycle.qwen.onStop();
          }}
        />
      )}
      {/* Whisper ASR content-QA (srv-31) — display-only, shown only when the
          server has ASR enabled (SEG_ASR_ENABLED). No Load/Stop: it loads
          lazily on /transcribe and idle-evicts. */}
      {ttsLifecycle.asr.enabled && (
        <AsrStatusBadge state={ttsLifecycle.asr.state} device={ttsLifecycle.asr.device} />
      )}
    </span>
  ) : null;

  /* Re-render once per second while a generation run is alive so the global
     pill's "stalled" computation has a clock to react against. The middleware
     keeps the SSE open across all navigation; this is purely a UI tick to
     surface elapsed-since-last-tick. */
  const [, forceClockTick] = useState(0);
  const pillAlive = activeStreams.length > 0;
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
    if (activeStreams.length === 0) return null;
    /* Aggregate across every open stream, deduped per book (Wave 3 may have
       several books generating at once). Each snapshot is book-wide, so two
       concurrent chapters of the SAME book would otherwise double-count
       (`5/7` + `5/7` → `10/14`); aggregateStreamsByBook collapses per book
       first, then sums across distinct books. With one stream this is
       byte-identical to the prior single-snapshot pill. */
    const { done, total, inProgress } = aggregateStreamsByBook(activeStreams);
    const halted = activeStreams.some((s) => s.halted);
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    /* Stalled only when EVERY in-flight stream is quiet — one moving stream
       means the run is alive. */
    const stalled =
      !halted &&
      inProgress > 0 &&
      activeStreams.every(
        (s) => s.lastTickAt != null && Date.now() - s.lastTickAt > STALL_THRESHOLD_MS,
      );
    const state: GenerationPillData['state'] = halted ? 'halted' : stalled ? 'stalled' : 'running';
    return {
      state,
      done,
      total,
      percent,
      /* One book → jump to its Generate view; several → open the queue modal
         (no single book to navigate to). */
      onClick:
        activeStreams.length === 1
          ? () => navigate(`/books/${activeStreams[0].bookId}/generate`)
          : () => dispatch(uiActions.openQueueModal()),
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
      phaseElapsedMs,
    } = analysisStream;
    /* Single source of truth for work-weighted analysis progress —
       shared with the analysing view's "Overall" bar via
       `src/lib/analysis-progress.ts`. EXCEPT a single-chapter subset, where
       `done/total` (and the server's coarse phaseProgress) is frozen — there we
       use the SAME per-chapter mapper the Generate-view row uses
       (`lib/reanalyse-progress.ts`) so the pill and the row show identical %. */
    const isSingleSubset = kind === 'subset' && (subsetChapterIds?.length ?? 0) === 1;
    const overall = isSingleSubset
      ? computeReanalyseProgress({
          phaseId: (phaseId === 1 ? 1 : 0) as 0 | 1,
          serverProgress: phaseProgress,
          phaseElapsedMs: phaseElapsedMs ?? 0,
        })
      : computeOverallProgress(phaseId, phaseProgress);
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

  /* Third status pill — the in-flight "Design full cast" bulk job. Mirrors the
     analysis/generation pill IIFEs: anchored to the cross-book `castDesign`
     snapshot, recomputed inline so the per-second forceClockTick refreshes the
     stalled check, surviving navigation; clicking routes to the book's Cast
     view. The terminal 'done' summary lingers briefly (the middleware clears
     it) so the user sees "Designed N · M failed". */
  const designPill: DesignPillData | null = (() => {
    if (!designSnapshot) return null;
    const { bookId: dBookId, total, done, skipped, failures, currentName, state } = designSnapshot;
    const completed = done + skipped + failures.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const stalled =
      state === 'running' &&
      designSnapshot.lastTickAt > 0 &&
      Date.now() - designSnapshot.lastTickAt > STALL_THRESHOLD_MS;
    const pillState: DesignPillData['state'] =
      state === 'halted' ? 'halted' : state === 'done' ? 'done' : stalled ? 'stalled' : 'running';
    return {
      state: pillState,
      done,
      total,
      percent,
      skipped,
      failureCount: failures.length,
      currentName,
      phase: designSnapshot.kind === 'single' ? designSnapshot.phase : undefined,
      onClick: () => {
        if (dBookId) navigate(`/books/${dBookId}/cast`);
      },
    };
  })();

  /* Plan 120 — collapse the live state into the single dominant summary the
     compact Status pill renders. Computed inline (not memoised) so the
     per-second forceClockTick above keeps the "stalled" rung fresh against
     Date.now(), same as the pill IIFEs. `anyModelLoading` only counts engines
     whose pill is actually shown. */
  const anyModelLoading = (['kokoro', 'coqui', 'qwen'] as const).some(
    (e) => enginesToShow.has(e) && ttsLifecycle[e].state === 'loading',
  );
  /* Show the Status pill whenever a TTS model control is shown (so the default
     engine's Load/Stop is always reachable, even on book-less views) OR there's
     cross-book activity / pending revisions to surface. On a fully idle global
     view with no pill to show (e.g. a Gemini default), the pill stays hidden so
     the workspace doesn't show a dead pill. */
  const showStatus =
    showTtsControls ||
    analysisPill !== null ||
    generationPill !== null ||
    designPill !== null ||
    pending.length > 0;
  const statusSummary = showStatus
    ? summarizeStatus({
        analysis: analysisPill,
        generation: generationPill,
        design: designPill,
        pendingRevisionsCount: pending.length,
        anyModelLoading,
      })
    : null;
  /* The detail rendered in the Status pill's hover/tap popover (the same data
     the plan-120 modal received). The "go to" handlers reuse the pills'
     existing onClick routing (single-book → Generate, multi-book → queue); the
     popover closes itself afterwards, so no modal-close dispatch is needed. */
  const statusDetail: StatusDetail = {
    ttsControls: ttsPillElement,
    analysis: analysisPill,
    generation: generationPill,
    design: designPill,
    pendingRevisionsCount: pending.length,
    onOpenRevisions: () => dispatch(uiActions.setShowRevisionPlayer(true)),
    onGoToAnalysing: () => analysisPill?.onClick(),
    onGoToGeneration: () => generationPill?.onClick(),
    onGoToDesign: () => designPill?.onClick(),
  };

  /* fs-21 — boot-splash. Gates the first paint until the readiness probe
     resolves. Placed AFTER every hook call in the component so this early
     return can never skip a hook (rules-of-hooks). */
  if (setupReady === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-ink/60 text-sm">Checking your setup…</p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${trackChapter ? 'pb-24' : 'pb-20'}`}>
      <TopBar
        stage={stageKind}
        view={view}
        setView={(v) => dispatch(uiActions.changeView(v))}
        projectTitle={projectTitle}
        onHome={() => dispatch(uiActions.goHome())}
        onTitleClick={stageKind === 'confirm' ? () => dispatch(uiActions.reanalyse()) : undefined}
        statusSummary={statusSummary}
        statusDetail={statusDetail}
        onOpenVoices={() => dispatch(uiActions.openVoices())}
        onOpenChangelog={() => dispatch(uiActions.openChangelog())}
        onOpenAccount={() => dispatch(uiActions.openAccount())}
        /* fs-18 — all-users Admin watch console. Always available; the
           dev-only worktree list lives inside the view. */
        onOpenAdmin={() => dispatch(uiActions.openAdmin())}
        userDisplayName={userDisplayName}
        queueCount={queueCount}
        onOpenQueue={() => dispatch(uiActions.openQueueModal())}
      />

      {/* fs-1 — post-upgrade "What's new" banner, top of every view. Self-gated
          on the server's showWhatsNew flag (no-op in mock mode). */}
      <WhatsNewBanner />

      {/* fe-27 — "update available" notifier; self-gated, dark in mock mode. */}
      <UpdateNotifierBanner />

      {/* Global TTS Load/Stop notices. Rendered here (not just in the Generate
          view) so a Load failure or analyzer-eviction triggered from the
          top-bar pill is visible on every stage that shows the pill —
          previously these only surfaced in generation.tsx, so a top-bar Load
          error silently reverted the pill to idle. Gated on the same flag as
          the pill itself, so notices from a book-less Load also surface. */}
      {showTtsControls && (
        <TtsNoticeBanner
          evictionNotice={ttsLifecycle.evictionNotice}
          loadErrorNotice={ttsLifecycle.loadErrorNotice}
          onDismiss={ttsLifecycle.dismissNotices}
        />
      )}

      {/* Plan 89 C5 — single shared Suspense boundary for the route-leaf
          views (each lazy-loaded in src/routes/index.tsx). The fallback's
          150 ms delay (DelayedSpinner default) means cached routes swap
          in with no visible spinner; only genuinely-cold chunk downloads
          paint the loading state. */}
      <Suspense fallback={<DelayedSpinner />}>
        <Outlet context={ctx} />
      </Suspense>

      {/* Plan 124 — build-version footer. Last in-flow child of the shell so it
          sits at the bottom of page content on every stage. The fixed MiniPlayer
          (ready stage) floats over the root's reserved pb-20/pb-24 gap, so it
          doesn't occlude this footer. */}
      <BuildStamp />

      <ToastStack />

      {stageKind === 'ready' && bookId && (
        <MiniPlayer
          chapter={trackChapter}
          bookId={bookId}
          autoSeekToIssues={view === 'generate'}
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
      {ui.regenChapter && (
        <RegenerateModal
          chapter={ui.regenChapter}
          defaultScope={ui.regenInitialScope ?? 'this'}
          forwardCount={forwardRegenChapters(chapters, ui.regenChapter!.id).length}
          forwardDurationSec={forwardRegenChapters(chapters, ui.regenChapter!.id).reduce(
            (acc, c) => acc + parseDuration(c.duration),
            0,
          )}
          onClose={() => dispatch(uiActions.setRegenChapter(null))}
          onConfirm={({ reason, scope, note }) => {
            const chapter = ui.regenChapter;
            /* Close the regen modal first so the reverse-guard modal
               (rendered below) doesn't stack on top of it. */
            dispatch(uiActions.setRegenChapter(null));
            reverseAnalyzerGuard(() => {
              if (chapter && bookId) {
                /* Plan 102 — expand 'forward' at enqueue time into one
                   queue entry per affected chapter so the user can
                   reorder each one individually in the modal. 'this'
                   stays a single entry. */
                const targetIds =
                  scope === 'forward'
                    ? forwardRegenChapters(chapters, chapter.id).map((c) => c.id)
                    : [chapter.id];
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildChapterRegenEvent({
                      chapter,
                      scope,
                      reason,
                      note,
                      affectedChapterCount: targetIds.length,
                    }),
                  ),
                );
                /* Server requires unique entry ids. Prefix with source +
                   chapter id + a short rand suffix so the same chapter
                   can be enqueued twice from different sessions without
                   colliding. */
                const rand = Math.random().toString(36).slice(2, 8);
                void dispatch(
                  enqueueQueueEntries(
                    targetIds.map((chapterId) => ({
                      id: `regen-modal-${bookId}-${chapterId}-${rand}`,
                      bookId,
                      chapterId,
                      scope: 'this',
                    })),
                  ),
                );
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
          onClose={() => dispatch(uiActions.setRegenCharacterCtx(null))}
          onConfirm={({ characterId, chapterIds, reason, note, preview }) => {
            dispatch(uiActions.setRegenCharacterCtx(null));
            if (chapterIds.length === 0) return;
            reverseAnalyzerGuard(() => {
              if (!bookId) return;
              const rand = Math.random().toString(36).slice(2, 8);
              if (preview) {
                /* Opt-in A/B preview: render ONLY the first affected chapter
                   and stash the rest in ui.previewRegen. On chapter_complete
                   the generation-stream middleware opens the diff player;
                   Approve fans the rest out (RevisionDiffPlayer onAccept),
                   Reject restores the preview chapter. The change-log entry +
                   the rest of the chapters wait until Approve. */
                const [previewChapterId, ...remainingChapterIds] = chapterIds;
                dispatch(
                  uiActions.setPreviewRegen({
                    characterId,
                    previewChapterId,
                    remainingChapterIds,
                    reason,
                    note,
                  }),
                );
                void dispatch(
                  enqueueQueueEntries([
                    {
                      id: `regen-preview-${bookId}-${characterId}-${previewChapterId}-${rand}`,
                      bookId,
                      chapterId: previewChapterId,
                      scope: 'this',
                    },
                  ]),
                );
              } else {
                /* Regenerate every affected chapter now — whole-chapter
                   renders applied immediately, no A/B gate. */
                if (regenCharacter) {
                  dispatch(
                    changeLogActions.appendLogEvent(
                      buildCharacterRegenEvent({ character: regenCharacter, chapterIds, reason, note }),
                    ),
                  );
                }
                void dispatch(
                  enqueueQueueEntries(
                    chapterIds.map((chId) => ({
                      id: `regen-char-${bookId}-${characterId}-${chId}-${rand}`,
                      bookId,
                      chapterId: chId,
                      scope: 'this' as const,
                    })),
                  ),
                );
              }
              dispatch(uiActions.changeView('generate'));
            });
          }}
        />
      )}
      {ui.showDriftReport && (
        <DriftReportModal
          /* Multi-book grouping: each entry in driftGroupsByBook is one
             book's pre-grouped (character × snapshot) drift cards. Cast
             slice only carries the active book's characters today —
             cross-book groups fall back to the embedded
             `group.current.name` for display. Memoised so referential
             equality survives unrelated re-renders. */
          groupsByBook={driftGroupsByBookView}
          voices={voices}
          filterCharacterId={ui.driftReportCharacterFilter}
          onClearFilter={() => dispatch(uiActions.clearDriftReportCharacterFilter())}
          onClose={() => dispatch(uiActions.setShowDriftReport(false))}
          /* Drift "Regenerate" → an immediate whole-chapter regen (plan 114:
             the per-character path was removed). The drifted chapter is
             re-rendered in full and applied directly — no A/B gate (the
             opt-in preview is anchored to the profile-change flow). */
          onRegenerateChapter={(_evBookId, charId, chapterId) => {
            dispatch(uiActions.setShowDriftReport(false));
            const character = characters.find((c) => c.id === charId);
            reverseAnalyzerGuard(() => {
              if (character) {
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildCharacterRegenEvent({
                      character,
                      chapterIds: [chapterId],
                      reason: 'voice',
                      note: 'Regenerated from the drift report.',
                    }),
                  ),
                );
              }
              if (bookId) {
                const rand = Math.random().toString(36).slice(2, 8);
                void dispatch(
                  enqueueQueueEntries([
                    {
                      id: `drift-regen-${bookId}-${charId}-${chapterId}-${rand}`,
                      bookId,
                      chapterId,
                      scope: 'this',
                    },
                  ]),
                );
              }
              dispatch(uiActions.changeView('generate'));
            });
          }}
          /* Plan 20 C1+C2: severe drift events skip the confirmation click.
             Same change-log entry + an immediate whole-chapter regen (plan
             114 — no per-character scope). The reverse local-analyzer guard
             still gates the action so a live local analysis prompts before
             TTS starts. */
          onAutoQueueRegenerate={(_evBookId, charId, chapterId) => {
            dispatch(uiActions.setShowDriftReport(false));
            const character = characters.find((c) => c.id === charId);
            reverseAnalyzerGuard(() => {
              if (character) {
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildCharacterRegenEvent({
                      character,
                      chapterIds: [chapterId],
                      reason: 'voice',
                      note: 'Auto-queued from severe drift event.',
                    }),
                  ),
                );
              }
              if (bookId) {
                const rand = Math.random().toString(36).slice(2, 8);
                void dispatch(
                  enqueueQueueEntries([
                    {
                      id: `drift-auto-${bookId}-${charId}-${chapterId}-${rand}`,
                      bookId,
                      chapterId,
                      scope: 'this',
                    },
                  ]),
                );
              }
              dispatch(uiActions.changeView('generate'));
            });
          }}
          onDismiss={(eventId) => dispatch(revisionsActions.dismissDrift(eventId))}
        />
      )}
      {profileCharacter &&
        (() => {
          /* Build the manual-link picker's prior-roster list. Drop any
           candidate the cast has already pinned to a canonical identity —
           either an exact matchedFrom hit OR a shared canonical voiceId, so
           ALL of a recurring character's prior-book copies collapse out of
           the picker once any one of them is linked (otherwise the same
           person lingers under every other volume's name). See
           filterLinkablePriorCandidates for the full rule. */
          const priorRoster = bookId ? (priorRosterByBook.get(bookId) ?? []) : [];
          const mergeCandidatesPrior = filterLinkablePriorCandidates(characters, priorRoster).map(
            (p) => ({ id: p.id, name: p.name, bookId: p.bookId, bookTitle: p.bookTitle }),
          );
          return (
            <ProfileDrawer
              character={profileCharacter}
              voice={profileVoice ?? undefined}
              bookId={bookId ?? undefined}
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
                          profile: res.profile,
                        }),
                      );
                      /* Close so the user lands back on the confirm card and can see
               the "Continuity preserved" footer + "Sync profile" checkbox
               that the new matchedFrom triggers. Mirrors onMerge's close. */
                      dispatch(uiActions.setOpenProfileId(null));
                    }
                  : undefined
              }
              onUnlinkAlias={
                bookId
                  ? async (sourceCharacterId, aliasName) => {
                      const res = await api.unlinkAlias({
                        bookId,
                        sourceCharacterId,
                        aliasName,
                      });
                      dispatch(
                        castActions.applyUnlinkAlias({
                          sourceCharacterId,
                          aliasName,
                          newCharacter: res.newCharacter,
                        }),
                      );
                      /* Open the Reattribute Lines modal so the user can move
                         the freed-up alias's lines off the source character. The
                         drawer stays open behind it — closing the modal returns
                         the user to the drawer where they can confirm the chip
                         is gone. */
                      setReattributeModal({
                        sourceCharacterId,
                        sourceCharacterName: profileCharacter.name,
                        newCharacterId: res.newCharacter.id,
                        aliasName,
                        impactedChapters: res.impactedChapters,
                      });
                    }
                  : undefined
              }
              onAddAlias={
                bookId
                  ? async (characterId, aliasName) => {
                      await api.addAlias({ bookId, characterId, aliasName });
                      dispatch(castActions.applyAddAlias({ characterId, aliasName }));
                    }
                  : undefined
              }
              /* Dispatch-only — unlike onAddAlias (whose dedicated server
                 endpoint predates the persist-rule approach), the
                 cast/renameCharacter persistence rule round-trips the new
                 name + demoted alias to cast.json on its own. The matching
                 name_change activity event is appended here (the change-log
                 persist rule fans it to change-log.json). */
              onRename={
                bookId
                  ? (characterId, name) => {
                      const oldName = profileCharacter?.name ?? '';
                      dispatch(castActions.renameCharacter({ characterId, name }));
                      /* Mirror the reducer's no-op guard so a name unchanged
                         apart from case/whitespace doesn't spam the log. */
                      if (oldName && oldName.trim().toLowerCase() !== name.trim().toLowerCase()) {
                        dispatch(
                          changeLogActions.appendLogEvent(
                            buildNameChangeEvent({ oldName, newName: name.trim() }),
                          ),
                        );
                      }
                    }
                  : undefined
              }
              duplicateOther={
                profileDuplicateOriented
                  ? {
                      name: profileDuplicateOriented.far.voice.character,
                      bookTitle: profileDuplicateOriented.far.voice.bookTitle,
                    }
                  : null
              }
              onReviewDuplicate={
                profileDuplicateOriented ? () => setDuplicateReviewOpen(true) : undefined
              }
              renderedFallbackEngine={renderedFallbackByCharacter?.[profileCharacter.id]}
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
                    JSON.stringify(prior.tone ?? {}) !== JSON.stringify(updated.tone ?? {}) ||
                    /* Plan 108 — a per-character engine swap, a persona
                       (voiceStyle) edit, or any per-engine override change
                       also invalidates rendered audio. The server drift
                       detector catches engine/resolved-voice changes; this
                       fires the immediate in-session nudge. */
                    (prior.ttsEngine ?? undefined) !== (updated.ttsEngine ?? undefined) ||
                    (prior.voiceStyle ?? '') !== (updated.voiceStyle ?? '') ||
                    JSON.stringify(prior.overrideTtsVoices ?? {}) !==
                      JSON.stringify(updated.overrideTtsVoices ?? {});
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
              onFixAudio={(charId) => setFixAudioFor(charId)}
            />
          );
        })()}

      {/* fe-8 — duplicate-review modal opened from the profile-drawer chip.
          Pre-populated with the open character (near) + its cross-book
          partner (far, hydrated on open). On a successful link/variant the
          modal already dispatches the near-side reducer; we clear the open
          flag so a re-open recomputes against the now-suppressed candidate. */}
      <DuplicateReviewModal
        open={duplicateReviewOpen && duplicateReviewPair !== null}
        pair={duplicateReviewPair}
        loading={duplicateReviewLoading}
        onClose={() => setDuplicateReviewOpen(false)}
        onResolved={() => {
          setDuplicateReviewOpen(false);
          setForeignCast(null);
        }}
      />

      {reattributeModal && (
        <ReattributeLinesModal
          sourceCharacterId={reattributeModal.sourceCharacterId}
          sourceCharacterName={reattributeModal.sourceCharacterName}
          newCharacterId={reattributeModal.newCharacterId}
          aliasName={reattributeModal.aliasName}
          impactedChapters={reattributeModal.impactedChapters}
          onClose={() => setReattributeModal(null)}
        />
      )}

      {/* fs-26 — per-character "Fix audio" (loudness boost / re-record splice). */}
      {fixAudioFor && bookId && (
        <FixCharacterAudioModal
          characterId={fixAudioFor}
          characterName={characters.find((c) => c.id === fixAudioFor)?.name ?? 'Character'}
          bookId={bookId}
          preScoped={fixAudioPreScoped ?? undefined}
          onClose={() => {
            setFixAudioFor(null);
            setFixAudioPreScoped(null);
          }}
        />
      )}
      <QueueModalContainer />

      {ui.showRevisionPlayer && pending[0] && bookId && (
        <RevisionDiffPlayer
          revision={pending[0]}
          bookId={bookId}
          mode={ui.previewRegen ? 'preview' : 'review'}
          chapter={chapters.find((c) => c.id === pending[0].chapterId)}
          character={characters.find((c) => c.id === pending[0].characterId)}
          onOpenHistory={() =>
            dispatch(uiActions.setRevisionHistoryFor({ chapterId: pending[0].chapterId }))
          }
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
            const preview = ui.previewRegen;
            dispatch(revisionsActions.acceptRevision({ revisionId: id, selection }));
            dispatch(uiActions.setShowRevisionPlayer(false));
            api.acceptChapterRevision({ bookId, chapterId }).catch((err) => {
              dispatch(
                notificationsActions.pushToast({
                  kind: 'warn',
                  message: `Couldn't accept the revision — ${(err as Error).message ?? 'network error'}.`,
                  dedupeKey: 'revision-accept-failed',
                }),
              );
            });
            /* Profile-regen preview Approved → fan the remaining affected
               chapters out as straight whole-chapter regens (no further A/B).
               The change-log entry covers the full set the user committed to. */
            if (preview && preview.previewChapterId === chapterId) {
              dispatch(uiActions.setPreviewRegen(null));
              const character = characters.find((c) => c.id === preview.characterId);
              if (character) {
                dispatch(
                  changeLogActions.appendLogEvent(
                    buildCharacterRegenEvent({
                      character,
                      chapterIds: [chapterId, ...preview.remainingChapterIds],
                      reason: preview.reason,
                      note: preview.note,
                    }),
                  ),
                );
              }
              if (preview.remainingChapterIds.length > 0) {
                const rand = Math.random().toString(36).slice(2, 8);
                void dispatch(
                  enqueueQueueEntries(
                    preview.remainingChapterIds.map((chId) => ({
                      id: `regen-rest-${bookId}-${preview.characterId}-${chId}-${rand}`,
                      bookId,
                      chapterId: chId,
                      scope: 'this' as const,
                    })),
                  ),
                );
                dispatch(uiActions.changeView('generate'));
              }
            }
          }}
          onReject={() => {
            /* Reject = the prior (A) render wins. Drop the pending
               revision and ask the server to promote `.previous.*` over
               the live render. 409 surfaces as an error toast so the
               user knows to wait if a generation is mid-flight. A preview
               Reject also drops the stashed remaining chapters — the user
               re-adjusts the profile and starts over. */
            const id = pending[0].id;
            const chapterId = pending[0].chapterId;
            dispatch(revisionsActions.rejectRevision(id));
            dispatch(uiActions.setShowRevisionPlayer(false));
            if (ui.previewRegen) dispatch(uiActions.setPreviewRegen(null));
            api.rejectChapterRevision({ bookId, chapterId }).catch((err) => {
              /* Plan 20 — mid-flight Reject lands here when the server
                 returns 409 (generation in progress, can't promote the
                 previous take over a live render). Surface via the toast
                 surface so the user knows to wait + retry instead of
                 staring at a silent UI. dedupeKey collapses rapid retries. */
              dispatch(
                notificationsActions.pushToast({
                  kind: 'warn',
                  message: `Couldn't reject the revision — ${(err as Error).message ?? 'try again once generation pauses'}.`,
                  dedupeKey: 'revision-reject-failed',
                }),
              );
            });
          }}
        />
      )}
      {ui.revisionHistoryFor && (
        <RevisionTimelineModal
          chapterId={ui.revisionHistoryFor.chapterId}
          chapterTitle={
            ui.revisionHistoryFor.chapterId != null
              ? chapters.find((c) => c.id === ui.revisionHistoryFor!.chapterId)?.title
              : undefined
          }
          characters={characters}
          onClose={() => dispatch(uiActions.setRevisionHistoryFor(null))}
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
      <TourOverlay />
    </div>
  );
}
