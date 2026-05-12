import type { Stage, View } from './types';

/* Hash-based router — bidirectional sync between URL and ui.stage.

   URL grammar (unchanged from the prototype):
     #/                                  → { kind: 'books' }
     #/new                               → { kind: 'upload' }
     #/books/:bookId/analysing           → { kind: 'analysing', bookId }
     #/books/:bookId/confirm             → { kind: 'confirm',   bookId }
     #/books/:bookId/:view?chapter=&profile=
                                         → { kind: 'ready', bookId, view,
                                             currentChapterId, openProfileId } */

const VALID_VIEWS: View[] = ['manuscript', 'cast', 'library', 'generate', 'listen', 'log'];

export function parseHash(hash?: string): Stage {
  const raw = (hash ?? window.location.hash ?? '').replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const segs = path.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');

  if (segs.length === 0) return { kind: 'books' };
  if (segs.length === 1 && segs[0] === 'new') return { kind: 'upload' };

  if (segs[0] === 'books' && segs[1]) {
    const bookId = segs[1];
    const action = segs[2] || 'cast';
    if (action === 'analysing') return { kind: 'analysing', bookId };
    if (action === 'confirm')   return { kind: 'confirm',   bookId };
    const view: View = (VALID_VIEWS as string[]).includes(action) ? (action as View) : 'cast';
    const chapterStr = params.get('chapter');
    const chapter = chapterStr != null && !Number.isNaN(parseInt(chapterStr, 10))
      ? parseInt(chapterStr, 10) : 3;
    const profile = params.get('profile') || null;
    return { kind: 'ready', bookId, view, currentChapterId: chapter, openProfileId: profile };
  }
  return { kind: 'books' };
}

export function stageToHash(stage: Stage | null | undefined): string {
  if (!stage) return '#/';
  switch (stage.kind) {
    case 'books':     return '#/';
    case 'upload':    return '#/new';
    case 'analysing': return stage.bookId ? `#/books/${stage.bookId}/analysing` : '#/new';
    case 'confirm':   return `#/books/${stage.bookId}/confirm`;
    case 'ready': {
      const q = new URLSearchParams();
      if (stage.currentChapterId != null && stage.currentChapterId !== 3) q.set('chapter', String(stage.currentChapterId));
      if (stage.openProfileId) q.set('profile', stage.openProfileId);
      const qs = q.toString();
      return `#/books/${stage.bookId}/${stage.view}${qs ? '?' + qs : ''}`;
    }
    default: return '#/';
  }
}

export function stageEqual(a: Stage | null | undefined, b: Stage | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if ((a as { bookId?: string }).bookId !== (b as { bookId?: string }).bookId) return false;
  if (a.kind === 'ready' && b.kind === 'ready') {
    return a.view === b.view
        && a.currentChapterId === b.currentChapterId
        && a.openProfileId === b.openProfileId;
  }
  return true;
}

/* Two-way binding installer. The store module passes in its own
   `hydrate(stage)` callback so router stays decoupled from the store
   action shape. */
export interface RouterStore {
  getStage(): Stage;
  hydrate(stage: Stage): void;
  subscribe(cb: () => void): () => void;
}

export function installRouter(store: RouterStore): () => void {
  const initial = parseHash();
  if (initial.kind !== 'books') {
    store.hydrate(initial);
  } else if (!window.location.hash) {
    window.history.replaceState(null, '', '#/');
  }

  let lastWritten = window.location.hash;
  const unsub = store.subscribe(() => {
    const next = stageToHash(store.getStage());
    if (next !== lastWritten) {
      lastWritten = next;
      window.history.replaceState(null, '', next);
    }
  });

  const onHashChange = () => {
    const parsed = parseHash();
    if (!stageEqual(parsed, store.getStage())) store.hydrate(parsed);
  };
  window.addEventListener('hashchange', onHashChange);

  return () => {
    unsub();
    window.removeEventListener('hashchange', onHashChange);
  };
}
