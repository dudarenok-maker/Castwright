/* Unlink destination dialog (#1676 part b).

   Pure controlled dialog: given an alias name currently folded into a source
   character, ask where the alias's lines should go — split into its own new
   character, or move to an existing roster character. No store/api access;
   the caller (task 5/6) owns fetching impacted chapters and dispatching the
   unlink. Mirrors the confirm-alertdialog styling in reassign-lines.tsx. */

import { useState } from 'react';
import type { Character } from '../lib/types';

export type UnlinkDestination = { mode: 'split' } | { mode: 'move'; targetCharacterId: string };

interface Props {
  aliasName: string;
  sourceName: string;
  targets: Character[]; // roster minus source (cast \ this)
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (destination: UnlinkDestination) => void;
}

export function UnlinkAliasDialog({ aliasName, sourceName, targets, busy, error, onCancel, onConfirm }: Props) {
  const [mode, setMode] = useState<'split' | 'move'>('split');
  const [targetId, setTargetId] = useState('');
  const canConfirm = mode === 'split' || (mode === 'move' && targetId !== '');

  function confirm() {
    if (!canConfirm) return;
    onConfirm(mode === 'split' ? { mode: 'split' } : { mode: 'move', targetCharacterId: targetId });
  }

  return (
    <>
      <div onClick={busy ? undefined : onCancel} className="fixed inset-0 bg-ink/40 z-[60]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Unlink alias"
        className="fixed left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 w-[min(440px,calc(100vw-32px))] bg-white rounded-2xl shadow-drawer p-6"
      >
        <h4 className="text-base font-bold text-ink mb-3">
          Unlink «{aliasName}» from {sourceName} — where should this name go?
        </h4>
        <div className="flex flex-col gap-2 mb-3">
          <label className="flex items-center gap-2 text-sm text-ink/80 min-h-[44px] fine-pointer:min-h-0">
            <input type="radio" name="unlink-dest" checked={mode === 'split'} onChange={() => setMode('split')} />
            Make «{aliasName}» its own character
          </label>
          <label className="flex items-center gap-2 text-sm text-ink/80 min-h-[44px] fine-pointer:min-h-0">
            <input type="radio" name="unlink-dest" checked={mode === 'move'} onChange={() => setMode('move')} />
            Move «{aliasName}» to
            <select
              aria-label={`Move ${aliasName} to`}
              value={targetId}
              disabled={mode !== 'move'}
              onChange={(e) => setTargetId(e.target.value)}
              className="text-sm px-2 py-1.5 rounded-full border border-ink/15 bg-white min-h-[44px] fine-pointer:min-h-0"
            >
              <option value="">Choose…</option>
              {targets.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="text-sm text-red-600/90 mb-3">⚠ {error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-ink/6 hover:bg-ink/10 disabled:opacity-40 min-h-[44px] fine-pointer:min-h-0"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy || !canConfirm}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 disabled:opacity-40 min-h-[44px] fine-pointer:min-h-0"
          >
            Continue
          </button>
        </div>
      </div>
    </>
  );
}
