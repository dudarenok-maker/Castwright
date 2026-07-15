/* First-run — Step: Library.
   Shows where the audiobook library lives on disk (resolved workspaceRoot) and
   lets the user change it. Changing needs a server restart; the first-run
   library is empty so there's nothing to move — UNLESS books already exist, in
   which case we warn that changing the path does not move them.
   See docs/superpowers/specs/2026-07-15-first-run-library-location-design.md. */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SetupReadiness } from '../../lib/api';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveAccountSettings } from '../../store/account-slice';

interface Props {
  readiness: SetupReadiness;
  /** Latches a wizard-session flag so the Finish step can remind about the restart. */
  onLibrarySaved?: () => void;
}

const INPUT_CLS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30';

export function StepLibrary({ readiness: _readiness, onLibrarySaved }: Props) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);
  const persisted = account.workspaceDirOverride ?? '';

  const [input, setInput] = useState<string>(persisted);
  const [hasBooks, setHasBooks] = useState<boolean>(false);

  // Re-sync the input when the slice rehydrates (mirrors step-defaults).
  useEffect(() => {
    setInput(account.workspaceDirOverride ?? '');
  }, [account.hydrated, account.workspaceDirOverride]);

  // Non-empty-library signal — reuse the existing library listing, no new endpoint.
  // getLibrary() returns { authors: [{ series: [{ books: [] }] }] } — books are
  // nested three deep, so flatten (house idiom, src/lib/api.sample.test.ts:15).
  useEffect(() => {
    let alive = true;
    api
      .getLibrary()
      .then((lib) => {
        const count = lib.authors.flatMap((a) => a.series.flatMap((s) => s.books)).length;
        if (alive) setHasBooks(count > 0);
      })
      .catch(() => alive && setHasBooks(false)); // safe default: treat as empty
    return () => {
      alive = false;
    };
  }, []);

  const dirty = input !== persisted;

  const onSave = () => {
    dispatch(saveAccountSettings({ workspaceDirOverride: input.trim() === '' ? null : input.trim() }));
    onLibrarySaved?.();
  };

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-ink">Library</h2>

      <p className="text-sm text-ink/60">
        This is where Castwright keeps your audiobooks on disk. New installs use a
        folder in your home directory so it's easy to find and survives app updates.
      </p>

      {/* Read-only resolved path (NOT the input's value). */}
      <div className="rounded-2xl border border-ink/10 bg-canvas px-4 py-3">
        <p className="text-xs text-ink/55">Your audiobooks will be saved to</p>
        <p className="text-sm font-medium text-ink break-all">{account.workspaceRoot || '(unknown)'}</p>
        {account.workspaceSource === 'override' && (
          <p className="mt-1 text-xs text-ink/50">Using a saved location from your Castwright settings.</p>
        )}
      </div>

      <div>
        <label htmlFor="setup-library-path" className="block text-sm font-medium text-ink mb-1">
          Change library folder
        </label>
        <input
          id="setup-library-path"
          aria-label="Library folder"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="(leave empty to use the default)"
          className={INPUT_CLS}
        />
        {dirty && (
          <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
            Restart the server to apply this change.
          </p>
        )}
        <p className="mt-2 text-xs text-ink/55">
          {hasBooks
            ? 'You already have audiobooks here. Changing this does not move existing files — you would need to copy them across yourself.'
            : 'Your library is empty, so there is nothing to move. On a Pinokio install, Stop and Start to apply.'}
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty}
            className="min-h-[44px] fine-pointer:min-h-0 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-medium hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </section>
  );
}
