import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { PublicDevice } from '../lib/types';
import { PairingQr } from './pairing/pairing-qr';
import { PrimaryButton } from './primitives';
import { WikiLink } from './wiki-link';
import { ADMIN_WIKI } from '../lib/wiki-links';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '—');

export function LanAccessCard() {
  const [devices, setDevices] = useState<PublicDevice[] | null>(null);
  const [manageHint, setManageHint] = useState(false); // true on 401 (viewing from a phone)
  const [label, setLabel] = useState('');
  const [session, setSession] = useState<
    { url: string; friendlyUrl?: string; expiresAt: number } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [certState, setCertState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'success'; hosts: string[] } | { status: 'error'; message: string }
  >({ status: 'idle' });

  const refresh = () => {
    api.listDevices()
      .then((r) => setDevices(r.devices))
      .catch((e) => { if (e instanceof ApiError && e.status === 401) setManageHint(true); else setErr(String(e)); });
  };
  useEffect(refresh, []);

  const authorize = async () => {
    setErr(null);
    try { setSession(await api.createDevicePairSession({ label: label.trim() || 'Device' })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const revoke = async (id: string) => {
    setErr(null);
    try {
      await api.revokeDevice(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    refresh(); // re-read: a revoked device drops out of the list below
  };
  const regenerateCert = async () => {
    setCertState({ status: 'loading' });
    try {
      const { hosts } = await api.regenerateLanCert();
      setCertState({ status: 'success', hosts });
    } catch (e) {
      setCertState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="bg-white rounded-3xl border border-ink/10 shadow-card p-6">
      <div className="flex items-center gap-2">
        <h2 className="font-serif text-xl font-bold text-ink">LAN access</h2>
        <WikiLink page={ADMIN_WIKI.lanAccess} label="Wiki" className="text-xs" />
      </div>
      {manageHint ? (
        <p className="mt-2 text-sm text-ink/60">Manage devices from the desktop app.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Device name"
              className="px-4 py-2.5 rounded-full border border-ink/15 bg-white text-sm text-ink min-h-[44px] fine-pointer:min-h-0"
            />
            <PrimaryButton variant="dark" onClick={authorize} icon={false}>Authorize a device</PrimaryButton>
          </div>
          {err && <p className="mt-2 text-sm text-rose-700">{err}</p>}
          {session && (
            <div className="mt-4">
              <PairingQr payload={session.url} expiresAt={session.expiresAt} onRegenerate={authorize} />
              {session.friendlyUrl && (
                <a
                  href={session.friendlyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm text-magenta hover:underline"
                >
                  Open pairing link on castwright.local
                </a>
              )}
            </div>
          )}
          <ul className="mt-6 divide-y divide-ink/8">
            {(devices ?? []).filter((d) => !d.revoked).map((d) => (
              <li key={d.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-ink">
                  <span className="font-medium">{d.label}</span>
                  <span className="text-ink/55"> · added {fmt(d.createdAt)} · last seen {fmt(d.lastSeenAt)} · expires {fmt(d.expiresAt)}</span>
                </span>
                <button
                  type="button" onClick={() => revoke(d.id)}
                  className="px-3 py-1.5 rounded-lg border border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50 min-h-[44px] fine-pointer:min-h-0"
                >Revoke</button>
              </li>
            ))}
          </ul>
          <div className="mt-5 text-xs text-ink/55">
            <button
              type="button"
              onClick={regenerateCert}
              disabled={certState.status === 'loading'}
              className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs text-ink/70 hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
            >
              {certState.status === 'loading' ? 'Regenerating…' : 'Regenerate certificate'}
            </button>
            <p className="mt-2 leading-relaxed">
              Run this if a phone or tablet shows "Not secure" — it refreshes this
              computer's local certificate (covering every LAN address it's
              currently reachable on) without restarting the app.
            </p>
            {certState.status === 'success' && (
              <p className="mt-2 text-emerald-700">Now covers: {certState.hosts.join(', ')}</p>
            )}
            {certState.status === 'error' && (
              <p className="mt-2 text-rose-700">{certState.message}</p>
            )}
          </div>
          <details className="mt-5 text-xs text-ink/55">
            <summary className="cursor-pointer text-ink/70">Phone shows "Not secure" / certificate warning?</summary>
            <p className="mt-2 leading-relaxed">
              The phone's browser must trust this computer's local certificate (one-time). Run{' '}
              <code className="px-1 py-0.5 rounded bg-ink/5">npm run install:cert-mobile</code> on this
              computer — it prints a QR + per-OS steps to download and install the root certificate
              (served at <code className="px-1 py-0.5 rounded bg-ink/5">/cert/root.crt</code>). On
              Android: Settings → Security → Install a certificate → CA certificate; on iOS: install
              the profile, then General → About → Certificate Trust Settings → enable it. The companion
              app trusts it automatically (cert pinning) — only browsers need this step.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
