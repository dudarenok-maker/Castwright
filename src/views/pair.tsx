import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { PrimaryButton } from '../components/primitives';

export function PairShell() {
  const [params] = useSearchParams();
  const codeRef = useRef(params.get('c') ?? '');   // captured once — survives the scrub
  const isSelf = params.get('self') === '1';
  const didRun = useRef(false);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState(false);

  const authorize = useCallback(async (scrubFirst = false) => {
    setBusy(true); setError(null); setCanRetry(false);
    // Self-bind only: a failed redeem must not leave a live code in history
    // where a tab restore or Back could re-fire it unattended. The QR path
    // keeps its existing scrub-on-success so a phone user can still refresh.
    if (scrubFirst) window.history.replaceState(null, '', '#/');
    try {
      await api.redeemBrowserPair({ code: codeRef.current });
      // Strip the code from history, then hand off to the app; Layout mounts on
      // '/' and fetches the library (now carrying the __Host-cw_lan cookie).
      // Already scrubbed above on the self path — don't scrub twice.
      if (!scrubFirst) window.history.replaceState(null, '', '#/');
      navigate('/');
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401 || status === 410) setError('This code expired — generate a new one on the desktop.');
      else if (status === 429) setError('Too many attempts — wait a minute and try again.');
      else if (status === 403) setError('Pairing only works from your own network.');
      else if (status === 503) { setError('Castwright could not save the authorization just now. This is usually temporary.'); setCanRetry(true); }
      else setError('Could not authorize this browser.');
      setBusy(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!isSelf || !codeRef.current || didRun.current) return;
    didRun.current = true;
    void authorize(true);
  }, [isSelf, authorize]);

  return (
    <div className="min-h-screen grid place-items-center bg-canvas px-6 text-center">
      <div className="max-w-sm">
        <h1 className="font-serif text-2xl font-bold text-ink">Authorize this browser?</h1>
        <p className="mt-2 text-sm text-ink/60">This device will stay signed in to Castwright on your local network.</p>
        {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
        <PrimaryButton variant="dark" onClick={() => authorize()} disabled={busy || !codeRef.current} icon={false}>
          {busy ? 'Authorizing…' : 'Authorize'}
        </PrimaryButton>
        {canRetry && (
          <PrimaryButton variant="dark" onClick={() => authorize(isSelf)} disabled={busy} icon={false}>
            Try again
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}
