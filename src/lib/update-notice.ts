/* fe-27 — in-app update notifier shared state.

   Holds the dismissed-update version (equality-based: a notice is silenced only
   for the exact latestVersion the user dismissed) and the single visibility
   predicate read by both the banner and the version-pill dot. Backed by
   localStorage, exposed via useSyncExternalStore so dismissing the banner clears
   the pill dot in the same tick. */

import { useSyncExternalStore } from 'react';
import type { AppInfo } from './types';

const KEY = 'castwright:dismissedUpdateVersion';

function readFromStorage(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  } catch {
    return null; // private mode / sandboxed webview → fail safe (notice shows)
  }
}

let current: string | null = readFromStorage();
const listeners = new Set<() => void>();

export function getDismissedVersion(): string | null {
  return current;
}

export function dismissUpdate(version: string): void {
  current = version;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, version);
  } catch {
    /* swallow — in-memory dismissal still works this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDismissedVersion(): string | null {
  return useSyncExternalStore(subscribe, getDismissedVersion, getDismissedVersion);
}

/** Single source of truth for "should the update notifier paint?". */
export function shouldShowUpdateNotice(info: AppInfo | null, dismissed: string | null): boolean {
  return (
    info != null &&
    info.updateAvailable === true &&
    !info.showWhatsNew &&
    info.latestVersion != null &&
    info.latestVersion !== dismissed
  );
}

/** Test seam — clear in-memory state + subscribers. */
export function __resetForTests(): void {
  current = readFromStorage();
  listeners.clear();
}
