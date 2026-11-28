/* #3519 — the stage-versus-slice harness: every async write into the cast,
   chapters and manuscript slices applies only to the book the slices hold.

   One row per writer. Each row starts the writer for a book while the slices
   hold it, then the test moves the stage and the slices apart before the late
   answer lands:

     (i)   slices hold A, stage names B, a late result for B lands nowhere;
     (ii)  slices hold A, stage names B, a late result for A lands;
     (iii) slices hold A, stage names A (back from B), a late result for B
           lands nowhere.

   Two more run each writer with the manuscript slice naming B while the
   loaded-book pair names A, so only the pair gives the right answer:

     (iv)  stage names B, a late result for B lands nowhere;
     (v)   stage names A, a late result for A lands.

   Every fixture book shares its ids with the others (test/stage-slice-harness),
   so a write that ignores which book it was made for changes the held book.

   A row with `dropsOffStage` belongs to a writer that also requires the stage
   (or its mounted view's own condition) to name the book: (ii) asserts it
   writes nothing, and a control shows it does write while the stage names the
   book. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Middleware } from '@reduxjs/toolkit';
import { cloneElement, createElement, type ComponentProps, type ReactElement } from 'react';
import { Provider } from 'react-redux';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { AnalysingView } from '../views/analysing';
import { GenerationView } from '../views/generation';
import { UploadView } from '../views/upload';
import { RestructureView } from '../views/restructure';
import { ScriptReviewDiff } from '../components/script-review-diff';
import { RebaselineModalContainer } from '../modals/rebaseline-modal';
import { AnalysingRoute, BooksRoute, ConfirmRoute, ReadyRoute } from '../routes';
import { scriptReviewActions } from './script-review-slice';
import { useTtsLifecycle } from '../lib/use-tts-lifecycle';
import { Layout } from '../components/layout';
import type { ProfileDrawer as RealProfileDrawer } from '../modals/profile-drawer';
import { libraryActions } from './library-slice';
import { castActions } from './cast-slice';
import { CastView } from '../views/cast';
import { LibraryView as VoicesView } from '../views/voices';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchVoiceLibrary } from './voice-library-slice';
import { uiActions } from './ui-slice';
import { DetectEmotionsButton } from '../components/detect-emotions-button';
import { EmotionVariantDesigner } from '../components/emotion-variant-designer';
import { VoiceLibraryPanel } from '../components/voice-library-panel';
import { PromoteFirstSentenceButton } from '../components/promote-first-sentence-button';
import { EditChapterTitleModal } from '../modals/edit-chapter-title';
import { DuplicateReviewModal } from '../modals/duplicate-review-modal';
import { ProfileDrawer } from '../modals/profile-drawer';
import {
  bookCast,
  bookChapters,
  bookSentences,
  createStageSliceHarness,
  manuscriptIdOf,
  type StageSliceHarness,
} from '../test/stage-slice-harness';
import { declineMatchFlow } from './decline-match-flow';
import { refreshEmotionVariants } from './emotion-variants-refresh';
import { rehydrateCastAfterAnalysis } from './cast-gate';
import { castDesignMiddleware } from './cast-design-stream-middleware';
import { castDesignActions } from './cast-design-slice';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { queueActions } from './queue-slice';
import { cancelQueueEntry } from './queue-thunks';
import { qaRepairRunnerMiddleware } from './qa-repair-runner-middleware';
import { qaRepairActions } from './qa-repair-slice';
import { spliceRunnerMiddleware } from './splice-runner-middleware';
import { spliceActions } from './splice-slice';
import type { Stage } from '../lib/types';

/* ── The api seam ─────────────────────────────────────────────────────────
   Every `api.*` method is a mock that never answers unless a row says
   otherwise, so mounting a view starts no write of its own. */
const apiMock = vi.hoisted(() => {
  type Fn = ReturnType<typeof import('vitest').vi.fn>;
  const fns = new Map<string, Fn>();
  return { fns };
});
const never = () => new Promise<never>(() => {});
function apiFn(name: string) {
  let fn = apiMock.fns.get(name);
  if (!fn) {
    fn = vi.fn(never);
    apiMock.fns.set(name, fn);
  }
  return fn;
}
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: new Proxy(
      {},
      {
        get: (_target, name) => {
          let fn = apiMock.fns.get(String(name));
          if (!fn) {
            fn = vi.fn(() => new Promise(() => {}));
            apiMock.fns.set(String(name), fn);
          }
          return fn;
        },
      },
    ),
  };
});

/* Views whose handlers a row calls directly: the real component renders, and
   the props it was last given are recorded. */
const seen = vi.hoisted(() => {
  const props = new Map<string, unknown>();
  const record = async (importOriginal: () => Promise<unknown>, name: string) => {
    const actual = (await importOriginal()) as Record<string, never>;
    const { createElement: h } = await import('react');
    return {
      ...actual,
      [name]: (given: object) => {
        props.set(name, given);
        return h(actual[name], given as never);
      },
    };
  };
  return { props, record };
});
vi.mock('../modals/profile-drawer', (original) => seen.record(original, 'ProfileDrawer'));
vi.mock('../modals/start-generation', (original) =>
  seen.record(original, 'StartGenerationModal'),
);
vi.mock('../modals/compare-cast-modal', (original) => seen.record(original, 'CompareCastModal'));
vi.mock('../modals/duplicate-review-modal', (original) =>
  seen.record(original, 'DuplicateReviewModal'),
);
vi.mock('../views/analysing', (original) => seen.record(original, 'AnalysingView'));
vi.mock('../views/confirm-cast', (original) => seen.record(original, 'ConfirmCastView'));
vi.mock('../views/book-library', (original) => seen.record(original, 'BookLibraryView'));
vi.mock('../components/restructure-chapters-panel', (original) =>
  seen.record(original, 'RestructureChaptersPanel'),
);

/** The handlers `name` was rendered with, once it has rendered. */
async function propsOf<T>(name: string): Promise<T> {
  await vi.waitFor(() => expect(seen.props.get(name)).toBeDefined(), { timeout: 5000 });
  return seen.props.get(name) as T;
}

/* A few views and routes read the app's own `store` beside the Provider's. In
   the app they are one store, so here they are the harness store too. */
const appStore = vi.hoisted(() => ({ current: null as object | null }));
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index')>();
  return {
    ...actual,
    store: new Proxy(actual.store, {
      get: (own, key) => {
        const target = (appStore.current ?? own) as Record<string | symbol, unknown>;
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

/** Hold the next answer of `api.<name>` open; the returned function sends it. */
function pend(name: string) {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  apiFn(name).mockImplementationOnce(() => promise);
  return async (value?: unknown) => {
    await act(async () => {
      resolve(value);
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await flush();
  };
}

const called = (name: string) => vi.waitFor(() => expect(apiFn(name)).toHaveBeenCalled());

/** Capture the callbacks object a streaming api method was opened with. */
function capture<T>(name: string, pick: (args: unknown[]) => T, result: unknown = () => {}) {
  const box: { value?: T } = {};
  apiFn(name).mockImplementation((...args: unknown[]) => {
    box.value = pick(args);
    return result;
  });
  return async (): Promise<T> => {
    await vi.waitFor(() => expect(box.value).toBeDefined());
    return box.value as T;
  };
}

/** A late stream frame: send it and let its writes settle. */
const frame = async (send: () => void) => {
  await act(async () => {
    send();
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  await flush();
};

/* ── The table ──────────────────────────────────────────────────────────── */

type H = StageSliceHarness;
type Late = () => Promise<void>;

interface Row {
  /** Where the writer lives and what it writes. */
  writer: string;
  /** The stage that names `book` for this writer. Default: its cast view. */
  stage?: (book: string) => Stage;
  middleware?: () => Middleware[];
  /** Arrange whatever the writer needs of the held book (before it starts). */
  arrange?: (h: H, book: string) => void;
  /** Start the writer for `book`, which the slices hold; resolves to its late answer. */
  start: (h: H, book: string) => Promise<Late>;
  /** Assert the late write reached the held book, A. */
  lands: (h: H) => void;
  /** Why this writer writes nothing once the stage names another book. */
  dropsOffStage?: string;
}

const ready = (bookId: string, view: 'cast' | 'manuscript' | 'generate' | 'voices' = 'cast'): Stage =>
  ({ kind: 'ready', bookId, view, currentChapterId: 1, openProfileId: null }) as Stage;

const row = (h: H, id: string) => h.store.getState().cast.characters.find((c) => c.id === id)!;
const chapter = (h: H, id: number) =>
  h.store.getState().chapters.chapters.find((c) => c.id === id)!;

const libraryEntry = (voiceUuid: string) => ({
  voiceUuid,
  name: 'Halloran',
  provenance: 'designed' as const,
  tags: [],
  pinned: false,
  engines: { qwen: { status: 'ready' as const } },
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
});

/* ── Writers driven through their exported thunk or middleware ──────────── */

const thunkRows: Row[] = [
  {
    writer: 'store/decline-match-flow.ts declineMatchFlow (cast)',
    start: async (h) => {
      const answer = pend('declineVoiceLink');
      void h.store.dispatch(declineMatchFlow('moss'));
      await called('declineVoiceLink');
      return () => answer({ declinedVoiceFrom: ['prior'], declinedVoiceUuids: [] });
    },
    lands: (h) => expect(row(h, 'moss').matchedFrom).toBeUndefined(),
  },
  {
    writer: 'store/emotion-variants-refresh.ts refreshEmotionVariants (cast)',
    start: async (h, book) => {
      const answer = pend('getBookState');
      void h.store.dispatch(refreshEmotionVariants(book, 'wren'));
      await called('getBookState');
      const fresh = bookCast(book).map((c) =>
        c.id === 'wren' ? { ...c, overrideTtsVoices: { qwen: { name: 'qwen-v-wren' } } } : c,
      );
      return () =>
        answer({ state: { manuscriptId: manuscriptIdOf(book) }, cast: { characters: fresh } });
    },
    lands: (h) => expect(row(h, 'wren').overrideTtsVoices?.qwen?.variants?.angry).toBeUndefined(),
  },
  {
    writer: 'store/cast-gate.ts rehydrateCastAfterAnalysis (cast + manuscript)',
    start: async (h, book) => {
      apiFn('getBookBusy').mockImplementation(() => Promise.resolve([]));
      const answer = pend('getBookState');
      void h.store.dispatch(rehydrateCastAfterAnalysis(book));
      await called('getBookState');
      return () =>
        answer({
          state: { bookId: book, manuscriptId: manuscriptIdOf(book), title: `Re-read ${book}` },
          cast: { characters: [{ ...bookCast(book)[1], name: 'Re-read Wren' }] },
          manuscriptEdits: null,
        });
    },
    lands: (h) => {
      expect(row(h, 'wren').name).toBe('Re-read Wren');
      expect(h.store.getState().manuscript.title).toBe('Re-read A');
    },
  },
  {
    writer: 'store/cast-design-stream-middleware.ts full-cast design frames (cast)',
    middleware: () => [castDesignMiddleware],
    start: async (h, book) => {
      type Cb = import('../lib/api').CastDesignCallbacks;
      const callbacks = capture<Cb>('startCastDesign', (args) => args[2] as Cb);
      h.store.dispatch(
        castDesignActions.designAllRequested({
          bookId: book,
          characterIds: ['moss', 'wren'],
          modelKey: 'qwen3-tts-0.6b',
          scope: 'both',
          variantTasks: [],
        } as Parameters<typeof castDesignActions.designAllRequested>[0]),
      );
      const cb = await callbacks();
      return () =>
        frame(() => {
          cb.onCharacterDesigned?.({ characterId: 'moss', voiceId: 'qwen-designed' } as never);
          cb.onVariantDesigned?.({
            characterId: 'wren',
            emotion: 'sad',
            voiceId: 'qwen-sad',
          } as never);
        });
    },
    lands: (h) => {
      expect(row(h, 'moss').overrideTtsVoices?.qwen?.name).toBe('qwen-designed');
      expect(row(h, 'wren').overrideTtsVoices?.qwen?.variants?.sad?.name).toBe('qwen-sad');
    },
  },
  {
    writer: 'store/cast-design-stream-middleware.ts single-design frames (cast)',
    middleware: () => [castDesignMiddleware],
    start: async (h, book) => {
      type Cb = import('../lib/api').CastDesignCallbacks;
      const callbacks = capture<Cb>('startSingleDesign', (args) => args[2] as Cb);
      h.store.dispatch(
        castDesignActions.designSingleRequested({
          bookId: book,
          characterId: 'moss',
          name: 'Moss',
          persona: 'low and slow',
          sampleVoiceId: 'v-moss',
          modelKey: 'qwen3-tts-0.6b',
          mode: 'first',
        } as Parameters<typeof castDesignActions.designSingleRequested>[0]),
      );
      const cb = await callbacks();
      return () =>
        frame(() => {
          cb.onPreviewReady?.({
            characterId: 'wren',
            name: 'Wren',
            previewVoiceId: 'p',
            previewUrl: 'u',
            persona: 'p',
            voiceUuid: 'uuid-preview',
          } as never);
          cb.onCharacterDesigned?.({
            characterId: 'moss',
            voiceId: 'qwen-designed',
            voiceUuid: 'uuid-moss',
          } as never);
        });
    },
    lands: (h) => {
      expect(row(h, 'wren').voiceUuid).toBe('uuid-preview');
      expect(row(h, 'moss').overrideTtsVoices?.qwen?.name).toBe('qwen-designed');
      expect(row(h, 'moss').voiceUuid).toBe('uuid-moss');
    },
  },
  {
    writer: 'store/generation-stream-runner.ts progress ticks (chapters)',
    stage: (b) => ready(b, 'generate'),
    start: async (h, book) => {
      type Open = { onTick: (ev: unknown) => void };
      const opened = capture<Open>('streamGeneration', (args) => args[0] as Open);
      const runner = createStreamRunner(h.store as never);
      runner.open(book, 'qwen3-tts-0.6b', { chapterIds: [3] } as never, { chapterId: 3 });
      const { onTick } = await opened();
      return () =>
        frame(() => onTick({ type: 'progress', chapterId: 3, characterId: 'wren', progress: 0.5 }));
    },
    lands: (h) => expect(chapter(h, 3).state).toBe('in_progress'),
  },
  (() => {
    /* The dispatcher puts a row it flipped back when the server refuses the
       render as busy: that refusal is its late answer. */
    let streaming = true;
    const runner = {
      open: () => {},
      close: () => {},
      closeAll: () => {},
      openBookCount: () => 0,
      openBookIds: () => [],
      hasOpenStreamForChapter: () => streaming && opened,
      hasPendingLanguageGuard: () => false,
      takeChapterAwaitingConfirm: () => false,
      takeChapterFailure: () => ({ errorCode: 'book-busy', reason: 'busy' }),
    } as unknown as StreamRunner;
    let opened = false;
    runner.open = () => {
      opened = true;
    };
    const snapshotOf = (entries: unknown[]) =>
      queueActions.setSnapshot({ entries, paused: false, recycling: false } as never);
    return {
      writer: 'store/queue-dispatcher-middleware.ts restores a refused row (chapters)',
      stage: (b: string) => ready(b, 'generate'),
      middleware: () => [queueDispatcherMiddleware(() => runner)],
      start: async (h: H, book: string) => {
        streaming = true;
        opened = false;
        const entry = { id: `e-${book}`, bookId: book, chapterId: 1, scope: 'this', status: 'queued' };
        await frame(() => h.store.dispatch(snapshotOf([entry])));
        /* The claim flipped the rendered row to queued, on the held book. */
        expect(chapter(h, 1).state).not.toBe('done');
        return async () => {
          streaming = false;
          await frame(() => h.store.dispatch(snapshotOf([{ ...entry, status: 'in_progress' }])));
        };
      },
      lands: (h: H) => expect(chapter(h, 1).state).toBe('done'),
    } satisfies Row;
  })(),
  {
    writer: 'store/queue-thunks.ts cancelQueueEntry holds the chapter (chapters)',
    stage: (b) => ready(b, 'generate'),
    start: async (h, book) => {
      h.store.dispatch(
        queueActions.setSnapshot({
          entries: [{ id: 'e1', bookId: book, chapterId: 3, scope: 'this', status: 'queued' }],
          paused: false,
          recycling: false,
        } as never),
      );
      let respond!: (r: Response) => void;
      const fetchMock = vi.fn(() => new Promise<Response>((r) => (respond = r)));
      vi.stubGlobal('fetch', fetchMock);
      void h.store.dispatch(cancelQueueEntry('e1'));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      return () =>
        frame(() =>
          respond(
            new Response(JSON.stringify({ entries: [], paused: false, recycling: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        );
    },
    lands: (h) => expect(chapter(h, 3).held).toBe(true),
  },
  {
    writer: 'store/qa-repair-runner-middleware.ts repaired audio (chapters)',
    stage: (b) => ready(b, 'generate'),
    middleware: () => [qaRepairRunnerMiddleware()],
    start: async (h, book) => {
      type Open = { onTick: (ev: unknown) => void };
      const opened = capture<Open>('streamQaRepair', (args) => args[0] as Open, never());
      h.store.dispatch(qaRepairActions.start({ bookId: book, chapterId: 1 }));
      const { onTick } = await opened();
      return () =>
        frame(() => onTick({ type: 'qa_repair_complete', repaired: [1], durationSec: 3599 }));
    },
    lands: (h) => expect(chapter(h, 1).duration).not.toBe('1:00'),
  },
  {
    writer: 'store/splice-runner-middleware.ts spliced audio (chapters)',
    stage: (b) => ready(b, 'generate'),
    middleware: () => [spliceRunnerMiddleware()],
    start: async (h, book) => {
      type Open = { onTick: (ev: unknown) => void };
      const opened = capture<Open>('streamSplice', (args) => args[0] as Open, never());
      h.store.dispatch(
        spliceActions.startBatch({
          id: `splice-${book}`,
          bookId: book,
          characterId: 'wren',
          characterName: 'Wren',
          chapterIds: [1],
          mode: 'rerecord',
          modelKey: 'qwen3-tts-0.6b',
        } as Parameters<typeof spliceActions.startBatch>[0]),
      );
      const { onTick } = await opened();
      return () => frame(() => onTick({ type: 'splice_complete', durationSec: 3599 }));
    },
    lands: (h) => expect(chapter(h, 1).duration).not.toBe('1:00'),
  },
];

/* ── Writers that can only be driven through a mounted view ─────────────── */

/** Mount a view the way the model tests do (P4a/P4b/P4c): the harness store, a
    router, and nothing else. */
const tree = (h: H, element: ReactElement, path = '/') =>
  createElement(
    Provider,
    { store: h.store as never } as unknown as ComponentProps<typeof Provider>,
    createElement(MemoryRouter, { initialEntries: [path] }, element),
  );
const mount = (h: H, element: ReactElement, path = '/') => render(tree(h, element, path));

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const clickButton = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

const voiceOf = (bookId: string, id: string) =>
  ({
    id,
    character: 'Wren',
    bookId,
    bookTitle: `Book ${bookId}`,
    attributes: [],
    gradient: ['#A43C6C', '#3C194F'],
    usedIn: 1,
    source: 'current',
  }) as never;

/* The two sides of a duplicate review: `book`'s Wren (the shorter name, so it
   loses a link) and another book's longer-named row. */
const duplicatePair = (book: string) => ({
  a: { voice: voiceOf(book, 'voice-here'), character: bookCast(book)[1] },
  b: {
    voice: voiceOf('other', 'voice-there'),
    character: { ...bookCast('other')[1], id: 'p-other', name: `Wren of ${book} the Elder` },
  },
});

const variantDesigner = (book: string) =>
  createElement(EmotionVariantDesigner, {
    bookId: book,
    character: bookCast(book)[1],
    sampleVoiceId: 'v-wren',
    modelKey: 'qwen3-tts-0.6b',
    baseDesigned: true,
    variants: bookCast(book)[1].overrideTtsVoices?.qwen?.variants,
  } as ComponentProps<typeof EmotionVariantDesigner>);

const smallViewRows: Row[] = [
  {
    writer: '[view] components/detect-emotions-button.tsx annotations (manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h) => {
      type Opts = { onAnnotation: (e: unknown) => void };
      const opened = capture<Opts>('detectEmotions', (args) => args[1] as Opts, never());
      mount(h, createElement(DetectEmotionsButton));
      click('detect-emotions-button');
      const { onAnnotation } = await opened();
      return () =>
        frame(() =>
          onAnnotation({ chapterId: 1, annotations: [{ sentenceId: 2, emotion: 'angry' }] }),
        );
    },
    lands: (h) => expect(h.store.getState().manuscript.sentences[1].emotion).toBe('angry'),
    dropsOffStage: 'annotations apply only while the stage names the book too (#3435)',
  },
  {
    writer: '[view] components/emotion-variant-designer.tsx design (cast)',
    start: async (h, book) => {
      const answer = pend('designQwenVoice');
      mount(h, variantDesigner(book));
      fireEvent.click(screen.getByLabelText('Design the Sad variant'));
      await called('designQwenVoice');
      return () => answer({ voiceId: 'qwen-v-wren__sad' });
    },
    lands: (h) => expect(row(h, 'wren').overrideTtsVoices?.qwen?.variants?.sad).toBeDefined(),
  },
  {
    writer: '[view] components/emotion-variant-designer.tsx remove (cast)',
    start: async (h, book) => {
      const answer = pend('removeQwenVariant');
      mount(h, variantDesigner(book));
      click('variant-remove-angry');
      await called('removeQwenVariant');
      return () => answer();
    },
    lands: (h) => expect(row(h, 'wren').overrideTtsVoices?.qwen?.variants?.angry).toBeUndefined(),
  },
  {
    writer: '[view] components/voice-library-panel.tsx assign from My voices (cast)',
    start: async (h, book) => {
      /* The assign thunk re-reads the library before it settles. */
      apiFn('listVoiceLibrary').mockImplementation(() =>
        Promise.resolve({ voices: [libraryEntry('lib2')] }),
      );
      await act(async () => {
        await h.store.dispatch(fetchVoiceLibrary());
      });
      const answer = pend('assignLibraryVoice');
      mount(
        h,
        createElement(VoiceLibraryPanel, {
          library: [],
          draggingVoiceId: null,
          setDraggingVoiceId: () => {},
          bookId: book,
          characters: bookCast(book),
        } as unknown as ComponentProps<typeof VoiceLibraryPanel>),
      );
      click('my-voices-panel-assign-lib2');
      click('my-voices-panel-assign-target-lib2-wren');
      await called('assignLibraryVoice');
      return () => answer({ updated: 1, written: ['qwen'] });
    },
    lands: (h) => expect(row(h, 'wren').overrideTtsVoices?.qwen?.libraryUuid).toBe('lib2'),
  },
  {
    writer: '[view] components/promote-first-sentence-button.tsx promote (chapters + manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('renameChapter');
      mount(
        h,
        createElement(PromoteFirstSentenceButton, {
          bookId: book,
          chapterId: 1,
          firstSentence: { ...bookSentences(book)[0], text: `Promoted in ${book}` },
          isOnlySentence: false,
        }),
      );
      click('promote-first-sentence-button');
      const buttons = screen.getByRole('dialog').querySelectorAll('button');
      fireEvent.click(buttons[buttons.length - 1]);
      await called('renameChapter');
      return () => answer();
    },
    lands: (h) => {
      expect(chapter(h, 1).title).toBe('Promoted in A');
      expect(h.store.getState().manuscript.sentences.filter((s) => s.chapterId === 1)).toHaveLength(
        1,
      );
    },
  },
  {
    writer: '[view] modals/edit-chapter-title.tsx rename (chapters)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('renameChapter');
      mount(
        h,
        createElement(EditChapterTitleModal, {
          open: true,
          bookId: book,
          chapter: bookChapters(book)[0],
          onClose: () => {},
        }),
      );
      fireEvent.change(screen.getByRole('textbox'), { target: { value: `Renamed in ${book}` } });
      clickButton('Save');
      await called('renameChapter');
      return () => answer();
    },
    lands: (h) => expect(chapter(h, 1).title).toBe('Renamed in A'),
  },
  {
    writer: '[view] modals/duplicate-review-modal.tsx link (cast)',
    start: async (h, book) => {
      const answer = pend('linkPriorCharacter');
      mount(
        h,
        createElement(DuplicateReviewModal, {
          open: true,
          pair: duplicatePair(book),
          onClose: () => {},
        }),
      );
      clickButton(/Same character — link them/i);
      await called('linkPriorCharacter');
      return () =>
        answer({
          matchedFrom: { bookId: 'other', characterId: 'p-other', bookTitle: 'Other', confidence: 1 },
          voiceId: 'v-linked',
        });
    },
    lands: (h) => expect(row(h, 'wren').voiceId).toBe('v-linked'),
  },
  {
    writer: '[view] modals/duplicate-review-modal.tsx different on purpose (cast)',
    start: async (h, book) => {
      const answer = pend('notLinkedTo');
      mount(
        h,
        createElement(DuplicateReviewModal, {
          open: true,
          pair: duplicatePair(book),
          onClose: () => {},
        }),
      );
      clickButton('Different on purpose');
      await called('notLinkedTo');
      return () => answer();
    },
    lands: (h) =>
      expect(row(h, 'wren').notLinkedTo).toContainEqual({
        bookId: 'other',
        characterId: 'p-other',
      }),
  },
];

const drawerElement = (book: string) =>
  createElement(ProfileDrawer, {
    character: bookCast(book)[1],
    voice: undefined,
    bookId: book,
    onClose: () => {},
    onSave: () => {},
    onLock: () => {},
    onShowMatchDetail: () => {},
    onRegenerateCharacter: () => {},
  } as unknown as ComponentProps<typeof ProfileDrawer>);
const drawer = (h: H, book: string) => mount(h, drawerElement(book));

const loadMyVoices = async (h: H) => {
  apiFn('listVoiceLibrary').mockImplementation(() =>
    Promise.resolve({ voices: [libraryEntry('lib2')] }),
  );
  await act(async () => {
    await h.store.dispatch(fetchVoiceLibrary());
  });
};

const drawerRows: Row[] = [
  {
    writer: '[view] modals/profile-drawer.tsx assign from My voices (cast)',
    start: async (h, book) => {
      await loadMyVoices(h);
      const answer = pend('assignLibraryVoice');
      drawer(h, book);
      click('profile-drawer-my-voice-lib2');
      await called('assignLibraryVoice');
      return () => answer({ updated: 1, written: ['qwen'] });
    },
    lands: (h) => expect(row(h, 'wren').overrideTtsVoices?.qwen?.libraryUuid).toBe('lib2'),
  },
  {
    writer: '[view] modals/profile-drawer.tsx remove a My voices voice (cast)',
    start: async (h, book) => {
      await loadMyVoices(h);
      const answer = pend('unassignLibraryVoice');
      drawer(h, book);
      click('profile-drawer-remove-my-voice');
      await called('unassignLibraryVoice');
      return () => answer({ cleared: ['qwen'] });
    },
    lands: (h) => expect(row(h, 'wren').overrideTtsVoices?.qwen?.libraryUuid).toBeUndefined(),
  },
  {
    writer: '[view] modals/profile-drawer.tsx regenerate persona (cast)',
    start: async (h, book) => {
      const answer = pend('generateVoiceStyle');
      drawer(h, book);
      click('qwen-regenerate-persona');
      await called('generateVoiceStyle');
      return () => answer({ voiceStyle: 'a new persona' });
    },
    lands: (h) => expect(row(h, 'wren').voiceStyle).toBe('a new persona'),
  },
  {
    writer: '[view] modals/profile-drawer.tsx persona seeded from the designed voice (cast)',
    start: async (h, book) => {
      const answer = pend('fetchDesignedPersona');
      /* Cloned, never rebuilt, for the renders below: a rebuilt element would give
         the drawer a new `character` object. */
      const element = drawerElement(book);
      const view = mount(h, element);
      await called('fetchDesignedPersona');
      /* The effect mirrors the persona into redux only when React runs its
         textarea updater at once, which needs a drawer with no update left over
         from an earlier render. Two renders from above, just before the answer,
         give it that whatever moved in between. */
      return async () => {
        for (let i = 0; i < 2; i += 1) view.rerender(tree(h, cloneElement(element)));
        await answer({ instruct: 'a seeded persona' });
      };
    },
    lands: (h) => expect(row(h, 'wren').voiceStyle).toBe('a seeded persona'),
  },
  {
    writer: '[view] modals/profile-drawer.tsx approve a compared voice (cast)',
    start: async (h, book) => {
      const answer = pend('promoteQwenVoice');
      const at = { bookId: book, characterId: 'wren', lastTickAt: 1 };
      h.store.dispatch(
        castDesignActions.beginSingle({ ...at, name: 'Wren', mode: 'redesign' }),
      );
      h.store.dispatch(
        castDesignActions.previewReady({
          ...at,
          previewVoiceId: 'qwen-v-wren-preview',
          previewUrl: '/preview.mp3',
          persona: 'an approved persona',
        }),
      );
      drawer(h, book);
      click('voice-compare-approve');
      await called('promoteQwenVoice');
      return () => answer({ voiceId: 'qwen-v-wren', url: '/a.mp3', voiceUuid: 'u' });
    },
    lands: (h) => {
      expect(row(h, 'wren').voiceStyle).toBe('an approved persona');
      expect(row(h, 'wren').overrideTtsVoices?.qwen?.variants?.angry).toBeUndefined();
    },
  },
];

/* The layout's own writers: the real Layout, mounted on the origin book. */
const layout = (h: H, path: string) =>
  mount(
    h,
    createElement(
      Routes,
      null,
      createElement(Route, { path: '/books/:bookId/*', element: createElement(Layout) }),
    ),
    path,
  );

const drawerOpenOn = (book: string): Stage =>
  ({
    kind: 'ready',
    bookId: book,
    view: 'cast',
    currentChapterId: 1,
    openProfileId: 'wren',
  }) as Stage;

type DrawerProps = Required<ComponentProps<typeof RealProfileDrawer>>;

/** A row for a handler the Layout gives its profile drawer. */
const drawerHandlerRow = (
  writer: string,
  apiName: string,
  run: (props: DrawerProps, book: string) => unknown,
  response: (book: string) => unknown,
  lands: Row['lands'],
): Row => ({
  writer,
  stage: drawerOpenOn,
  start: async (h, book) => {
    const answer = pend(apiName);
    layout(h, `/books/${book}/cast`);
    const props = await propsOf<DrawerProps>('ProfileDrawer');
    void run(props, book);
    await called(apiName);
    return () => answer(response(book));
  },
  lands,
});

const newRow = (id: string) => ({ id, name: id, role: 'Supporting', color: 'peach' });

const layoutRows: Row[] = [
  drawerHandlerRow(
    '[view] components/layout.tsx merge characters (cast)',
    'mergeCharacters',
    (p) => p.onMerge('moss', 'wren'),
    (book) => ({ characters: bookCast(book).filter((c) => c.id !== 'moss') }),
    (h) => expect(h.store.getState().cast.characters.map((c) => c.id)).not.toContain('moss'),
  ),
  drawerHandlerRow(
    '[view] components/layout.tsx link a prior character (cast)',
    'linkPriorCharacter',
    (p) => p.onLinkPrior('wren', 'prior', 'p-wren'),
    () => ({
      matchedFrom: { bookId: 'prior', characterId: 'p-wren', bookTitle: 'Prior', confidence: 1 },
      voiceId: 'v-linked',
    }),
    (h) => expect(row(h, 'wren').voiceId).toBe('v-linked'),
  ),
  drawerHandlerRow(
    '[view] components/layout.tsx split an alias off (cast)',
    'unlinkAlias',
    (p) => p.onUnlinkAlias('wren', 'Birdie', { mode: 'split' }),
    () => ({ newCharacter: newRow('birdie'), impactedChapters: [] }),
    (h) => expect(row(h, 'birdie')).toBeDefined(),
  ),
  drawerHandlerRow(
    '[view] components/layout.tsx move an alias (cast)',
    'repointAlias',
    (p) => p.onUnlinkAlias('wren', 'Birdie', { mode: 'move', targetCharacterId: 'moss' }),
    () => ({ impactedChapters: [] }),
    (h) => expect(row(h, 'moss').aliases).toContain('Birdie'),
  ),
  drawerHandlerRow(
    '[view] components/layout.tsx add an alias (cast)',
    'addAlias',
    (p) => p.onAddAlias('wren', 'Linnet'),
    () => undefined,
    (h) => expect(row(h, 'wren').aliases).toContain('Linnet'),
  ),
  {
    writer: '[view] components/layout.tsx pin the picked voice model on start (cast)',
    stage: (b) => ready(b, 'generate'),
    start: async (h, book) => {
      /* Wren is the one Qwen member, so one tier write is the whole answer. */
      const answer = pend('setCastTier');
      h.store.dispatch(uiActions.openStartGenPrompt());
      layout(h, `/books/${book}/generate`);
      const props = await propsOf<{ onConfirm: (tier: string) => unknown }>('StartGenerationModal');
      act(() => void props.onConfirm('qwen3-tts-1.7b'));
      await called('setCastTier');
      return () => answer();
    },
    lands: (h) => expect(row(h, 'wren').ttsModelKey).toBe('qwen3-tts-1.7b'),
  },
  {
    writer: '[view] components/layout.tsx Confirm voice match (cast)',
    stage: (b) => ({ kind: 'confirm', bookId: b, openProfileId: null }) as Stage,
    start: async (h, book) => {
      const answer = pend('matchVoices');
      layout(h, `/books/${book}/confirm`);
      await called('matchVoices');
      return () =>
        answer({
          matches: [
            {
              characterId: 'wren',
              candidates: [
                {
                  voiceId: 'v-matched',
                  fromBookId: 'prior',
                  fromCharacterId: 'p-wren',
                  fromBookTitle: 'Prior',
                  score: 1,
                  factors: [],
                },
              ],
            },
          ],
        });
    },
    lands: (h) => expect(row(h, 'wren').voiceId).toBe('v-matched'),
    dropsOffStage: 'leaving Confirm cancels the match, and the next visit asks again (#3840)',
  },
  {
    writer: '[view] components/layout.tsx library-triggered emotion run (manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      type Opts = { onAnnotation: (e: unknown) => void };
      const opened = capture<Opts>('detectEmotions', (args) => args[1] as Opts, never());
      apiFn('putBookState').mockImplementation(() => Promise.resolve());
      const library = (status: string) =>
        libraryActions.hydrate({
          authors: [
            {
              name: 'Author',
              series: [
                {
                  name: 'Standalones',
                  books: [
                    {
                      bookId: book,
                      title: `Book ${book}`,
                      author: 'Author',
                      series: 'Standalones',
                      seriesPosition: null,
                      isStandalone: true,
                      status,
                      manuscriptId: manuscriptIdOf(book),
                      chapterCount: 3,
                      completedChapters: 0,
                      characterCount: 3,
                      voiceCount: 0,
                      lastWorkedOn: 'now',
                      coverGradient: ['#000', '#fff'],
                      tags: [],
                    },
                  ],
                },
              ],
            },
          ],
        } as never);
      h.store.dispatch(library('analysing'));
      layout(h, `/books/${book}/manuscript`);
      await flush();
      /* The next read is the run's own: the book turning complete starts it. */
      apiFn('getBookState').mockImplementationOnce(() =>
        Promise.resolve({ state: { bookId: book, manuscriptId: manuscriptIdOf(book) } }),
      );
      act(() => void h.store.dispatch(library('cast_pending')));
      const { onAnnotation } = await opened();
      return () =>
        frame(() =>
          onAnnotation({ chapterId: 1, annotations: [{ sentenceId: 2, emotion: 'angry' }] }),
        );
    },
    lands: (h) => expect(h.store.getState().manuscript.sentences[1].emotion).toBe('angry'),
    dropsOffStage: 'annotations apply only while the stage names the book too (#3435)',
  },
];

const castView = (h: H, book: string) =>
  mount(
    h,
    createElement(CastView, {
      characters: bookCast(book),
      setCharacters: () => {},
      library: [],
      sentences: bookSentences(book),
      title: `Book ${book}`,
      onOpenProfile: () => {},
      onShowMatchDetail: () => {},
      driftEvents: [],
      onShowDrift: () => {},
      onContinueToManuscript: () => {},
    } as unknown as ComponentProps<typeof CastView>),
  );

/* Pick the comparison target on the orphaned id's row, then press its action. */
const orphanAction = async (target: string, action: string) => {
  fireEvent.change(await screen.findByLabelText('Compare "ghost" against'), {
    target: { value: target },
  });
  clickButton(action);
};

const castViewRows: Row[] = [
  {
    writer: '[view] views/cast.tsx reject an orphan match (cast)',
    start: async (h, book) => {
      const answer = pend('rejectOrphanMatch');
      castView(h, book);
      await orphanAction('moss', 'Not the same character');
      await called('rejectOrphanMatch');
      return () => answer({ resolution: 'unresolved' });
    },
    lands: (h) => {
      expect(h.store.getState().cast.orphanedCharacterFallbacks?.ghost.rejectedAgainst).toContain(
        'moss',
      );
      expect(row(h, 'moss').notLinkedTo).toContainEqual({ bookId: 'A', characterId: 'ghost' });
    },
  },
  {
    writer: '[view] views/cast.tsx undo an orphan rejection (cast)',
    start: async (h, book) => {
      const answer = pend('undoRejectOrphanMatch');
      castView(h, book);
      fireEvent.click(await screen.findByRole('button', { name: /Undo "not .*" for "ghost"/ }));
      await called('undoRejectOrphanMatch');
      return () => answer({ resolution: 'unresolved', removedFrom: ['ghost'] });
    },
    lands: (h) =>
      expect(
        h.store.getState().cast.orphanedCharacterFallbacks?.ghost.rejectedAgainst,
      ).toBeUndefined(),
  },
  {
    writer: '[view] views/cast.tsx link an orphaned id (cast)',
    start: async (h, book) => {
      const answer = pend('linkOrphanMatch');
      castView(h, book);
      await orphanAction('moss', 'Link to this character');
      await called('linkOrphanMatch');
      return () => answer({ resolution: 'alias', resolvedCharacterId: 'moss' });
    },
    lands: (h) =>
      expect(h.store.getState().cast.orphanedCharacterFallbacks?.ghost.resolvedCharacterId).toBe(
        'moss',
      ),
  },
  {
    writer: '[view] views/cast.tsx pin the higher tier (cast)',
    start: async (h, book) => {
      const answer = pend('setCastTier');
      castView(h, book);
      click('pin-higher-quality');
      clickButton('Pin to all cast');
      await called('setCastTier');
      return () => answer();
    },
    lands: (h) => expect(row(h, 'wren').ttsModelKey).toBe('qwen3-tts-1.7b'),
  },
  {
    writer: '[view] views/cast.tsx reset the tier (cast)',
    arrange: (h, book) =>
      void h.store.dispatch(
        castActions.hydrateCharacters(
          bookCast(book).map((c) =>
            c.id === 'wren' ? { ...c, ttsModelKey: 'qwen3-tts-1.7b' as const } : c,
          ),
        ),
      ),
    start: async (h, book) => {
      const answer = pend('setCastTier');
      castView(h, book);
      click('reset-tier');
      clickButton('Reset to 0.6B');
      await called('setCastTier');
      return () => answer();
    },
    lands: (h) => expect(row(h, 'wren').ttsModelKey).toBeNull(),
  },
  {
    writer: '[view] views/cast.tsx accept a merge suggestion (cast)',
    start: async (h, book) => {
      apiFn('listMergeSuggestions').mockImplementationOnce(() =>
        Promise.resolve([{ sourceId: 'moss', targetId: 'wren', reason: 'same person' }]),
      );
      const answer = pend('acceptMergeSuggestion');
      castView(h, book);
      const card = await screen.findByTestId('merge-suggestion-card');
      fireEvent.click(card.querySelector('button')!);
      await called('acceptMergeSuggestion');
      return () => answer({ characters: bookCast(book).filter((c) => c.id !== 'moss') });
    },
    lands: (h) => expect(h.store.getState().cast.characters.map((c) => c.id)).not.toContain('moss'),
  },
];

/* Two same-base-voice rows of `book`, as the Voices view lists them. */
const libraryVoice = (bookId: string, id: string, character: string) =>
  ({
    ...(voiceOf(bookId, id) as object),
    character,
    ttsVoice: { provider: 'gemini', name: 'Charon', description: '' },
  }) as never;

const voicesView = (h: H, voices: never[]) =>
  mount(h, createElement(VoicesView, { library: voices }));

const selectCard = (label: string) =>
  fireEvent.click(
    screen
      .getByText(label)
      .closest('div.group')!
      .querySelector('[aria-label="Select voice for compare"]')!,
  );

const mergeable = (book: string) => [
  libraryVoice(book, 'v-wren', 'Wren'),
  libraryVoice(book, 'v-moss', 'Moss'),
];

const voicesRows: Row[] = [
  {
    writer: '[view] views/voices.tsx merge two cast members (cast)',
    stage: (b) => ready(b, 'voices'),
    start: async (h, book) => {
      const answer = pend('mergeCharacters');
      voicesView(h, mergeable(book));
      selectCard('Wren');
      selectCard('Moss');
      fireEvent.click(screen.getByRole('button', { name: /^Merge into/ }));
      await called('mergeCharacters');
      return () => answer({ characters: bookCast(book).filter((c) => c.id !== 'moss') });
    },
    lands: (h) => expect(h.store.getState().cast.characters.map((c) => c.id)).not.toContain('moss'),
  },
  {
    writer: '[view] views/voices.tsx save one side of a comparison (cast)',
    stage: (b) => ready(b, 'voices'),
    start: async (h, book) => {
      const answer = pend('seriesPatchCharacter');
      voicesView(h, mergeable(book));
      selectCard('Wren');
      selectCard('Moss');
      clickButton('Compare');
      const modal = await propsOf<{ onSaveSide: (next: unknown) => unknown }>('CompareCastModal');
      void modal.onSaveSide({ ...bookCast(book)[1], gender: 'female' });
      await called('seriesPatchCharacter');
      return () =>
        answer({ updated: [{ bookId: book, bookTitle: book, characterId: 'wren' }], failed: [] });
    },
    lands: (h) => expect(row(h, 'wren').gender).toBe('female'),
  },
  {
    writer: '[view] views/voices.tsx unmark an ignored duplicate pair (cast)',
    stage: (b) => ready(b, 'voices'),
    start: async (h, book) => {
      const answer = pend('removeNotLinkedTo');
      const inSeries = (bookId: string) =>
        ({
          bookId,
          title: `Book ${bookId}`,
          author: 'Author',
          series: 'Saga',
          seriesPosition: 1,
          isStandalone: false,
        }) as never;
      h.store.dispatch(libraryActions.addBook(inSeries(book)));
      h.store.dispatch(libraryActions.addBook(inSeries('prior')));
      voicesView(h, [
        libraryVoice(book, 'v-wren', 'Wren'),
        libraryVoice('prior', 'p-wren', 'Old Wren'),
      ]);
      click('toggle-ignored-duplicates');
      click(`unmark-${book}:wren|prior:p-wren`);
      await called('removeNotLinkedTo');
      return () => answer();
    },
    lands: (h) => expect(row(h, 'wren').notLinkedTo).toEqual([]),
  },
  {
    /* The modal calls this once its own server write has answered, with the
       handler the view had when the user pressed the button. */
    writer: '[view] views/voices.tsx mirror a resolved duplicate (cast)',
    stage: (b) => ready(b, 'voices'),
    start: async (h, book) => {
      voicesView(h, mergeable(book));
      const modal = await propsOf<{ onResolved: (r: unknown) => void }>('DuplicateReviewModal');
      return () =>
        frame(() =>
          modal.onResolved({
            kind: 'link',
            winnerBookId: book,
            winnerCharacterId: 'wren',
            addedAlias: 'Linnet',
          }),
        );
    },
    lands: (h) => expect(row(h, 'wren').aliases).toContain('Linnet'),
  },
];

/* The route, analysis, generation, upload, review, rebaseline and restructure
   writers. */
const routed = (h: H, path: string, pattern: string, element: ReactElement, context?: object) =>
  mount(
    h,
    createElement(
      Routes,
      null,
      createElement(
        Route,
        { element: createElement(Outlet, { context }) },
        createElement(Route, { path: pattern, element }),
      ),
    ),
    path,
  );

const analysing = (b: string): Stage => ({
  kind: 'analysing',
  bookId: b,
  manuscriptId: manuscriptIdOf(b),
});

const confirmStage = (b: string): Stage => ({ kind: 'confirm', bookId: b, openProfileId: null });

/* The analysing view starts a run only once the analyzer reports ready. */
const analyzerReady = () => {
  apiFn('getOllamaHealth').mockImplementation(() =>
    Promise.resolve({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: ['qwen3.5:4b'],
      modelResident: true,
    }),
  );
};

const analysingView = (h: H, book: string) =>
  mount(
    h,
    createElement(AnalysingView, {
      manuscriptId: manuscriptIdOf(book),
      bookId: book,
      title: `Book ${book}`,
      wordCount: 100,
      onComplete: () => {},
    }),
  );

const liveWren = (book: string) => [{ ...bookCast(book)[1], name: 'Live Wren' }];

/* A run's answer for `book`: a new cast member and a new line. */
const analysisPayload = (book: string) => ({
  bookId: book,
  manuscriptId: manuscriptIdOf(book),
  title: `Book ${book}`,
  phaseTimings: [],
  characters: [...bookCast(book), newRow('newcomer')],
  chapters: bookChapters(book).map((c) => ({ ...c, characters: {} })),
  sentences: [{ id: 50, chapterId: 2, characterId: 'newcomer', text: `Late line of ${book}.` }],
  libraryMatches: [],
});

const merged = (h: H) => {
  expect(h.store.getState().cast.characters.map((c) => c.id)).toContain('newcomer');
  expect(h.store.getState().manuscript.sentences.map((s) => s.id)).toContain(50);
};

type LiveOpts = { onCastUpdate: (u: unknown) => void };

function HostedGeneration({ book }: { book: string }) {
  const ttsLifecycle = useTtsLifecycle();
  const context = {
    showInfo: () => {},
    showError: () => {},
    pushToast: () => {},
    ttsLifecycle,
    priorRoster: [],
    openFixCharacterAudio: () => {},
  };
  const view = createElement(GenerationView, {
    chapters: bookChapters(book),
    characters: bookCast(book),
    paused: true,
    title: `Book ${book}`,
    bookId: book,
    modelKey: 'coqui-xtts-v2',
    onRegenerate: () => {},
    onRegenerateBook: () => {},
    onRegenerateCharacterInChapter: () => {},
    onPreview: () => {},
  } as unknown as ComponentProps<typeof GenerationView>);
  return createElement(
    Routes,
    null,
    createElement(
      Route,
      { element: createElement(Outlet, { context }) },
      createElement(Route, { path: '*', element: view }),
    ),
  );
}

const generation = (h: H, book: string) => {
  apiFn('getBookBusy').mockImplementation(() => Promise.resolve([]));
  return mount(h, createElement(HostedGeneration, { book }));
};

/* Wren alone speaks (and routes to Qwen) with no persona yet, so a rebaseline
   proposes that one row. */
const speakingQwenCast = (book: string) =>
  bookCast(book).map((c) =>
    c.id === 'wren' ? { ...c, lines: 40, overrideTtsVoices: undefined } : c,
  );

const rebaseline = async (h: H, book: string) => {
  apiFn('getSeriesCast').mockImplementation(() => Promise.resolve({ characters: [] }));
  h.store.dispatch(uiActions.openRebaselineModal({ bookId: book }));
  mount(h, createElement(RebaselineModalContainer, { bookId: book }));
  await vi.waitFor(() => expect(screen.getByTestId('rebaseline-propose')).toBeEnabled());
  click('rebaseline-propose');
};

const manuscriptRoute = (h: H, book: string, priorRoster: object[]) =>
  routed(h, `/books/${book}/manuscript?chapter=1`, '/books/:bookId/:view', createElement(ReadyRoute), {
    priorRoster,
    pushToast: () => {},
  });

const routeRows: Row[] = [
  {
    writer: '[view] views/analysing.tsx main run live roster (cast)',
    stage: analysing,
    start: async (h, book) => {
      analyzerReady();
      const opened = capture<LiveOpts>('analyseManuscript', (args) => args[1] as LiveOpts, never());
      analysingView(h, book);
      fireEvent.click(await screen.findByRole('button', { name: /start analysis/i }));
      const { onCastUpdate } = await opened();
      return () => frame(() => onCastUpdate({ characters: liveWren(book) }));
    },
    lands: (h) => expect(row(h, 'wren').name).toBe('Live Wren'),
  },
  {
    writer: '[view] views/analysing.tsx chapter Retry live roster (cast)',
    stage: analysing,
    start: async (h, book) => {
      analyzerReady();
      apiFn('getBookState').mockImplementationOnce(() =>
        Promise.resolve({
          state: {
            bookId: book,
            manuscriptId: manuscriptIdOf(book),
            castConfirmed: false,
            chapters: bookChapters(book),
          },
          analysis: { failedChapterIds: [1] },
        }),
      );
      const opened = capture<LiveOpts>(
        'runAnalysisForChapters',
        (args) => args[2] as LiveOpts,
        never(),
      );
      analysingView(h, book);
      fireEvent.click(await screen.findByRole('button', { name: /retry chapter/i }));
      const { onCastUpdate } = await opened();
      return () => frame(() => onCastUpdate({ characters: liveWren(book) }));
    },
    lands: (h) => expect(row(h, 'wren').name).toBe('Live Wren'),
  },
  {
    writer: '[view] routes/index.tsx AnalysingRoute onComplete (cast + chapters + manuscript)',
    stage: analysing,
    start: async (h, book) => {
      routed(
        h,
        `/books/${book}/analysing`,
        '/books/:bookId/analysing',
        createElement(AnalysingRoute),
      );
      const view = await propsOf<{ onComplete: (p: unknown) => void }>('AnalysingView');
      return () => frame(() => view.onComplete(analysisPayload(book)));
    },
    lands: merged,
  },
  {
    writer: '[view] views/generation.tsx Include a chapter (cast + chapters + manuscript)',
    stage: (b) => ready(b, 'generate'),
    start: async (h, book) => {
      const include = pend('setChapterExcluded');
      const run = pend('runAnalysisForChapters');
      generation(h, book);
      fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
      await called('setChapterExcluded');
      return async () => {
        await include({});
        await called('runAnalysisForChapters');
        await run(analysisPayload(book));
      };
    },
    lands: (h) => {
      expect(chapter(h, 2).excluded).not.toBe(true);
      merged(h);
    },
  },
  {
    writer: '[view] views/generation.tsx Re-analyse a chapter (cast + chapters + manuscript)',
    stage: (b) => ready(b, 'generate'),
    start: async (h, book) => {
      const run = pend('runAnalysisForChapters');
      generation(h, book);
      click('chapter-row-1-reanalyse');
      fireEvent.click(await screen.findByRole('button', { name: /Re-analyse chapter/i }));
      await called('runAnalysisForChapters');
      return () => run(analysisPayload(book));
    },
    lands: merged,
  },
  {
    writer: '[view] views/generation.tsx Exclude a chapter (chapters)',
    stage: (b) => ready(b, 'generate'),
    start: async (h, book) => {
      const exclude = pend('setChapterExcluded');
      generation(h, book);
      fireEvent.click(
        screen.getAllByTitle('Skip this chapter — no audio will be generated for it.')[0],
      );
      await called('setChapterExcluded');
      return () => exclude({});
    },
    lands: (h) => expect(chapter(h, 1).excluded).toBe(true),
  },
  {
    writer: '[view] routes/index.tsx Confirm entry re-read (cast + chapters)',
    stage: confirmStage,
    start: async (h, book) => {
      const answer = pend('getBookState');
      routed(h, `/books/${book}/confirm`, '/books/:bookId/confirm', createElement(ConfirmRoute));
      await called('getBookState');
      return () => answer({ state: { chapters: [] }, cast: { characters: liveWren(book) } });
    },
    lands: (h) => expect(row(h, 'wren').name).toBe('Live Wren'),
  },
  {
    writer: '[view] routes/index.tsx Confirm library override (cast)',
    stage: confirmStage,
    start: async (h, book) => {
      const answer = pend('overrideLibraryCast');
      routed(h, `/books/${book}/confirm`, '/books/:bookId/confirm', createElement(ConfirmRoute));
      const view = await propsOf<{ onOverrideLibrary: (a: object) => unknown }>('ConfirmCastView');
      void view.onOverrideLibrary({
        sourceCharacterId: 'wren',
        targetBookId: 'prior',
        targetCharacterId: 'p-wren',
      });
      await called('overrideLibraryCast');
      return () => answer({ source: liveWren(book)[0] });
    },
    lands: (h) => expect(row(h, 'wren').name).toBe('Live Wren'),
  },
  {
    writer:
      '[view] routes/index.tsx add from the series roster, then reassign the line (cast + manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('addFromSeriesRoster');
      manuscriptRoute(h, book, [
        { id: 'r1', name: 'Councillor Linnet', bookId: 'prior', bookTitle: 'Prior' },
      ]);
      fireEvent.click((await screen.findAllByRole('button', { name: /^Reassign/ }))[0]);
      fireEvent.click(await screen.findByText('Councillor Linnet'));
      await called('addFromSeriesRoster');
      return () => answer({ character: newRow('linnet') });
    },
    lands: (h) => {
      expect(row(h, 'linnet')).toBeDefined();
      expect(h.store.getState().manuscript.sentences.map((s) => s.characterId)).toContain('linnet');
    },
  },
  {
    writer: '[view] views/manuscript.tsx create a character (cast)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('createCharacter');
      manuscriptRoute(h, book, []);
      fireEvent.click((await screen.findAllByRole('button', { name: /Add character/ }))[0]);
      fireEvent.change(screen.getByTestId('create-character-form').querySelector('input')!, {
        target: { value: 'Linnet' },
      });
      click('create-character-submit');
      await called('createCharacter');
      return () => answer({ character: newRow('linnet') });
    },
    lands: (h) => expect(row(h, 'linnet')).toBeDefined(),
  },
  {
    writer: '[view] routes/index.tsx library deleteBook clears the book (cast + manuscript)',
    start: async (h, book) => {
      const answer = pend('deleteBook');
      routed(h, '/books', '/books', createElement(BooksRoute), {
        showInfo: () => {},
        showError: () => {},
        pushToast: () => {},
      });
      const view = await propsOf<{ onDeleteBook: (b: object) => unknown }>('BookLibraryView');
      void view.onDeleteBook({ bookId: book, title: `Book ${book}` });
      await called('deleteBook');
      return () => answer();
    },
    lands: (h) => {
      expect(h.store.getState().cast.characters).toEqual([]);
      expect(h.store.getState().manuscript.manuscriptId).toBeNull();
    },
  },
  ...(['reparseBook', 'replaceManuscript'] as const).map(
    (method): Row => ({
      writer: `[view] routes/index.tsx library ${method} clears the book (cast + manuscript)`,
      start: async (h, book) => {
        const answer = pend(method);
        routed(h, '/books', '/books', createElement(BooksRoute), {
          showInfo: () => {},
          showError: () => {},
          pushToast: () => {},
        });
        const view = await propsOf<{
          onReparseBook: (b: object) => unknown;
          onReplaceManuscript: (b: object, file: File) => unknown;
        }>('BookLibraryView');
        const target = { bookId: book, title: `Book ${book}`, manuscriptId: manuscriptIdOf(book) };
        void (method === 'reparseBook'
          ? view.onReparseBook(target)
          : view.onReplaceManuscript(target, new File(['x'], 'x.md')));
        await called(method);
        return () => answer({ chapterCount: 1, chapterTitles: [] });
      },
      lands: (h) => {
        expect(h.store.getState().cast.characters).toEqual([]);
        expect(h.store.getState().manuscript.manuscriptId).toBeNull();
      },
    }),
  ),
  {
    writer: '[view] views/upload.tsx re-upload preview (manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('importManuscript');
      h.store.dispatch(uiActions.startReupload({ bookId: book }));
      const { container } = mount(h, createElement(UploadView));
      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: { files: [new File(['New text.'], 'again.md')] },
      });
      await called('importManuscript');
      return () =>
        answer({
          tempId: 't',
          candidate: { sourceText: 'New text.', wordCount: 2, title: 'New', format: 'markdown' },
        });
    },
    lands: (h) => expect(h.store.getState().manuscript.pendingReupload?.bookId).toBe('A'),
  },
  {
    writer: '[view] components/script-review-diff.tsx create, then reassign (cast + manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('createCharacter');
      h.store.dispatch(
        scriptReviewActions.setReview({
          bookId: book,
          ops: [
            {
              id: 2,
              chapterId: 1,
              op: 'reattribute',
              proposed: { name: 'Linnet' },
              rationale: 'off-roster speaker',
            },
          ],
          unappliable: [],
          versionByChapter: { 1: 1 },
        } as unknown as Parameters<typeof scriptReviewActions.setReview>[0]),
      );
      h.store.dispatch(scriptReviewActions.toggleClass({ bookId: book, op: 'reattribute' }));
      mount(h, createElement(ScriptReviewDiff, { bookId: book }));
      click('apply-button');
      click('create-character-submit');
      await called('createCharacter');
      return () => answer({ character: newRow('linnet') });
    },
    lands: (h) => {
      expect(row(h, 'linnet')).toBeDefined();
      expect(h.store.getState().manuscript.sentences[1].characterId).toBe('linnet');
    },
    dropsOffStage: 'the run stops once the stage names another book (#3435)',
  },
  {
    writer: '[view] modals/rebaseline-modal.tsx generated persona (cast)',
    stage: (b) => ready(b, 'voices'),
    arrange: (h, book) =>
      void h.store.dispatch(castActions.hydrateCharacters(speakingQwenCast(book))),
    start: async (h, book) => {
      const answer = pend('generateVoiceStyle');
      await rebaseline(h, book);
      await called('generateVoiceStyle');
      expect(apiFn('generateVoiceStyle').mock.calls[0][1]).toBe('wren');
      return () => answer({ voiceStyle: 'a rebaselined persona' });
    },
    lands: (h) => expect(row(h, 'wren').voiceStyle).toBe('a rebaselined persona'),
  },
  {
    writer: '[view] modals/rebaseline-modal.tsx approved voice mirrored (cast)',
    stage: (b) => ready(b, 'voices'),
    arrange: (h, book) =>
      void h.store.dispatch(castActions.hydrateCharacters(speakingQwenCast(book))),
    start: async (h, book) => {
      apiFn('generateVoiceStyle').mockImplementation(() =>
        Promise.resolve({ voiceStyle: 'persona' }),
      );
      apiFn('designQwenVoice').mockImplementation(() =>
        Promise.resolve({ voiceId: 'qwen-proposed', previewUrl: '/p.mp3' }),
      );
      const answer = pend('setVoiceOverrideLinked');
      await rebaseline(h, book);
      await vi.waitFor(() => expect(screen.getByTestId('rebaseline-approve')).toBeEnabled());
      click('rebaseline-approve');
      await called('setVoiceOverrideLinked');
      return () => answer({ canonicalVoiceId: 'v-canon', updated: [], failed: [] });
    },
    lands: (h) => expect(row(h, 'wren').voiceId).toBe('v-canon'),
  },
  {
    writer: '[view] views/restructure.tsx adopt the new chapter list (chapters)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('refreshChapterTitles');
      apiFn('getBookState').mockImplementation(() => Promise.resolve(null));
      apiFn('getLibrary').mockImplementation(() => Promise.resolve(null));
      mount(h, createElement(RestructureView, { bookId: book }));
      const panel = await propsOf<{ onRefreshTitles: () => Promise<void> }>(
        'RestructureChaptersPanel',
      );
      act(() => void panel.onRefreshTitles());
      await called('refreshChapterTitles');
      return async () => {
        await answer({
          chapters: bookChapters(book).map((c) => ({ ...c, title: `Restructured ${c.id}` })),
          sentenceRemap: [],
        });
        /* The library refresh is the handler's last step. */
        await called('getLibrary');
        await flush();
      };
    },
    lands: (h) => {
      expect(chapter(h, 1).title).toBe('Restructured 1');
      /* An empty remap names no line, so applying it empties the slice. */
      expect(h.store.getState().manuscript.sentences).toEqual([]);
    },
    dropsOffStage: 'it adopts only while the stage names the book, else marks it for a full read',
  },
  {
    writer: '[view] views/restructure.tsx take the re-read after a mid-request hydrate (manuscript)',
    stage: (b) => ready(b, 'manuscript'),
    start: async (h, book) => {
      const answer = pend('refreshChapterTitles');
      apiFn('getBookState').mockImplementation(() =>
        Promise.resolve({
          state: {
            bookId: book,
            manuscriptId: manuscriptIdOf(book),
            title: `Re-read ${book}`,
            chapters: bookChapters(book),
          },
          manuscriptEdits: {
            sentences: [{ id: 9, chapterId: 1, characterId: 'wren', text: `Re-read ${book}.` }],
          },
        }),
      );
      apiFn('getLibrary').mockImplementation(() => Promise.resolve(null));
      mount(h, createElement(RestructureView, { bookId: book }));
      const panel = await propsOf<{ onRefreshTitles: () => Promise<void> }>(
        'RestructureChaptersPanel',
      );
      act(() => void panel.onRefreshTitles());
      await called('refreshChapterTitles');
      /* The book's own read lands mid-request, so the remap no longer applies. */
      act(() => h.holdBook(book));
      return async () => {
        await answer({ chapters: bookChapters(book), sentenceRemap: [] });
        await called('getLibrary');
        await flush();
      };
    },
    lands: (h) =>
      expect(h.store.getState().manuscript.sentences.map((s) => s.id)).toEqual([9]),
    dropsOffStage: 'it adopts only while the stage names the book, else marks it for a full read',
  },
];

/* ── The suite ──────────────────────────────────────────────────────────── */

const rows: Row[] = [
  ...thunkRows,
  ...smallViewRows,
  ...drawerRows,
  ...layoutRows,
  ...castViewRows,
  ...voicesRows,
  ...routeRows,
];

beforeEach(() => {
  for (const fn of apiMock.fns.values()) {
    fn.mockReset();
    fn.mockImplementation(never);
  }
  seen.props.clear();
  /* The Layout's boot splash holds every routed view until this answers. */
  const pass = { status: 'pass', cause: 'pass', message: '', remediation: '' };
  apiFn('getSetupReadiness').mockImplementation(() =>
    Promise.resolve({
      ready: true,
      completedAt: '2026-06-12T00:00:00.000Z',
      blockers: { sidecar: pass, ffmpeg: pass, tts: pass, analyzer: pass },
      info: { gpu: 'none' },
    }),
  );
  /* The queue's own requests go through fetch, not the api seam. */
  vi.stubGlobal('fetch', vi.fn(never));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* One block per row, titled in full (`describe.each` cuts a long title short).
   Mounting the whole Layout or a full view takes seconds under a loaded run. */
function writerSuite(r: Row) {
  const stageOf = r.stage ?? ((b: string) => ready(b));
  const open = () => {
    const h = createStageSliceHarness({ middleware: r.middleware?.() });
    appStore.current = h.store;
    return h;
  };
  const show = (h: H, book: string) => {
    act(() => {
      h.holdBook(book);
      r.arrange?.(h, book);
      h.moveStage(stageOf(book));
    });
  };
  /* Start the writer for `from`, then leave the slices holding A with the stage
     on `stageBook` before the late answer. */
  async function lateResult(from: 'A' | 'B', stageBook: 'A' | 'B', manuscriptNames?: 'B') {
    const h = open();
    show(h, from);
    const late = await r.start(h, from);
    if (from !== 'A') show(h, 'A');
    act(() => {
      h.moveStage(stageOf(stageBook));
      if (manuscriptNames) h.nameInManuscript(manuscriptNames);
    });
    await flush();
    const before = h.snapshot();
    await late();
    return { h, before };
  }

  it('(i) slices hold A, stage names B: a late result for B lands nowhere', async () => {
    const { h, before } = await lateResult('B', 'B');
    h.expectUnchanged(before);
  });

  if (r.dropsOffStage) {
    it(`(ii) slices hold A, stage names B: a late result for A is dropped — ${r.dropsOffStage}`, async () => {
      const { h, before } = await lateResult('A', 'B');
      h.expectUnchanged(before);
    });
    it('(ii control) slices hold A, stage names A: the late result for A lands', async () => {
      const { h, before } = await lateResult('A', 'A');
      r.lands(h);
      expect(h.snapshot()).not.toEqual(before);
    });
  } else {
    it('(ii) slices hold A, stage names B: a late result for A lands', async () => {
      const { h, before } = await lateResult('A', 'B');
      r.lands(h);
      expect(h.snapshot()).not.toEqual(before);
    });
  }

  it('(iii) slices hold A, stage names A: a late result for B lands nowhere', async () => {
    const { h, before } = await lateResult('B', 'A');
    h.expectUnchanged(before);
  });

  it('(iv) the pair names A, the manuscript slice B: a late result for B lands nowhere', async () => {
    const { h, before } = await lateResult('B', 'B', 'B');
    h.expectUnchanged(before);
  });

  it('(v) the pair names A, the manuscript slice B: a late result for A lands', async () => {
    const { h, before } = await lateResult('A', 'A', 'B');
    r.lands(h);
    expect(h.snapshot()).not.toEqual(before);
  });
}

for (const r of rows) describe(r.writer, { timeout: 20_000 }, () => writerSuite(r));
