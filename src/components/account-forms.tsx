/* Shared form primitives for the Account view and the Model Manager view.
   Extracted from src/views/account.tsx (fs-23) so both surfaces render the
   same cards/rows/key-field without duplicating the markup. Pure
   presentational helpers — no slice access, no behavior of their own beyond
   the GeminiKeyField's local draft state. */

import { useEffect, useState } from 'react';
import { PrimaryButton } from './primitives';
import { MODEL_OPTIONS } from '../lib/models';

/* Human label for an analyzer model id, for the split-status line. `null`
   (no per-phase override) reads as "server default" since the actual model
   then depends on the server's resolution. */
export function analyzerModelLabel(id: string | null | undefined): string {
  if (!id) return 'server default';
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function FormCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {hint && <p className="mt-1 text-xs text-ink/55">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function FieldRow({
  label,
  sublabel,
  children,
}: {
  label: string;
  sublabel?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {sublabel && <span className="block text-xs text-ink/55 mt-0.5">{sublabel}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

export function ReadOnlyRow({
  label,
  sublabel,
  value,
  children,
}: {
  label: string;
  sublabel?: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {sublabel && <span className="block text-xs text-ink/55 mt-0.5">{sublabel}</span>}
      <div className="mt-2">
        {children ?? (
          <div className="w-full px-3 py-2 rounded-xl border border-ink/10 bg-ink/3 text-sm text-ink/70 font-mono break-all">
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

export function ApiKeyPill({ status }: { status: 'set' | 'unset' }) {
  if (status === 'set') {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-semibold">
        <span className="w-2 h-2 rounded-full bg-emerald-600" />
        Set
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
      <span className="w-2 h-2 rounded-full bg-amber-600" />
      Not set
    </span>
  );
}

/* Plan 49 — writable Gemini API key field. The server's apiKeyStatus is a
   redacted boolean: 'set' iff a key is reachable (either env var or the
   UI-saved value in server/user-settings.json). The plaintext NEVER comes
   back from GET — that's by design. So the field renders as an empty input
   with placeholder when 'unset', and as a masked-eight-dot placeholder
   when 'set' (the user can type to overwrite, or hit Clear to wipe). */
export function GeminiKeyField({
  status,
  onSave,
}: {
  status: 'set' | 'unset';
  onSave: (key: string | null) => Promise<unknown> | unknown;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const handleSave = async () => {
    if (draft.trim().length === 0) return;
    setBusy('save');
    try {
      await onSave(draft.trim());
      setDraft('');
      setFlash('Saved.');
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    try {
      await onSave(null);
      setDraft('');
      setFlash('Cleared.');
    } finally {
      setBusy(null);
    }
  };

  const placeholder =
    status === 'set' ? '••••••••  (key on file — type to overwrite)' : 'Paste your Gemini API key';

  return (
    <div className="block">
      <span className="block text-sm font-medium text-ink">Gemini API key</span>
      <span className="block text-xs text-ink/55 mt-0.5">
        Stored plaintext in server/user-settings.json (gitignored). The env-var GEMINI_API_KEY still
        wins when present (CI / power-user override).
      </span>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label="Gemini API key"
          className="flex-1 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
        />
        <ApiKeyPill status={status} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <PrimaryButton
          variant={draft.trim().length > 0 ? 'dark' : 'ghost'}
          onClick={handleSave}
          icon={false}
        >
          {busy === 'save' ? 'Saving…' : 'Save key'}
        </PrimaryButton>
        {status === 'set' && (
          <button
            type="button"
            onClick={handleClear}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink/70 hover:bg-ink/4 disabled:opacity-50"
          >
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </button>
        )}
        {flash && <span className="text-xs text-magenta font-semibold">{flash}</span>}
      </div>
    </div>
  );
}
