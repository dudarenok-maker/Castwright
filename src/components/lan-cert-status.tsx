/* ops-28 — shared cert detect+repair UI. Consumed by the first-run wizard
   step (step-lan-cert.tsx) and Admin's LanAccessCard. Detection is
   presence+expiry (health); IP-coverage is an informational hint only. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { LanCertStatus as CertStatus } from '../lib/api';
import { WikiLink } from './wiki-link';
import { ADMIN_WIKI } from '../lib/wiki-links';

const HEALTH_COPY: Record<CertStatus['health'], string> = {
  healthy: 'LAN certificate is set up.',
  missing: 'Phone/tablet pairing is currently off — no HTTPS certificate is set up.',
  expired: 'The LAN certificate has expired — phone/tablet pairing is off until it’s renewed.',
};

/** True when the warning banner should show: LAN was requested but the cert is
    in a deterministically-broken state. Coverage hints never trigger this. */
export function isCertWarning(s: CertStatus): boolean {
  return s.requested && (s.health === 'missing' || s.health === 'expired');
}

export function LanCertStatus({ variant }: { variant: 'wizard' | 'admin' }) {
  const [status, setStatus] = useState<CertStatus | null>(null);
  const [regen, setRegen] = useState<
    { k: 'idle' } | { k: 'loading' } | { k: 'error'; message: string }
  >({ k: 'idle' });

  const refresh = useCallback(() => {
    api.getLanCertStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh]);

  const regenerate = async () => {
    setRegen({ k: 'loading' });
    try {
      await api.regenerateLanCert();
      setRegen({ k: 'idle' });
      refresh();
    } catch (e) {
      setRegen({ k: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!status) {
    return (
      <div className="text-sm text-ink/55" data-testid="lan-cert-loading">
        Checking LAN certificate…
      </div>
    );
  }

  const restartNeeded = status.health === 'healthy' && !status.active;
  const buttonLabel =
    regen.k === 'loading'
      ? 'Working…'
      : status.health === 'healthy'
        ? 'Regenerate certificate'
        : 'Set up LAN certificate';

  return (
    <div className="text-sm" data-testid={`lan-cert-status-${variant}`} data-health={status.health}>
      <p className={status.health === 'healthy' ? 'text-ink/70' : 'text-amber-700'}>
        {HEALTH_COPY[status.health]}
        {status.health !== 'healthy' && (
          <> You can set it up now, or skip if you only use Castwright on this computer.</>
        )}
      </p>

      {restartNeeded && (
        <p className="mt-2 text-amber-700" data-testid="lan-cert-restart-note">
          Certificate ready — restart Castwright once to serve over HTTPS.
        </p>
      )}

      {status.uncoveredIps.length > 0 && (
        <p className="mt-2 text-ink/60" data-testid="lan-cert-coverage-hint">
          This certificate doesn’t list {status.uncoveredIps.join(', ')} — regenerate to include
          your current network.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={regenerate}
          disabled={regen.k === 'loading'}
          className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs text-ink/70 hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
        >
          {buttonLabel}
        </button>
        <WikiLink page={ADMIN_WIKI.lanTroubleshooting} label="Troubleshooting" className="text-xs" />
      </div>

      {regen.k === 'error' && (
        <p className="mt-2 text-rose-700" data-testid="lan-cert-error">{regen.message}</p>
      )}

      <details className="mt-4 text-xs text-ink/55">
        <summary className="cursor-pointer text-ink/70">Phone shows "Not secure"?</summary>
        <p className="mt-2 leading-relaxed">
          The phone must trust this computer's local certificate once. Run{' '}
          <code className="px-1 py-0.5 rounded bg-ink/5">npm run install:cert-mobile</code> for a
          QR + per-OS steps (served at{' '}
          <code className="px-1 py-0.5 rounded bg-ink/5">/cert/root.crt</code>). The companion app
          trusts it automatically.
        </p>
      </details>
    </div>
  );
}
