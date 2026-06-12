import type { Stage } from './types';

/* Stage ↔ hash URL serialization. URL grammar (unchanged from the
   hand-rolled router, now driven by react-router's createHashRouter):

     #/                                  → { kind: 'books' }
     #/new                               → { kind: 'upload' }
     #/voices                            → { kind: 'voices' }
     #/log                               → { kind: 'changelog' }
     #/account                           → { kind: 'account' }
     #/admin                             → { kind: 'admin' }
                                           (#/worktrees kept as an inbound alias)
     #/help?code=                        → { kind: 'help', focusCode? }
     #/books/:bookId/analysing           → { kind: 'analysing', bookId }
     #/books/:bookId/confirm?profile=    → { kind: 'confirm',   bookId,
                                             openProfileId }
     #/books/:bookId/:view?chapter=&profile=
                                         → { kind: 'ready', bookId, view,
                                             currentChapterId, openProfileId } */

export function stageToHash(stage: Stage | null | undefined): string {
  if (!stage) return '#/';
  switch (stage.kind) {
    case 'books':
      return '#/';
    case 'upload':
      return '#/new';
    case 'voices':
      return '#/voices';
    case 'changelog':
      return '#/log';
    case 'account':
      return '#/account';
    case 'admin':
      return '#/admin';
    case 'model-manager':
      return '#/models';
    case 'setup':
      return '#/setup';
    case 'about':
      return '#/about';
    case 'help': {
      const qs = stage.focusCode ? `?code=${encodeURIComponent(stage.focusCode)}` : '';
      return `#/help${qs}`;
    }
    case 'advanced':
      return '#/advanced';
    case 'release-notes':
      return '#/release-notes';
    case 'analysing':
      return stage.bookId ? `#/books/${stage.bookId}/analysing` : '#/new';
    case 'confirm': {
      const qs = stage.openProfileId ? `?profile=${stage.openProfileId}` : '';
      return `#/books/${stage.bookId}/confirm${qs}`;
    }
    case 'ready': {
      const q = new URLSearchParams();
      if (stage.currentChapterId != null && stage.currentChapterId !== 3)
        q.set('chapter', String(stage.currentChapterId));
      if (stage.openProfileId) q.set('profile', stage.openProfileId);
      const qs = q.toString();
      return `#/books/${stage.bookId}/${stage.view}${qs ? '?' + qs : ''}`;
    }
    default:
      return '#/';
  }
}

/** fe-29 — href for the Help view's troubleshooting anchor of a failure code.
    Returns null for missing/unknown codes (the anchor adds nothing there). */
export function helpHrefForFailureCode(code: string | null | undefined): string | null {
  if (!code || code === 'unknown') return null;
  return stageToHash({ kind: 'help', focusCode: code });
}

export function stageEqual(a: Stage | null | undefined, b: Stage | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if ((a as { bookId?: string }).bookId !== (b as { bookId?: string }).bookId) return false;
  if (a.kind === 'ready' && b.kind === 'ready') {
    return (
      a.view === b.view &&
      a.currentChapterId === b.currentChapterId &&
      a.openProfileId === b.openProfileId
    );
  }
  if (a.kind === 'confirm' && b.kind === 'confirm') {
    return a.openProfileId === b.openProfileId;
  }
  if (a.kind === 'help' && b.kind === 'help') {
    return a.focusCode === b.focusCode;
  }
  return true;
}
