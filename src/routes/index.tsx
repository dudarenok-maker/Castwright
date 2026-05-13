/* react-router v6 route tree. Each route element derives its Stage from
   URL params and dispatches uiActions.hydrateFromUrl when the URL says
   something different from the current redux state. The Layout component
   owns the reverse direction (Redux→URL sync). */

import { useEffect, type ReactNode } from 'react';
import {
  createHashRouter, Navigate, useOutletContext,
  useParams, useSearchParams,
} from 'react-router-dom';
import { useAppDispatch, useAppSelector, store } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { chaptersActions } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { libraryActions } from '../store/library-slice';
import { api } from '../lib/api';
import { stageEqual } from '../lib/router';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import { MODEL_OPTIONS } from '../lib/models';
import { Layout, type LayoutContext } from '../components/layout';
import { UploadView } from '../views/upload';
import { AnalysingView } from '../views/analysing';
import { ConfirmCastView } from '../views/confirm-cast';
import { ManuscriptView } from '../views/manuscript';
import { CastView } from '../views/cast';
import { LibraryView } from '../views/voices';
import { GenerationView } from '../views/generation';
import { ListenView } from '../views/listen';
import { BookLibraryView } from '../views/book-library';
import { ConfirmMetadataView } from '../views/confirm-metadata';
import { ChangeLogView } from '../views/change-log';
import type { Character, Stage, View } from '../lib/types';

const VALID_VIEWS: View[] = ['manuscript', 'cast', 'library', 'generate', 'listen', 'log'];

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

function BooksRoute() {
  useHydrateStage({ kind: 'books' }, []);
  const dispatch = useAppDispatch();
  const library = useAppSelector(s => s.library);
  const bookId  = useAppSelector(s => (s.ui.stage as { bookId?: string }).bookId ?? null);
  const { showInfo, showError } = useOutletContext<LayoutContext>();

  return (
    <BookLibraryView authors={library.authors} activeBookId={bookId}
      onOpenBook={(b) => dispatch(uiActions.openBook({ id: b.bookId, status: b.status, manuscriptId: b.manuscriptId }))}
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
      onReparseBook={async (b) => {
        let result;
        try {
          result = await api.reparseBook(b.bookId);
        } catch (err) {
          showError(`Couldn't re-parse "${b.title}"`, (err as Error).message, 'Re-parse');
          return;
        }
        const res = await api.getLibrary().catch(() => null);
        if (res) dispatch(libraryActions.hydrate(res));
        if (bookId === b.bookId) dispatch(uiActions.goHome());

        const chapters = result.chapterTitles;
        const body = <ReparseResultBody bookTitle={b.title} chapters={chapters}/>;

        const updatedBook = res?.authors
          .flatMap(a => a.series.flatMap(s => s.books))
          .find(book => book.bookId === b.bookId);

        showInfo({
          eyebrow: 'Re-parse',
          title: 'Manuscript re-parsed',
          body,
          primaryLabel: 'Analyse now',
          onPrimary: () => {
            const target = updatedBook ?? b;
            dispatch(uiActions.openBook({
              id: target.bookId,
              status: 'analysing',
              manuscriptId: target.manuscriptId,
            }));
          },
        });
      }}
      onStartNew={() => dispatch(uiActions.startNewBook())}/>
  );
}

function UploadRoute() {
  useHydrateStage({ kind: 'upload' }, []);
  const importCandidate = useAppSelector(s => s.manuscript.importCandidate);
  return importCandidate ? <ConfirmMetadataView/> : <UploadView/>;
}

function VoicesRoute() {
  useHydrateStage({ kind: 'voices' }, []);
  const voices = useAppSelector(s => s.voices.voices);
  return <LibraryView library={voices}/>;
}

function ChangelogRoute() {
  useHydrateStage({ kind: 'changelog' }, []);
  return <ChangeLogView events={CHANGE_LOG_EVENTS}/>;
}

function AnalysingRoute() {
  const { bookId = '' } = useParams<{ bookId: string }>();
  useHydrateStage({ kind: 'analysing', bookId, manuscriptId: null }, [bookId]);

  const dispatch = useAppDispatch();
  const stage      = useAppSelector(s => s.ui.stage);
  const manuscript = useAppSelector(s => s.manuscript);
  const library    = useAppSelector(s => s.library);
  const ui         = useAppSelector(s => s.ui);
  const activeBook = library.books.find(b => b.bookId === bookId);
  const manuscriptId = stage.kind === 'analysing' ? stage.manuscriptId ?? null : null;

  return (
    <AnalysingView
      manuscriptId={manuscriptId}
      title={manuscript.title || activeBook?.title || null}
      wordCount={manuscript.wordCount}
      model={ui.selectedModel}
      onComplete={(payload) => {
        dispatch(castActions.hydrateFromAnalysis(payload));
        dispatch(chaptersActions.hydrateFromAnalysis(payload));
        dispatch(manuscriptActions.hydrateFromAnalysis(payload));
        dispatch(uiActions.analysisComplete({ bookId: payload.bookId }));
      }}/>
  );
}

function ConfirmRoute() {
  const { bookId = '' } = useParams<{ bookId: string }>();
  useHydrateStage({ kind: 'confirm', bookId }, [bookId]);

  const dispatch = useAppDispatch();
  const characters = useAppSelector(s => s.cast.characters);
  const voices     = useAppSelector(s => s.voices.voices);
  const manuscript = useAppSelector(s => s.manuscript);

  return (
    <ConfirmCastView characters={characters} library={voices}
      title={manuscript.title}
      onConfirm={() => dispatch(uiActions.confirmCast())}
      onReanalyse={() => dispatch(uiActions.reanalyse())}/>
  );
}

function ReadyRoute() {
  const { bookId = '', view: rawView } = useParams<{ bookId: string; view: string }>();
  const [searchParams] = useSearchParams();
  const view: View = (VALID_VIEWS as string[]).includes(rawView ?? '') ? (rawView as View) : 'cast';
  const chapterStr = searchParams.get('chapter');
  const currentChapterId = chapterStr != null && !Number.isNaN(parseInt(chapterStr, 10))
    ? parseInt(chapterStr, 10) : 3;
  const openProfileId = searchParams.get('profile');

  useHydrateStage(
    { kind: 'ready', bookId, view, currentChapterId, openProfileId },
    [bookId, view, currentChapterId, openProfileId],
  );

  return <ReadyViewSwitch view={view} bookId={bookId} currentChapterId={currentChapterId}/>;
}

/* Inner view switch for the ready stage. Kept as a small sub-component so
   the param-derivation effect runs ahead of the view's selectors. */
function ReadyViewSwitch({ view, bookId, currentChapterId }: { view: View; bookId: string; currentChapterId: number }) {
  const dispatch = useAppDispatch();
  const characters = useAppSelector(s => s.cast.characters);
  const chapters   = useAppSelector(s => s.chapters.chapters);
  const paused     = useAppSelector(s => s.chapters.paused);
  const drift      = useAppSelector(s => s.revisions.drift);
  const manuscript = useAppSelector(s => s.manuscript);
  const library    = useAppSelector(s => s.library);
  const voices     = useAppSelector(s => s.voices.voices);
  const ui         = useAppSelector(s => s.ui);

  const activeBook   = library.books.find(b => b.bookId === bookId);
  const projectTitle = manuscript.title || activeBook?.title || null;

  const setCharacters = (next: Character[] | ((prev: Character[]) => Character[])) =>
    dispatch(castActions.setCharacters(typeof next === 'function' ? next(characters) : next));

  switch (view) {
    case 'manuscript':
      return (
        <ManuscriptView characters={characters} chapters={chapters}
          currentChapterId={currentChapterId}
          setCurrentChapterId={(id) => dispatch(uiActions.setCurrentChapterId(id))}
          sentencesFromStore={manuscript.sentences}
          onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
          onStartGenerating={() => dispatch(uiActions.changeView('generate'))}/>
      );
    case 'cast':
      return (
        <CastView characters={characters} setCharacters={setCharacters} library={voices}
          title={projectTitle}
          onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
          onShowMatchDetail={(id) => dispatch(uiActions.setMatchDetailFor(id))}
          onBatchRegenerate={(ids) => dispatch(uiActions.setBatchRegenIds(ids))}
          driftEvents={drift}
          onShowDrift={() => dispatch(uiActions.setShowDriftReport(true))}/>
      );
    case 'library':
      return <LibraryView library={voices}/>;
    case 'generate':
      return (
        <GenerationView chapters={chapters} characters={characters}
          paused={paused}
          title={projectTitle}
          bookId={bookId}
          modelKey={ui.ttsModelKey}
          setPaused={(p) => dispatch(chaptersActions.setPaused(p))}
          onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
          onRegenerateCharacterInChapter={(charId, chapterId) =>
            dispatch(uiActions.setRegenCharacterCtx({ characterId: charId, defaultChapterId: chapterId }))}
          onPreview={(id) => dispatch(uiActions.setCurrentTrack(id))}/>
      );
    case 'listen':
      return (
        <ListenView chapters={chapters} characters={characters} library={voices}
          currentTrack={ui.currentTrack}
          setCurrentTrack={(t) => dispatch(uiActions.setCurrentTrack(t))}
          onSendApp={(app) => dispatch(uiActions.setHandoffApp(app))}
          onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
          onEnterPreview={() => dispatch(uiActions.setPreviewMode(true))}/>
      );
    case 'log':
      return <ChangeLogView events={CHANGE_LOG_EVENTS} title={projectTitle}/>;
  }
}

/* Body shown inside the re-parse result dialog. Lives outside its parent's
   stale-closure scope so the model picker reads live redux state — the
   user's choice here lands in ui.selectedModel and the analysing view
   picks it up when "Analyse now" routes there. */
function ReparseResultBody({ bookTitle, chapters }: { bookTitle: string; chapters: string[] }): ReactNode {
  const dispatch = useAppDispatch();
  const selectedModel = useAppSelector(s => s.ui.selectedModel);
  return (
    <div className="space-y-3">
      <p>
        <span className="font-semibold text-ink">{chapters.length}</span>{' '}
        chapter{chapters.length === 1 ? '' : 's'} detected in{' '}
        <span className="font-semibold text-ink">{bookTitle}</span>.
      </p>
      <div className="rounded-2xl border border-ink/10 overflow-hidden">
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink/[0.03] text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
              <tr>
                <th className="text-right tabular-nums px-3 py-2 w-12">#</th>
                <th className="text-left px-3 py-2">Chapter title</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {chapters.map((title, i) => (
                <tr key={i} className="hover:bg-ink/[0.02]">
                  <td className="text-right tabular-nums text-ink/50 px-3 py-2 w-12">{i + 1}</td>
                  <td className="text-ink px-3 py-2 font-medium">{title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-2xl bg-canvas border border-ink/10 px-3 py-2.5">
        <span className="text-sm font-medium text-ink">Analyse with</span>
        <select
          value={selectedModel}
          onChange={(e) => dispatch(uiActions.setSelectedModel(e.target.value))}
          className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
        >
          {MODEL_OPTIONS.map(m => (
            <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
          ))}
        </select>
      </label>

      <p className="text-ink/55 text-xs">
        Cast and analysis cache were cleared. Hit "Analyse now" to run character detection + sentence attribution against the new chapter list. You can still switch models on the analysing screen if the run goes sideways.
      </p>
    </div>
  );
}

/* Catch-all → redirect home. Replaces parseHash's fallback to { kind: 'books' }. */
function NotFound() {
  return <Navigate to="/" replace/>;
}

export const router = createHashRouter([
  {
    path: '/',
    element: <Layout/>,
    children: [
      { index: true,                                element: <BooksRoute/> },
      { path: 'new',                                element: <UploadRoute/> },
      { path: 'voices',                             element: <VoicesRoute/> },
      { path: 'log',                                element: <ChangelogRoute/> },
      { path: 'books/:bookId/analysing',            element: <AnalysingRoute/> },
      { path: 'books/:bookId/confirm',              element: <ConfirmRoute/> },
      { path: 'books/:bookId/:view',                element: <ReadyRoute/> },
      { path: '*',                                  element: <NotFound/> },
    ],
  },
]);
