import type { Stage } from './types';

/* Stage ↔ hash URL serialization. URL grammar (unchanged from the
   hand-rolled router, now driven by react-router's createHashRouter):

     #/                                  → { kind: 'books' }
     #/new                               → { kind: 'upload' }
     #/voices                            → { kind: 'voices' }
     #/log                               → { kind: 'changelog' }
     #/account                           → { kind: 'account' }
     #/admin                             → { kind: 'admin' }
     #/models?endpoint=&field=            → { kind: 'model-manager', endpointId?, endpointField? }
                                           (#/worktrees kept as an inbound alias)
     #/stats                             → { kind: 'stats' }
     #/help?code=                        → { kind: 'help', focusCode? }
     #/advanced?focus=&reasoningEngine=&reasoningModel=
                                         → { kind: 'advanced', focusKey?, reasoningFocus? }
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
    case 'model-manager': {
      const q = new URLSearchParams();
      if (stage.endpointId) q.set('endpoint', stage.endpointId);
      if (stage.endpointField) q.set('field', stage.endpointField);
      const qs = q.toString();
      return `#/models${qs ? '?' + qs : ''}`;
    }
    case 'setup':
      return '#/setup';
    case 'about':
      return '#/about';
    case 'stats':
      return '#/stats';
    case 'help': {
      const qs = stage.focusCode ? `?code=${encodeURIComponent(stage.focusCode)}` : '';
      return `#/help${qs}`;
    }
    /* #3084 F7 — `?focus=<knob key>` deep-links the "How to fix" list's
       Advanced Settings link. Built with URLSearchParams (like the 'ready'
       case below), NOT a template literal, so wave 5's `reasoningEngine` /
       `reasoningModel` params extend THIS builder with more `.set()` calls
       rather than needing a second concatenation scheme. */
    case 'advanced': {
      const q = new URLSearchParams();
      if (stage.focusKey) q.set('focus', stage.focusKey);
      if (stage.reasoningFocus) {
        q.set('reasoningEngine', stage.reasoningFocus.engine);
        q.set('reasoningModel', stage.reasoningFocus.model);
      }
      const s = q.toString();
      return s ? `#/advanced?${s}` : '#/advanced';
    }
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
  /* #3084 F7 — without this, navigating from one
     `#/advanced?focus=<key>` link to a DIFFERENT key while already on the
     Advanced Settings view reads as "the same stage" (the fall-through
     `return true` below), so `useHydrateStage` never re-runs and the
     scroll-and-highlight does not fire for the second link. The same holds
     for `reasoningFocus`, so this one branch compares both. */
  if (a.kind === 'advanced' && b.kind === 'advanced') {
    return (
      a.focusKey === b.focusKey &&
      a.reasoningFocus?.engine === b.reasoningFocus?.engine &&
      a.reasoningFocus?.model === b.reasoningFocus?.model
    );
  }
  if (a.kind === 'model-manager' && b.kind === 'model-manager') {
    return a.endpointId === b.endpointId && a.endpointField === b.endpointField;
  }
  return true;
}
