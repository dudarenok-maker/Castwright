import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { isLoopbackHost } from '../lib/lan-recovery-hint';
import type { PublicDevice } from '../lib/types';
import { PairingQr } from './pairing/pairing-qr';
import { PrimaryButton } from './primitives';
import { WikiLink } from './wiki-link';
import { ADMIN_WIKI } from '../lib/wiki-links';
import { LanCertStatus } from './lan-cert-status';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '—');

export function LanAccessCard() {
  const [devices, setDevices] = useState<PublicDevice[] | null>(null);
  const [manageHint, setManageHint] = useState(false); // true on 401 (viewing from a phone)
  const [label, setLabel] = useState('');
  const [session, setSession] = useState<
    { url: string; friendlyUrl?: string; expiresAt: number } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [selfErr, setSelfErr] = useState<string | null>(null);

  const refresh = () => {
    api.listDevices()
      .then((r) => setDevices(r.devices))
      .catch((e) => { if (e instanceof ApiError && e.status === 401) setManageHint(true); else setErr(String(e)); });
  };
  useEffect(refresh, []);

  const authorize = async () => {
    setErr(null);
    try { setSession(await api.createDevicePairSession({ label: label.trim() || 'Device' })); }
    catch (e) {
      // A 403 here means this browser reached the server from a bare LAN IP (not
      // loopback or the friendly hostname) — actionable guidance beats the raw code.
      if (e instanceof ApiError && e.status === 403)
        setErr('Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.');
      else setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const authorizeThisBrowser = async () => {
    setSelfErr(null);
    try {
      const s = await api.createDevicePairSession({ label: 'This computer' });
      if (!s.friendlyUrl) {
        setSelfErr("castwright.local isn't reachable right now — use the QR flow above, or check the app is running in production LAN mode.");
        return;
      }
      window.location.assign(`${s.friendlyUrl}&self=1`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSelfErr('LAN mode is not active on this server, so there is nothing to authorize against.');
      } else if (e instanceof ApiError && e.status === 403) {
        // Same cause + copy as the 403 branch in authorize() above — reached
        // from a bare LAN IP (not loopback or the friendly hostname).
        setSelfErr('Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.');
      } else {
        setSelfErr(e instanceof Error ? e.message : String(e));
      }
    }
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

  return (
    <section className="bg-white rounded-3xl border border-ink/10 shadow-card p-6">
      <div className="flex items-center gap-2">
        <h2 className="font-serif text-xl font-bold text-ink">LAN access</h2>
        <WikiLink page={ADMIN_WIKI.lanAccess} label="Wiki" className="text-xs" />
      </div>
      {manageHint ? (
        <p className="mt-2 text-sm text-ink/60">
          Start pairing from https://localhost:8443 or https://castwright.local on the computer running Castwright.
        </p>
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
          {isLoopbackHost() && (
            <div className="mt-3">
              <PrimaryButton variant="dark" onClick={authorizeThisBrowser} icon={false}>
                Authorize this browser
              </PrimaryButton>
              <p className="mt-1 text-xs text-ink/55">
                Re-links this computer to https://castwright.local. No QR needed.
              </p>
              {selfErr && <p className="mt-2 text-sm text-rose-700">{selfErr}</p>}
            </div>
          )}
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
          <div className="mt-5">
            <LanCertStatus variant="admin" />
          </div>
        </>
      )}
    </section>
  );
}
