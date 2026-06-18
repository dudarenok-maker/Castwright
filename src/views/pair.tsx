import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { PrimaryButton } from '../components/primitives';

export function PairShell() {
  const [params] = useSearchParams();
  const code = params.get('c') ?? '';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authorize = async () => {
    setBusy(true); setError(null);
    try {
      await api.redeemBrowserPair({ code });
      // Strip the code from history, then hand off to the app; Layout mounts on
      // '/' and fetches the library (now carrying the __Host-cw_lan cookie).
      window.history.replaceState(null, '', '#/');
      navigate('/');
    } catch (e) {
      const msg = e instanceof ApiError && (e.status === 401 || e.status === 410)
        ? 'This code expired — generate a new one on the desktop.'
        : e instanceof ApiError && e.status === 429
        ? 'Too many attempts — wait a minute and try again.'
        : 'Could not authorize this browser.';
      setError(msg); setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center bg-canvas px-6 text-center">
      <div className="max-w-sm">
        <h1 className="font-serif text-2xl font-bold text-ink">Authorize this browser?</h1>
        <p className="mt-2 text-sm text-ink/60">This device will stay signed in to Castwright on your local network.</p>
        {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
        <PrimaryButton variant="dark" onClick={authorize} disabled={busy || !code} icon={false}>
          {busy ? 'Authorizing…' : 'Authorize'}
        </PrimaryButton>
      </div>
    </div>
  );
}
