/* Generic styled confirm/info dialog. Replaces window.confirm / window.alert
   so destructive and informational prompts share the same visual language as
   the rest of the app. Two modes:
     - confirm: a primary action button + Cancel. `variant: 'danger'` themes
       the primary button red; default themes it ink. onConfirm fires when
       the primary is clicked; onClose fires from Cancel or backdrop.
     - info: a single OK button. onConfirm/onClose collapse into the same
       handler so the caller doesn't have to wire both.

   Render the dialog when `open` is true. Conditional mount instead of CSS
   visibility so the backdrop event handler doesn't intercept clicks when
   closed. */

import type { ReactNode } from 'react';
import { IconClose } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';

export type ConfirmDialogVariant = 'default' | 'danger';

interface ConfirmDialogProps {
  open: boolean;
  /** Small chip above the title — categorises the action (e.g. "Re-parse",
      "Delete"). Mirrors the regenerate modal's eyebrow. */
  eyebrow?: string;
  title: string;
  /** Either a string (rendered as a paragraph) or arbitrary node for richer
      content (lists, formatted ranges). */
  body: ReactNode;
  /** Lead icon shown on the header chip. */
  icon?: ReactNode;
  /** When set, renders Confirm + Cancel buttons. When omitted, renders a
      single button (info mode). The info-mode button defaults to "OK" and
      just closes; pass `primaryLabel` + `onPrimaryAction` to repurpose it
      as a forward-navigation CTA (e.g. "Analyse now" after a re-parse). */
  confirmLabel?: string;
  cancelLabel?: string;
  primaryLabel?: string;
  onPrimaryAction?: () => void;
  variant?: ConfirmDialogVariant;
  onConfirm?: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  eyebrow,
  title,
  body,
  icon,
  confirmLabel,
  cancelLabel = 'Cancel',
  primaryLabel,
  onPrimaryAction,
  variant = 'default',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  if (!open) return null;
  const isInfo = !confirmLabel;
  const isDanger = variant === 'danger';
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in"/>
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            {icon && (
              <span className={`w-9 h-9 rounded-full grid place-items-center shrink-0 ${isDanger ? 'bg-red-50 text-red-700' : 'bg-peach/15 text-magenta'}`}>
                {icon}
              </span>
            )}
            <div className="flex-1 min-w-0">
              {eyebrow && <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">{eyebrow}</p>}
              <h3 className="text-base font-bold text-ink truncate">{title}</h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60" aria-label="Close">
              <IconClose className="w-4 h-4"/>
            </button>
          </div>

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed">
            {typeof body === 'string' ? <p>{body}</p> : body}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            {!isInfo && (
              <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">
                {cancelLabel}
              </button>
            )}
            {isInfo ? (
              <PrimaryButton
                variant="dark"
                onClick={() => {
                  onPrimaryAction?.();
                  onClose();
                }}
              >{primaryLabel ?? 'OK'}</PrimaryButton>
            ) : isDanger ? (
              <button
                onClick={onConfirm}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-600 text-white text-sm font-semibold hover:bg-red-700"
              >
                {confirmLabel}
              </button>
            ) : (
              <PrimaryButton variant="dark" onClick={onConfirm ?? onClose}>{confirmLabel}</PrimaryButton>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
