/* react-router v6 route tree. Each route element derives its Stage from
   URL params and dispatches uiActions.hydrateFromUrl when the URL says
   something different from the current redux state. The Layout component
   owns the reverse direction (Redux→URL sync). */

import { useEffect, useMemo, useState, lazy, type ReactNode } from 'react';
import {
  createHashRouter,
  Navigate,
  useOutletContext,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useAppDispatch, useAppSelector, useAppSelectorShallow, store } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { chaptersActions } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { libraryActions } from '../store/library-slice';
import { changeLogActions } from '../store/change-log-slice';
import { hydrateBookExports } from '../store/exports-middleware';
import { bookMetaActions, selectEffectiveMeta, selectIsDirty } from '../store/book-meta-slice';
import { buildCastConfirmEvent } from '../lib/change-log';
import { api } from '../lib/api';
import { stageEqual } from '../lib/router';
import { resolveSegmentForSec } from '../lib/resolve-segment-for-sec';
import { MODEL_OPTION_GROUPS } from '../lib/models';
import { Layout, type LayoutContext } from '../components/layout';
import { useLocalAnalyzerGuard } from '../hooks/use-local-analyzer-guard';
/* Plan 89 C5 — route-leaf views are lazy-loaded so the initial library route
   bundle no longer pulls in the manuscript editor / generation / listen /
   cast / etc. code. Each view becomes its own chunk; a shared Suspense
   boundary in Layout shows a DelayedSpinner if the chunk takes >150 ms
   (so warm cache navigations don't flash a spinner).
   The non-route-leaf views (BookLibraryView, ConfirmMetadataView,
   ConfirmCastView) are still eagerly imported — they fall under conditional
   sub-routes (ReadyRoute's switch, UploadRoute's conditional) where the
   eager cost is negligible OR they are the landing route and lazy-loading
   them would only slow first paint. */
import { importGenerationView, importUploadView } from './prefetch';
const UploadView = lazy(() => importUploadView().then((m) => ({ default: m.UploadView })));
const AnalysingView = lazy(() =>
  import('../views/analysing').then((m) => ({ default: m.AnalysingView })),
);
import { ConfirmCastView } from '../views/confirm-cast';
const ManuscriptView = lazy(() =>
  import('../views/manuscript').then((m) => ({ default: m.ManuscriptView })),
);
const CastView = lazy(() => import('../views/cast').then((m) => ({ default: m.CastView })));
const LibraryView = lazy(() => import('../views/voices').then((m) => ({ default: m.LibraryView })));
const GenerationView = lazy(() =>
  importGenerationView().then((m) => ({ default: m.GenerationView })),
);
const ListenView = lazy(() => import('../views/listen').then((m) => ({ default: m.ListenView })));
import { BookLibraryView } from '../views/book-library';
import { ConfirmMetadataView } from '../views/confirm-metadata';
const ChangeLogView = lazy(() =>
  import('../views/change-log').then((m) => ({ default: m.ChangeLogView })),
);
const AccountView = lazy(() =>
  import('../views/account').then((m) => ({ default: m.AccountView })),
);
const RestructureView = lazy(() =>
  import('../views/restructure').then((m) => ({ default: m.RestructureView })),
);
const AdminView = lazy(() =>
  import('../views/admin').then((m) => ({ default: m.AdminView })),
);
const ModelManagerView = lazy(() =>
  import('../views/model-manager').then((m) => ({ default: m.ModelManagerView })),
);
const AboutView = lazy(() =>
  import('../views/about').then((m) => ({ default: m.AboutView })),
);
const AdvancedView = lazy(() =>
  import('../views/advanced').then((m) => ({ default: m.AdvancedView })),
);
const ReleaseNotesView = lazy(() =>
  import('../views/release-notes').then((m) => ({ default: m.ReleaseNotesView })),
);
import { ChapterExclusionList } from '../components/chapter-exclusion-list';
import { isLikelyFrontMatter, chapterSlug } from '../lib/chapter-heuristics';
import type { Character, Stage, View } from '../lib/types';

const VALID_VIEWS: View[] = [
  'manuscript',
  'cast',
  'library',
  'generate',
  'listen',
  'log',
  'restructure',
];

/* Per-route URL → Redux sync. Reads the live redux stage via
   store.getState() (not useAppSelector) so we don't add the stage as an
   effect dependency — that would re-fire the effect whenever ui.stage
   changes, including after our own dispatch. */
function useHydrateStage(derived: Stage, deps: ReadonlyArray<unknown>) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (!stageEqual(store.getState().ui.stage, derived)) {
      dispatch(uiActions.hydrateFromUrl(derived));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function BooksRoute() {
  useHydrateStage({ kind: 'books' }, []);
  const dispatch = useAppDispatch();
  const library = useAppSelector((s) => s.library);
  const bookId = useAppSelector((s) => (s.ui.stage as { bookId?: string }).bookId ?? null);
  const { showInfo, showError, pushToast } = useOutletContext<LayoutContext>();

  return (
    <BookLibraryView
      authors={library.authors}
      activeBookId={bookId}
      onOpenBook={(b) =>
        dispatch(
          uiActions.openBook({ id: b.bookId, status: b.status, manuscriptId: b.manuscriptId }),
        )
      }
      onDeleteBook={async (b) => {
        try {
          await api.deleteBook(b.bookId);
        } catch (err) {
          showError(`Couldn't delete "${b.title}"`, (err as Error).message, 'Delete');
          return;
        }
        const res = await api.getLibrary().catch(() => null);
        if (res) dispatch(libraryActions.hydrate(res));
        if (bookId === b.bookId) dispatch(uiActions.goHome());
      }}
      onEditBook={async (b, patch) => {
        try {
          await api.putBookState(b.bookId, { slice: 'state', patch });
        } catch (err) {
          showError(`Couldn't update "${b.title}"`, (err as Error).message, 'Edit');
          return;
        }
        const res = await api.getLibrary().catch(() => null);
        if (res) dispatch(libraryActions.hydrate(res));
      }}
      onCoverChanged={async () => {
        /* The CoverPicker modal already POSTed / DELETEd; just refresh
           the library so the new coverImageUrl propagates through the
           slice and other surfaces (Listen header) repaint on next mount. */
        const res = await api.getLibrary().catch(() => null);
        if (res) dispatch(libraryActions.hydrate(res));
      }}
      onReplaceManuscript={async (b, file) => {
        let result;
        try {
          result = await api.replaceManuscript(b.bookId, file);
        } catch (err) {
          showError(`Couldn't replace "${b.title}"`, (err as Error).message, 'Replace');
          return;
        }
        /* Server wiped cast.json + revisions + audio + cache — mirror the
           reparse handler's redux reset so a stale open-book view can't show
           pre-replace state. */
        dispatch(castActions.setCharacters([]));
        dispatch(manuscriptActions.reset());
        if (bookId === b.bookId) dispatch(uiActions.goHome());
        const refreshed = await api.getLibrary().catch(() => null);
        if (refreshed) dispatch(libraryActions.hydrate(refreshed));
        showInfo({
          eyebrow: 'Replace',
          title: 'Manuscript replaced',
          body: (
            <p>
              Re-detected {result.chapterCount} chapter
              {result.chapterCount === 1 ? '' : 's'}. Designed voices were preserved where
              characters still match — confirm the cast again before generating.
            </p>
          ),
          primaryLabel: 'Open book',
          onPrimary: () => {
            const target =
              refreshed?.authors
                .flatMap((a) => a.series.flatMap((s) => s.books))
                .find((book) => book.bookId === b.bookId) ?? b;
            dispatch(
              uiActions.openBook({
                id: target.bookId,
                status: 'analysing',
                manuscriptId: target.manuscriptId,
              }),
            );
          },
        });
      }}
      onReparseBook={async (b) => {
        let result;
        try {
          result = await api.reparseBook(b.bookId);
        } catch (err) {
          showError(`Couldn't re-parse "${b.title}"`, (err as Error).message, 'Re-parse');
          return;
        }
        /* Server wiped cast.json + revisions.json + audio dir + analysis cache.
           Mirror that in redux so a follow-up "Analyse now" doesn't merge new
           Phase 0a cast detections on top of the previous run's roster. Also
           reset the manuscript slice — its manuscriptId+title still pin the
           layout's per-book hydration guard, which would otherwise short-
           circuit and leave the cleared slices unrefreshed when the user
           navigates back into the analysing stage.

           Unconditional reset: this code runs from the books library, where
           ui.stage.bookId is always undefined; gating on `bookId === b.bookId`
           would never fire. Any per-book state still in redux is by definition
           the *previous* open's residue, so wiping it is correct regardless
           of which book is being re-parsed — the next book open re-hydrates
           from disk. */
        dispatch(castActions.setCharacters([]));
        dispatch(manuscriptActions.reset());
        if (bookId === b.bookId) dispatch(uiActions.goHome());

        /* Kick off the library rescan in the background — it only feeds
           `updatedBook` for the onPrimary handler, which only fires
           after the user reads the dialog and clicks "Analyse now".
           Awaiting it before showing the dialog used to tack 300ms-1s
           onto the perceived re-parse latency, depending on workspace
           size. The dialog has everything it needs from `result`
           already. */
        const refreshedLibrary = api
          .getLibrary()
          .then((res) => {
            dispatch(libraryActions.hydrate(res));
            return res;
          })
          .catch(() => null);

        /* Chapter records for the dialog. The server emits the rich form
           on current builds; fall back to titles-only for older servers
           so the dialog still renders something useful. */
        const dialogChapters =
          result.chapters ??
          result.chapterTitles.map((title, i) => ({
            id: i + 1,
            title,
            slug: '',
            wordCount: 0,
            excluded: false,
          }));

        /* The server preserved excluded flags across the re-parse by
           best-effort (id then slug match). That's our starting point
           for the dialog. The user can toggle and we apply any deltas
           via the per-chapter exclude endpoint before navigating.
           Shared mutable box: the body's onChange writes here, the
           onPrimary closure reads it. */
        const initialExcludedSlugs = new Set<string>(
          dialogChapters.filter((c) => c.excluded).map((c) => c.slug || chapterSlug(c.id, c.title)),
        );
        const pendingBox: { current: Set<string> } = { current: new Set(initialExcludedSlugs) };

        const body = (
          <ReparseResultBody
            bookTitle={b.title}
            chapters={dialogChapters}
            initialExcludedSlugs={initialExcludedSlugs}
            onChangeExcludedSlugs={(s) => {
              pendingBox.current = s;
            }}
          />
        );

        showInfo({
          eyebrow: 'Re-parse',
          title: 'Manuscript re-parsed',
          body,
          primaryLabel: 'Analyse now',
          onPrimary: async () => {
            /* Apply any deltas the user made vs the server's preserved
               set, then navigate. Fired in parallel so a handful of
               toggles complete in well under a second. Errors are
               logged but don't block navigation — the worst case is a
               chapter that should have been excluded gets analyzed and
               the user can re-toggle from the Generate view. */
            void applyExcludedDeltas(
              b.bookId,
              dialogChapters,
              initialExcludedSlugs,
              pendingBox.current,
            );
            /* Await the background library rescan only at navigation time.
               In practice the user spends >300ms reading the dialog, so
               this is almost always already resolved by the time they
               click. Falls back to the original card if the rescan is
               still racing or failed. */
            const res = await refreshedLibrary;
            const updatedBook = res?.authors
              .flatMap((a) => a.series.flatMap((s) => s.books))
              .find((book) => book.bookId === b.bookId);
            const target = updatedBook ?? b;
            dispatch(
              uiActions.openBook({
                id: target.bookId,
                status: 'analysing',
                manuscriptId: target.manuscriptId,
              }),
            );
          },
        });
      }}
      onStartNew={() => dispatch(uiActions.startNewBook())}
      onImportPortable={async (file) => {
        /* Plan 75 — POST the bundle, refresh the library, surface a
           toast so the user sees confirmation when the import lands
           somewhere they weren't watching (e.g. the bottom of the
           grid). Errors surface via showError so they're dismissable. */
        let result;
        try {
          result = await api.importPortable(file);
        } catch (err) {
          showError(`Couldn't import "${file.name}"`, (err as Error).message, 'Import');
          return;
        }
        const refreshed = await api.getLibrary().catch(() => null);
        if (refreshed) dispatch(libraryActions.hydrate(refreshed));
        const importedBook = refreshed?.authors
          .flatMap((a) => a.series.flatMap((s) => s.books))
          .find((b) => b.bookId === result.bookId);
        pushToast({
          kind: 'info',
          message: importedBook ? `Imported: ${importedBook.title}` : 'Bundle imported',
          dedupeKey: 'portable-import-success',
        });
      }}
    />
  );
}

function UploadRoute() {
  useHydrateStage({ kind: 'upload' }, []);
  const importCandidate = useAppSelector((s) => s.manuscript.importCandidate);
  return importCandidate ? <ConfirmMetadataView /> : <UploadView />;
}

function VoicesRoute() {
  useHydrateStage({ kind: 'voices' }, []);
  const voices = useAppSelector((s) => s.voices.voices);
  const navigate = useNavigate();
  /* Clicking a voice card from the global Voices view navigates to the
     character's source-book cast view with `?profile=<charId>` set. The
     ReadyRoute parses the param into stage.openProfileId, Layout hydrates
     that book's cast from disk, and the ProfileDrawer pops out alongside
     the cast table — same affordance as the cast view's in-book panel. */
  return (
    <LibraryView
      library={voices}
      onOpenCharacter={(voice) => {
        if (!voice.bookId) return;
        navigate(`/books/${voice.bookId}/cast?profile=${encodeURIComponent(voice.id)}`);
      }}
    />
  );
}

function AccountRoute() {
  useHydrateStage({ kind: 'account' }, []);
  return <AccountView />;
}

/* fs-18 — all-users Admin watch console (was the dev-only Worktrees route,
   plan 86). The view is shown to everyone; the git-worktree list inside it
   stays gated behind import.meta.env.DEV. */
function AdminRoute() {
  useHydrateStage({ kind: 'admin' }, []);
  return <AdminView />;
}

/* fs-23 — In-app Model Manager, reached from the Admin view. */
function ModelManagerRoute() {
  useHydrateStage({ kind: 'model-manager' }, []);
  return <ModelManagerView />;
}

/* Wave 3 — /about brand page, reached from the Admin view. */
function AboutRoute() {
  useHydrateStage({ kind: 'about' }, []);
  return <AboutView />;
}

/* Advanced configuration — reached from Admin and Account views. */
function AdvancedRoute() {
  useHydrateStage({ kind: 'advanced' }, []);
  return <AdvancedView />;
}

/* fe-37 — in-app release-notes history, reached from /about + Account. */
function ReleaseNotesRoute() {
  useHydrateStage({ kind: 'release-notes' }, []);
  return <ReleaseNotesView />;
}

export function ChangelogRoute() {
  useHydrateStage({ kind: 'changelog' }, []);
  const dispatch = useAppDispatch();
  const events = useAppSelector((s) => s.changeLog.workspaceEvents);
  const nextCursor = useAppSelector((s) => s.changeLog.workspaceNextCursor);
  const totalCount = useAppSelector((s) => s.changeLog.workspaceTotalCount);
  const categoryCounts = useAppSelector((s) => s.changeLog.workspaceCategoryCounts);
  const [loadingMore, setLoadingMore] = useState(false);

  /* The workspace endpoint fans out across every book's
     .audiobook/change-log.json and tags each event with bookId/bookTitle.
     First page is fetched on mount; further pages land via the
     IntersectionObserver in ChangeLogView when the user scrolls within
     reach of the tail. */
  useEffect(() => {
    let cancelled = false;
    api
      .getWorkspaceChangelog()
      .then((res) => {
        if (!cancelled) dispatch(changeLogActions.hydrateWorkspaceFirstPage(res));
      })
      .catch((err) => {
        console.error('[changelog] workspace fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  /* Fetch the next page when the view's sentinel intersects the viewport.
     The loadingMore guard keeps a sub-200px scroll from firing two
     overlapping requests for the same cursor. */
  const loadMore = useMemo(
    () => () => {
      if (!nextCursor || loadingMore) return;
      setLoadingMore(true);
      api
        .getWorkspaceChangelog({ before: nextCursor })
        .then((res) => dispatch(changeLogActions.appendWorkspacePage(res)))
        .catch((err) => console.error('[changelog] workspace page fetch failed', err))
        .finally(() => setLoadingMore(false));
    },
    [dispatch, nextCursor, loadingMore],
  );

  return (
    <ChangeLogView
      events={events}
      totalCount={totalCount}
      categoryCounts={categoryCounts}
      onLoadMore={loadMore}
      hasMore={nextCursor != null}
      loadingMore={loadingMore}
    />
  );
}

export function AnalysingRoute() {
  const { bookId = '' } = useParams<{ bookId: string }>();
  useHydrateStage({ kind: 'analysing', bookId, manuscriptId: null }, [bookId]);

  const dispatch = useAppDispatch();
  const stage = useAppSelector((s) => s.ui.stage);
  const manuscript = useAppSelector((s) => s.manuscript);
  const library = useAppSelector((s) => s.library);
  const ui = useAppSelector((s) => s.ui);
  const activeBook = library.books.find((b) => b.bookId === bookId);
  /* Stage.manuscriptId is set when the user goes through Upload → Analyse, but
     it's null on page refresh, deep links, or confirm→reanalyse — none of
     those carry the id through ui.stage. Layout's book-state hydration always
     repopulates manuscript.manuscriptId from disk, so prefer that (and fall
     back to the library entry for the brief window before disk hydrate lands). */
  const manuscriptId =
    stage.kind === 'analysing'
      ? (stage.manuscriptId ?? manuscript.manuscriptId ?? activeBook?.manuscriptId ?? null)
      : null;

  return (
    <AnalysingView
      manuscriptId={manuscriptId}
      bookId={bookId || null}
      title={manuscript.title || activeBook?.title || null}
      wordCount={manuscript.wordCount}
      model={ui.selectedModel}
      onComplete={(payload) => {
        dispatch(castActions.hydrateFromAnalysis(payload));
        /* hydrateFromAnalysis atomically pins the chapters slice to
           payload.bookId via its currentBookId reducer field, so the
           cross-book tick guard in applyGenerationTick has a truthful
           frame the instant chapter rows land. */
        dispatch(chaptersActions.hydrateFromAnalysis(payload));
        dispatch(manuscriptActions.hydrateFromAnalysis(payload));
        dispatch(uiActions.analysisComplete({ bookId: payload.bookId }));
        /* NOTE: designed voices the carryover restored into cast.json but the
           analysis payload omits are re-read on the confirm screen itself
           (ConfirmRoute's getBookState effect) — the layout's hydration is
           skipped on this transition once the SSE stream filled the slice. */
      }}
    />
  );
}

export function ConfirmRoute() {
  const { bookId = '' } = useParams<{ bookId: string }>();
  const [searchParams] = useSearchParams();
  const openProfileId = searchParams.get('profile');
  useHydrateStage({ kind: 'confirm', bookId, openProfileId }, [bookId, openProfileId]);

  const dispatch = useAppDispatch();
  const characters = useAppSelector((s) => s.cast.characters);
  const voices = useAppSelector((s) => s.voices.voices);
  const manuscript = useAppSelector((s) => s.manuscript);
  /* Re-analyse fires a fresh local-analyzer pass; guard it the same way
     book imports do so it can't evict TTS mid-chapter. Gemini/Gemma
     engines pass through unguarded. */
  const { guard, modal: guardModal } = useLocalAnalyzerGuard();

  /* Authoritative cast re-read on confirm entry. The analysis-complete payload
     carries the freshly-detected roster but OMITS designed voices the
     reparse/replace carryover (srv-13) restored into cast.json, and the
     layout's hydration is skipped here once the analysing SSE stream populated
     the slice — so the confirm screen would render "No voice designed yet" for
     a character whose designed voice is safe on disk. Re-reading the merged
     cast.json on entry (the same path that already works on a manual reload)
     surfaces those voices. Runs once per book; the confirm screen's own edits
     (match decisions, fresh designs) all post-date this and persist to disk, so
     a later re-entry re-reads them rather than clobbering. */
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    api
      .getBookState(bookId)
      .then((res) => {
        if (!cancelled && res?.cast?.characters && res.cast.characters.length > 0) {
          dispatch(castActions.setCharacters(res.cast.characters));
        }
      })
      .catch(() => {
        /* non-fatal — fall back to whatever the slice already holds */
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, dispatch]);

  return (
    <>
      <ConfirmCastView
        characters={characters}
        library={voices}
        title={manuscript.title}
        onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
        onOverrideLibrary={async ({ sourceCharacterId, targetBookId, targetCharacterId }) => {
          /* Binds sourceBookId from the route's bookId — the view doesn't
           need to know about the source side beyond per-character ids.
           Server returns the merged record for both sides; we patch the
           source-side record into redux so the confirm card immediately
           reflects the unioned attributes / aliases / longer description
           the user just opted into. The target-side change lives on disk
           in the matched book's cast.json; we don't carry the rest of
           the workspace's cast state in this slice, so no client-side
           dispatch is needed for it — the next time that book opens it
           will hydrate from the updated file. */
          const res = await api.overrideLibraryCast({
            sourceBookId: bookId,
            sourceCharacterId,
            targetBookId,
            targetCharacterId,
          });
          if (res?.source) {
            dispatch(castActions.updateCharacter(res.source));
          }
        }}
        onConfirm={() => {
          dispatch(uiActions.confirmCast());
          dispatch(
            changeLogActions.appendLogEvent(
              buildCastConfirmEvent({
                characterCount: characters.length,
                bookTitle: manuscript.title || undefined,
              }),
            ),
          );
        }}
        onReanalyse={() => {
          /* Drop chapter-id-bearing entries (regenerate, chapter_complete,
           chapter_failed, boundary_move) because the upcoming reparse
           reshuffles chapter ids. Cast/voice prefs survive — those are
           still meaningful after a reparse. */
          guard(() => {
            dispatch(changeLogActions.wipeBookShapeEvents());
            dispatch(uiActions.reanalyse());
          });
        }}
      />
      {guardModal}
    </>
  );
}

export function ReadyRoute() {
  const { bookId = '', view: rawView } = useParams<{ bookId: string; view: string }>();
  const [searchParams] = useSearchParams();
  const view: View = (VALID_VIEWS as string[]).includes(rawView ?? '') ? (rawView as View) : 'cast';
  const chapterStr = searchParams.get('chapter');
  const currentChapterId =
    chapterStr != null && !Number.isNaN(parseInt(chapterStr, 10)) ? parseInt(chapterStr, 10) : 3;
  const openProfileId = searchParams.get('profile');

  useHydrateStage({ kind: 'ready', bookId, view, currentChapterId, openProfileId }, [
    bookId,
    view,
    currentChapterId,
    openProfileId,
  ]);

  return <ReadyViewSwitch view={view} bookId={bookId} currentChapterId={currentChapterId} />;
}

/* Inner view switch for the ready stage. Kept as a small sub-component so
   the param-derivation effect runs ahead of the view's selectors. */
function ReadyViewSwitch({
  view,
  bookId,
  currentChapterId,
}: {
  view: View;
  bookId: string;
  currentChapterId: number;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { priorRoster, pushToast } = useOutletContext<LayoutContext>();
  /* Plan 89 C3 — shallow equality for the active book's `chapters` array;
     unchanged identity must not re-render the ReadyViewSwitch when an
     unrelated slice mutates (e.g. notifications, exports for another book). */
  const characters = useAppSelector((s) => s.cast.characters);
  const chapters = useAppSelectorShallow((s) => s.chapters.chapters);
  /* Plan 102 Should #5 — the Generate view's paused affordances (ETA clock
     freeze, "Paused" pill, stall suppression) now read the queue-global pause
     flag; chapters.paused was removed (the queue + dispatcher own scheduling). */
  const paused = useAppSelector((s) => s.queue.paused);
  /* Cast view shows drift indicators per character, scoped to the
     active book. The slice's `drift` is flat across books since the
     Drift Report became multi-book; filter to bookId here so a
     non-active book's events don't render badges on this book's cast. */
  const drift = useAppSelector((s) => s.revisions.drift.filter((d) => d.bookId === bookId));
  const manuscript = useAppSelector((s) => s.manuscript);
  const library = useAppSelector((s) => s.library);
  const voices = useAppSelector((s) => s.voices.voices);
  const ui = useAppSelector((s) => s.ui);
  const changeLogEvents = useAppSelector((s) => s.changeLog.events);

  const activeBook = library.books.find((b) => b.bookId === bookId);
  /* Anchored to the manuscript slice's bookId so cross-book navigation —
     e.g. analysing Book A → clicking the generation pill to open Book B's
     Generate view — doesn't render Book A's stale title under
     "Generating …" until the disk re-hydrate lands. See manuscript-slice
     bookId tracking + Layout's matching projectTitle/hydration guards. */
  const manuscriptMatchesBook = manuscript.bookId === bookId;
  const projectTitle =
    (manuscriptMatchesBook ? manuscript.title : null) || activeBook?.title || null;

  const setCharacters = (next: Character[] | ((prev: Character[]) => Character[])) =>
    dispatch(castActions.setCharacters(typeof next === 'function' ? next(characters) : next));

  switch (view) {
    case 'manuscript':
      return (
        <ManuscriptView
          characters={characters}
          chapters={chapters}
          currentChapterId={currentChapterId}
          setCurrentChapterId={(id) => dispatch(uiActions.setCurrentChapterId(id))}
          sentencesFromStore={manuscript.sentences}
          onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
          onStartGenerating={() => {
            dispatch(uiActions.changeView('generate'));
            dispatch(uiActions.requestStartGeneration());
          }}
          priorRoster={priorRoster}
          onAddFromSeriesRoster={async (entry) => {
            try {
              const res = await api.addFromSeriesRoster({
                bookId,
                targetBookId: entry.bookId,
                targetCharacterId: entry.id,
              });
              dispatch(castActions.addCharacter(res.character));
              return res.character.id;
            } catch (err) {
              pushToast({
                kind: 'error',
                message: `Couldn't add ${entry.name}: ${err instanceof Error ? err.message : 'unknown error'}`,
                dedupeKey: 'add-from-roster',
              });
              throw err;
            }
          }}
        />
      );
    case 'cast':
      return (
        <CastView
          characters={characters}
          setCharacters={setCharacters}
          library={voices}
          sentences={manuscript.sentences}
          title={projectTitle}
          bookLanguage={activeBook?.language ?? 'en'}
          onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
          onShowMatchDetail={(id) => dispatch(uiActions.setMatchDetailFor(id))}
          driftEvents={drift}
          onShowDrift={(characterId) =>
            dispatch(
              characterId
                ? uiActions.openDriftReportForCharacter(characterId)
                : uiActions.setShowDriftReport(true),
            )
          }
        />
      );
    case 'library':
      /* Clicking a voice card opens the profile drawer for the linked
         character. If the voice belongs to the currently-open book we open
         the drawer in place (cast slice already carries those characters);
         otherwise we navigate to the source book's cast view so the drawer
         can render against that book's hydrated cast. */
      return (
        <LibraryView
          library={voices}
          onOpenCharacter={(voice) => {
            if (voice.bookId === bookId) {
              dispatch(uiActions.setOpenProfileId(voice.id));
            } else if (voice.bookId) {
              navigate(`/books/${voice.bookId}/cast?profile=${encodeURIComponent(voice.id)}`);
            }
          }}
        />
      );
    case 'generate':
      return (
        <GenerationView
          chapters={chapters}
          characters={characters}
          paused={paused}
          title={projectTitle}
          bookId={bookId}
          modelKey={ui.ttsModelKey}
          onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
          onRegenerateBook={() => {
            /* Whole-book regenerate: chapter 1 + scope='forward' covers
               every chapter while reusing the per-chapter modal. The scope
               override is cleared by setRegenChapter(null) on close. */
            if (chapters.length === 0) return;
            dispatch(uiActions.setRegenInitialScope('forward'));
            dispatch(uiActions.setRegenChapter(chapters[0]));
          }}
          onRegenerateCharacterInChapter={(charId, chapterId) =>
            dispatch(
              uiActions.setRegenCharacterCtx({ characterId: charId, defaultChapterId: chapterId }),
            )
          }
          onPreview={(id) => dispatch(uiActions.setCurrentTrack(id))}
        />
      );
    case 'listen':
      return <ListenRoute bookId={bookId} />;
    case 'log':
      return <ChangeLogView events={changeLogEvents} title={projectTitle} />;
    case 'restructure':
      return <RestructureView bookId={bookId} />;
  }
}

/* Listen view wrapper. Lives outside ReadyViewSwitch so the bookMeta /
   library selectors only fire while the user is actually on the listen
   route — and so the per-view component co-locates with its own state
   selectors instead of bloating the parent. */
function ListenRoute({ bookId }: { bookId: string }) {
  const dispatch = useAppDispatch();
  /* Repopulate the export queue rail from the server on mount / book
     change so a reload mid-export resumes — the poll middleware then
     advances any non-terminal rows to completion. */
  useEffect(() => {
    void dispatch(hydrateBookExports(bookId));
  }, [dispatch, bookId]);
  const { openFixCharacterAudio, pushToast } = useOutletContext<LayoutContext>();
  const chapters = useAppSelector((s) => s.chapters.chapters);
  const characters = useAppSelector((s) => s.cast.characters);
  const voices = useAppSelector((s) => s.voices.voices);
  const currentTrack = useAppSelector((s) => s.ui.currentTrack);
  const bookMeta = useAppSelector(selectEffectiveMeta(bookId));
  const isDirty = useAppSelector(selectIsDirty);
  const coverGradient = useAppSelector(
    (s) => s.library.books.find((b) => b.bookId === bookId)?.coverGradient ?? null,
  );
  const coverImageUrl = useAppSelector(
    (s) => s.library.books.find((b) => b.bookId === bookId)?.coverImageUrl ?? null,
  );
  const coverFraming = useAppSelector(
    (s) => s.library.books.find((b) => b.bookId === bookId)?.coverFraming,
  );
  return (
    <ListenView
      bookId={bookId}
      chapters={chapters}
      characters={characters}
      library={voices}
      currentTrack={currentTrack}
      setCurrentTrack={(t) => dispatch(uiActions.setCurrentTrack(t))}
      onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
      onEnterPreview={() => dispatch(uiActions.setPreviewMode(true))}
      onFixLine={async (marker) => {
        /* fs-26 — resolve the re-record marker's playhead to the chapter audio
           segment it sits in, then open the Fix-audio modal pre-scoped to that
           single character + segment. */
        const chapter = chapters.find((c) => c.id === marker.chapterId);
        const audio = await api
          .getChapterAudio({ bookId, chapterId: marker.chapterId, duration: chapter?.duration })
          .catch(() => null);
        const resolved = audio ? resolveSegmentForSec(marker.sec, audio.segments) : null;
        if (!resolved) {
          pushToast({
            kind: 'warn',
            message: 'No line found at this marker — try a marker on a spoken line.',
            dedupeKey: `fix-line-${marker.id}`,
          });
          return;
        }
        openFixCharacterAudio({
          characterId: resolved.characterId,
          preScoped: {
            mode: 'rerecord',
            chapterId: marker.chapterId,
            segmentIndices: [resolved.segmentIndex],
          },
        });
      }}
      bookMeta={bookMeta}
      bookCoverGradient={coverGradient}
      bookCoverImageUrl={coverImageUrl}
      bookCoverFraming={coverFraming}
      onCoverChanged={async () => {
        /* Refresh the library so the Listen view picks up the new
           coverImageUrl via the slice selector above. */
        const res = await api.getLibrary().catch(() => null);
        if (res) dispatch(libraryActions.hydrate(res));
      }}
      onEditMetaField={(field, value) => dispatch(bookMetaActions.setDraftField({ field, value }))}
      onCommitMeta={() => dispatch(bookMetaActions.commitDraft({ bookId }))}
      onCancelMeta={() => dispatch(bookMetaActions.cancelDraft())}
      isMetaDirty={isDirty}
    />
  );
}

interface ReparseDialogChapter {
  id: number;
  title: string;
  slug: string;
  wordCount: number;
  excluded: boolean;
}

/* Body shown inside the re-parse result dialog. Lives outside its parent's
   stale-closure scope so the model picker reads live redux state — the
   user's choice here lands in ui.selectedModel and the analysing view
   picks it up when "Analyse now" routes there.

   The chapter list is interactive: pre-tick rows the server preserved as
   excluded, layer the front/back-matter heuristic on top, let the user
   override per row. The parent owns the final set via a mutable callback
   (onChangeExcludedSlugs) so the dialog's onPrimary can apply deltas
   without coupling to dialog state. */
function ReparseResultBody({
  bookTitle,
  chapters,
  initialExcludedSlugs,
  onChangeExcludedSlugs,
}: {
  bookTitle: string;
  chapters: ReparseDialogChapter[];
  initialExcludedSlugs: Set<string>;
  onChangeExcludedSlugs: (s: Set<string>) => void;
}): ReactNode {
  const dispatch = useAppDispatch();
  const selectedModel = useAppSelector((s) => s.ui.selectedModel);
  /* Combine the server-preserved excluded set with auto-suggestions
     against the *new* chapter list. The heuristic only adds (never
     removes) — if the server preserved Chapter 1 as excluded but the
     heuristic doesn't think Chapter 1 is front-matter, we still respect
     the preservation. Computed once on mount; "Reset suggestions" snaps
     back to this combined baseline. */
  const suggestedExcludedSlugs = useMemo(() => {
    const out = new Set(initialExcludedSlugs);
    for (const ch of chapters) {
      const slug = ch.slug || chapterSlug(ch.id, ch.title);
      if (isLikelyFrontMatter(ch.title, ch.wordCount)) out.add(slug);
    }
    return out;
  }, [chapters, initialExcludedSlugs]);

  const [excludedSlugs, setExcludedSlugs] = useState<Set<string>>(suggestedExcludedSlugs);
  const [showChapterList, setShowChapterList] = useState<boolean>(false);

  /* Mirror local state into the parent's box so the onPrimary closure
     sees the latest selection without re-rendering. */
  useEffect(() => {
    onChangeExcludedSlugs(excludedSlugs);
  }, [excludedSlugs, onChangeExcludedSlugs]);

  return (
    <div className="space-y-3">
      <p>
        <span className="font-semibold text-ink">{chapters.length}</span> chapter
        {chapters.length === 1 ? '' : 's'} detected in{' '}
        <span className="font-semibold text-ink">{bookTitle}</span>.
      </p>

      <ChapterExclusionList
        chapters={chapters}
        excludedSlugs={excludedSlugs}
        onToggle={(slug, include) => {
          setExcludedSlugs((prev) => {
            const next = new Set(prev);
            if (include) next.delete(slug);
            else next.add(slug);
            return next;
          });
        }}
        onSelectAll={() => setExcludedSlugs(new Set())}
        onResetSuggestions={() => setExcludedSlugs(new Set(suggestedExcludedSlugs))}
        expanded={showChapterList}
        onToggleExpanded={() => setShowChapterList((v) => !v)}
        disabled={false}
        heading="Chapters to analyze"
      />

      <label className="flex items-center justify-between gap-3 rounded-2xl bg-canvas border border-ink/10 px-3 py-2.5">
        <span className="text-sm font-medium text-ink">Analyse with</span>
        <select
          value={selectedModel}
          onChange={(e) => dispatch(uiActions.setSelectedModel(e.target.value))}
          className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
        >
          {MODEL_OPTION_GROUPS.map((g) => (
            <optgroup key={g.engine} label={g.label}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id} title={m.hint}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <p className="text-ink/55 text-xs">
        Cast and analysis cache were cleared. Hit "Analyse now" to run character detection +
        sentence attribution against the new chapter list. You can still switch models on the
        analysing screen if the run goes sideways.
      </p>
    </div>
  );
}

/* Fire setChapterExcluded for every chapter whose include/exclude state
   differs between the server's preserved set and the user's final
   choice. Runs in parallel — typical bookkeeping is a handful of
   toggles. Errors are logged but don't propagate; the worst case is a
   chapter that should have been excluded slips into analysis, and the
   user can re-toggle from the Generate view. */
async function applyExcludedDeltas(
  bookId: string,
  chapters: ReparseDialogChapter[],
  initialSlugs: Set<string>,
  finalSlugs: Set<string>,
): Promise<void> {
  const slugToId = new Map<string, number>();
  for (const c of chapters) {
    const slug = c.slug || chapterSlug(c.id, c.title);
    slugToId.set(slug, c.id);
  }
  const calls: Array<Promise<unknown>> = [];
  /* Newly excluded — slugs in final but not in initial. */
  for (const slug of finalSlugs) {
    if (initialSlugs.has(slug)) continue;
    const id = slugToId.get(slug);
    if (id == null) continue;
    calls.push(
      api.setChapterExcluded(bookId, id, true).catch((err) => {
        console.error('[reparse] failed to exclude chapter', id, err);
      }),
    );
  }
  /* Newly included — slugs in initial but not in final. */
  for (const slug of initialSlugs) {
    if (finalSlugs.has(slug)) continue;
    const id = slugToId.get(slug);
    if (id == null) continue;
    calls.push(
      api.setChapterExcluded(bookId, id, false).catch((err) => {
        console.error('[reparse] failed to include chapter', id, err);
      }),
    );
  }
  await Promise.all(calls);
}

/* Catch-all → redirect home. Replaces parseHash's fallback to { kind: 'books' }. */
function NotFound() {
  return <Navigate to="/" replace />;
}

export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <BooksRoute /> },
      { path: 'new', element: <UploadRoute /> },
      { path: 'voices', element: <VoicesRoute /> },
      { path: 'log', element: <ChangelogRoute /> },
      { path: 'account', element: <AccountRoute /> },
      { path: 'admin', element: <AdminRoute /> },
      /* Inbound alias for old dev bookmarks; stageToHash canonicalises to #/admin. */
      { path: 'worktrees', element: <AdminRoute /> },
      { path: 'models', element: <ModelManagerRoute /> },
      { path: 'about', element: <AboutRoute /> },
      { path: 'advanced', element: <AdvancedRoute /> },
      { path: 'release-notes', element: <ReleaseNotesRoute /> },
      { path: 'books/:bookId/analysing', element: <AnalysingRoute /> },
      { path: 'books/:bookId/confirm', element: <ConfirmRoute /> },
      { path: 'books/:bookId/:view', element: <ReadyRoute /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
