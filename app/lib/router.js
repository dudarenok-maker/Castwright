/* Hash-based router — bidirectional sync between URL and ui.stage.

   URL grammar:
     #/                                  → { kind: 'books' }
     #/new                               → { kind: 'upload' }
     #/books/:bookId/analysing           → { kind: 'analysing', bookId }
     #/books/:bookId/confirm             → { kind: 'confirm',   bookId }
     #/books/:bookId/:view?chapter=&profile=
                                         → { kind: 'ready', bookId, view,
                                             currentChapterId, openProfileId }

   Hash routing (not pushState) because the prototype loads from the filesystem
   and we want refresh / share-this-link behaviour without server help. */

const VALID_VIEWS = ['manuscript', 'cast', 'library', 'generate', 'listen', 'log'];

function parseHash(hash) {
  const raw = (hash || window.location.hash || '').replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const segs = path.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');

  if (segs.length === 0)                                return { kind: 'books' };
  if (segs.length === 1 && segs[0] === 'new')           return { kind: 'upload' };

  if (segs[0] === 'books' && segs[1]) {
    const bookId = segs[1];
    const action = segs[2] || 'cast';
    if (action === 'analysing') return { kind: 'analysing', bookId };
    if (action === 'confirm')   return { kind: 'confirm',   bookId };
    const view = VALID_VIEWS.includes(action) ? action : 'cast';
    const chapterStr = params.get('chapter');
    const chapter = chapterStr != null && !Number.isNaN(parseInt(chapterStr, 10))
      ? parseInt(chapterStr, 10) : 3;
    const profile = params.get('profile') || null;
    return { kind: 'ready', bookId, view, currentChapterId: chapter, openProfileId: profile };
  }
  return { kind: 'books' };
}

function stageToHash(stage) {
  if (!stage) return '#/';
  switch (stage.kind) {
    case 'books':     return '#/';
    case 'upload':    return '#/new';
    case 'analysing': return stage.bookId ? `#/books/${stage.bookId}/analysing` : '#/new';
    case 'confirm':   return `#/books/${stage.bookId}/confirm`;
    case 'ready': {
      const q = new URLSearchParams();
      if (stage.currentChapterId != null && stage.currentChapterId !== 3) q.set('chapter', String(stage.currentChapterId));
      if (stage.openProfileId)                                            q.set('profile', stage.openProfileId);
      const qs = q.toString();
      return `#/books/${stage.bookId}/${stage.view}${qs ? '?' + qs : ''}`;
    }
    default: return '#/';
  }
}

function stageEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.bookId !== b.bookId) return false;
  if (a.kind === 'ready') {
    return a.view === b.view
        && a.currentChapterId === b.currentChapterId
        && a.openProfileId === b.openProfileId;
  }
  return true;
}

/* Install the two-way binding once, after store is created. */
function installRouter(store) {
  // 1. Hydrate from current URL on boot (if it specifies anything other than books)
  const initial = parseHash();
  if (initial.kind !== 'books') store.dispatch(uiActions.hydrateFromUrl(initial));
  else {
    // Normalize empty hash to '#/' so back-button has somewhere to return to
    if (!window.location.hash) window.history.replaceState(null, '', '#/');
  }

  // 2. Store → URL: write hash when stage changes (replaceState avoids spamming history)
  let lastWritten = window.location.hash;
  store.subscribe(() => {
    const next = stageToHash(store.getState().ui.stage);
    if (next !== lastWritten) {
      lastWritten = next;
      // Use replaceState so rapid view-switching doesn't pollute history;
      // pushState only on stage.kind change so back/forward feels right.
      window.history.replaceState(null, '', next);
    }
  });

  // 3. URL → Store: respond to back/forward
  window.addEventListener('hashchange', () => {
    const parsed = parseHash();
    const current = store.getState().ui.stage;
    if (!stageEqual(parsed, current)) {
      store.dispatch(uiActions.hydrateFromUrl(parsed));
    }
  });
}

window.parseHash     = parseHash;
window.stageToHash   = stageToHash;
window.installRouter = installRouter;
