/* Notifications slice — transient toast stack.
 *
 * Three error surfaces coexist after plan 48:
 *   - <ConfirmDialog> via LayoutContext.showError → modal-level errors
 *     with a CTA (e.g. "Re-open Generate view"). Unchanged by plan 48.
 *   - <StaleAudioBanner> → domain banner anchored under chapter audio.
 *     Unchanged.
 *   - <ToastStack> (this slice) → transient stream / network errors,
 *     auto-dismissed. Closes the "did anything happen?" gap when an
 *     analysis-stream / generation-stream / export error fires.
 *
 * Dedupe-by-key: when a toast is pushed with a `dedupeKey` already
 * present in state, the existing toast's `createdAt` is bumped instead
 * of stacking a duplicate. The ToastStack effect keys its auto-dismiss
 * timer on `[id, createdAt]`, so a bump resets the dismiss window. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type ToastKind = 'error' | 'warn' | 'info';

export interface VoiceNudge {
  bookId: string;
  characterIds: string[];
  modelKey: string;
  names: string[];
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  dedupeKey?: string;
  createdAt: number;
  /** fs-63 — present only on the off-roster "Design now" nudge; routes the
      toast to <VoiceNudgeToast> and exempts it from auto-dismiss. */
  nudge?: VoiceNudge;
}

export interface NotificationsState {
  toasts: Toast[];
}

const initialState: NotificationsState = { toasts: [] };

interface PushToastPayload {
  kind: ToastKind;
  message: string;
  dedupeKey?: string;
  nudge?: VoiceNudge;
}

export const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    pushToast: {
      reducer: (s, a: PayloadAction<{ id: string; createdAt: number } & PushToastPayload>) => {
        const { id, kind, message, dedupeKey, createdAt, nudge } = a.payload;
        if (dedupeKey) {
          const existing = s.toasts.find((t) => t.dedupeKey === dedupeKey);
          if (existing) {
            existing.createdAt = createdAt;
            existing.kind = kind;
            existing.message = message;
            // fs-63 — union nudge work-lists so a burst of off-roster creates
            // yields ONE nudge covering every still-unvoiced character.
            if (nudge && existing.nudge) {
              for (let i = 0; i < nudge.characterIds.length; i++) {
                const cid = nudge.characterIds[i];
                if (!existing.nudge.characterIds.includes(cid)) {
                  existing.nudge.characterIds.push(cid);
                  existing.nudge.names.push(nudge.names[i]);
                }
              }
            } else if (nudge) {
              existing.nudge = nudge;
            }
            return;
          }
        }
        s.toasts.push({ id, kind, message, dedupeKey, createdAt, nudge });
      },
      prepare: (payload: PushToastPayload) => ({
        payload: {
          ...payload,
          id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : Math.random().toString(36).slice(2),
          createdAt: Date.now(),
        },
      }),
    },
    dismissToast: (s, a: PayloadAction<string>) => {
      s.toasts = s.toasts.filter((t) => t.id !== a.payload);
    },
    dismissByKey: (s, a: PayloadAction<string>) => {
      s.toasts = s.toasts.filter((t) => t.dedupeKey !== a.payload);
    },
  },
});

export const notificationsActions = notificationsSlice.actions;
/* Defensive read: existing test stores composed before plan 48 don't
   register the notifications slice. Returning an empty list when
   absent lets the ToastStack mount without crashing those tests; in
   the real app the slice is always present (registered in
   src/store/index.ts), so the fallback is invisible in production. */
const EMPTY_TOASTS: Toast[] = [];
export const selectToasts = (s: { notifications?: NotificationsState }) =>
  s.notifications?.toasts ?? EMPTY_TOASTS;
