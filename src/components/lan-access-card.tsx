import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { LanCertStatus as CertStatus } from '../lib/api';
import { isLoopbackHost } from '../lib/lan-recovery-hint';
import type { PublicDevice } from '../lib/types';
import { PairingQr } from './pairing/pairing-qr';
import { PrimaryButton } from './primitives';
import { WikiLink } from './wiki-link';
import { ADMIN_WIKI } from '../lib/wiki-links';
import { LanCertStatus } from './lan-cert-status';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '—');

// #2278 — optimistic starting point for the revoke hint below, held until
// <LanCertStatus>'s onStatus reports the actually-bound port, and kept
// permanently if that fetch never succeeds. Accepted tradeoff: a dead link
// in that window vs. no address at all in the common case where LAN HTTPS is
// up. Named for the wire field it seeds, not "https" — see boundPort below.
const DEFAULT_BOUND_PORT = 8443;

// The `https://localhost:<port>` fragment revokeLoopbackOnlyHint builds its
// sentence around, or null when there is no https address worth naming:
// LAN HTTPS isn't bound (cert-less box degraded to loopback HTTP), or the
// port isn't a real port (a cert-status body missing `boundPort` types as
// `number` but reads `undefined`, which would compose `localhost:undefined`).
// Either way the caller falls back to hostname-only wording rather than a
// guaranteed-dead URL.
function loopbackHttpsOrigin(active: boolean, port: number): string | null {
  if (!active || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `https://localhost:${port}`;
}

// Shown on a 403 from createDevicePairSession whose body wasn't genuine JSON
// `{error}` prose (ApiError.fromServer false — an HTML 403 from an interposed
// proxy or the :443 forwarder), so the synthetic "pair-session failed (403)"
// developer string never becomes the user's whole explanation. Same copy
// PairDeviceModal falls back to, for one consistent voice.
const PAIRING_RESTRICTED_FALLBACK = 'Pairing can only be started from the computer running Castwright.';

// #2278 review round 4, Finding 1 — the same gate for the 401 from
// listDevices, which renders as this card's ENTIRE content. Port-free by
// necessity: this fallback exists precisely because the server's live-port
// sentence didn't arrive, and on `main` this branch showed a hardcoded
// (often wrong) `https://localhost:8443`, so it must stay actionable without
// promising an address.
const PAIRING_UNAUTHORIZED_FALLBACK =
  'Start pairing on the computer running Castwright — open Admin → LAN access there and use “Authorize a device”.';

export function LanAccessCard() {
  const [devices, setDevices] = useState<PublicDevice[] | null>(null);
  // The SERVER's own 401 message, already port-correct (requireLanToken
  // builds it from pairingOriginHint()) — not a client-composed hint: this
  // card can't learn the port from GET /api/lan/cert/status, which sits
  // behind the same guard, so a 401 on one always means a 401 on the other.
  // null until a 401 lands.
  const [manageHint, setManageHint] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [session, setSession] = useState<
    { url: string; friendlyUrl?: string; expiresAt: number } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [selfErr, setSelfErr] = useState<string | null>(null);
  // Optimistic default (see DEFAULT_BOUND_PORT) until onCertStatus says
  // otherwise.
  const [httpsActive, setHttpsActive] = useState(true);
  // boundPort, not httpsPort: it mirrors the wire field of the same name and
  // is whatever the server bound, HTTP or HTTPS — reintroducing "https" here
  // would invite composing an https:// URL from it without checking `active`.
  const [boundPort, setBoundPort] = useState(DEFAULT_BOUND_PORT);

  // Fed by <LanCertStatus> below via its existing onStatus callback rather
  // than a second, independent GET /api/lan/cert/status from this card: that
  // duplicate fetch could never resolve on the one branch (401/manageHint) it
  // mattered for, and left two copies of one state free to drift — e.g. never
  // refreshing here after "Regenerate certificate".
  const onCertStatus = useCallback((s: CertStatus) => {
    setHttpsActive(s.active);
    setBoundPort(s.boundPort);
  }, []);

  // Revoke is loopback-only with no castwright.local fallback (#2269) —
  // narrower than Authorize, which does admit the friendly hostname. Shared by
  // the 403 catch below (a caller whose hostname reads as loopback but was
  // actually relayed through the :443 forwarder, peer 127.0.0.2) and the
  // hidden-button case (a caller whose hostname genuinely isn't loopback) —
  // one string so the two can't drift apart and disagree about the fix.
  const loopbackOrigin = loopbackHttpsOrigin(httpsActive, boundPort);
  const revokeLoopbackOnlyHint = loopbackOrigin
    ? `Revoking only works from ${loopbackOrigin} on the computer running Castwright — castwright.local and the :443 shortcut can't be used for this.`
    : "Revoking only works on the computer running Castwright — castwright.local and the :443 shortcut can't be used for this.";

  const refresh = () => {
    api.listDevices()
      .then((r) => setDevices(r.devices))
      .catch((e) => {
        // Render the server's own message verbatim — it already names the live
        // port — but only when it genuinely IS the server's (round 4,
        // Finding 1). This becomes the card's entire content, so a synthetic
        // "list devices failed (401)" must never land here.
        if (e instanceof ApiError && e.status === 401)
          setManageHint(e.fromServer ? e.message : PAIRING_UNAUTHORIZED_FALLBACK);
        else setErr(String(e));
      });
  };
  useEffect(refresh, []);

  const authorize = async () => {
    setErr(null);
    try { setSession(await api.createDevicePairSession({ label: label.trim() || 'Device' })); }
    catch (e) {
      // A 403 here means this browser reached the server from a bare LAN IP
      // (not loopback or the friendly hostname). The server's own message
      // (pairingOriginHint()) already names the actual bound port, so render
      // it as-is — but only when it genuinely parsed as the server's.
      if (e instanceof ApiError && e.status === 403)
        setErr(e.fromServer ? e.message : PAIRING_RESTRICTED_FALLBACK);
      else setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const authorizeThisBrowser = async () => {
    setSelfErr(null);
    try {
      const s = await api.createDevicePairSession({ label: 'This computer', selfBind: true });
      if (!s.friendlyUrl) {
        setSelfErr("castwright.local isn't reachable right now — use the QR flow above, or check the app is running in production LAN mode.");
        return;
      }
      window.location.assign(`${s.friendlyUrl}&self=1`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSelfErr('LAN mode is not active on this server, so there is nothing to authorize against.');
      } else if (e instanceof ApiError && e.status === 403) {
        // Same cause + copy + gate as authorize()'s 403 branch above.
        setSelfErr(e.fromServer ? e.message : PAIRING_RESTRICTED_FALLBACK);
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
      // A caller viewing this page at `localhost` but reached through the
      // :443 forwarder (peer 127.0.0.2, never loopback) still sees the
      // button (isLoopbackHost() is a hostname-only, client-side heuristic
      // that can't see the forwarder) and gets refused here.
      if (e instanceof ApiError && e.status === 403) {
        setErr(revokeLoopbackOnlyHint);
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
    refresh(); // re-read: a revoked device drops out of the list below
  };

  const visibleDevices = (devices ?? []).filter((d) => !d.revoked);

  return (
    <section className="bg-white rounded-3xl border border-ink/10 shadow-card p-6">
      <div className="flex items-center gap-2">
        <h2 className="font-serif text-xl font-bold text-ink">LAN access</h2>
        <WikiLink page={ADMIN_WIKI.lanAccess} label="Wiki" className="text-xs" />
      </div>
      {manageHint ? (
        <p className="mt-2 text-sm text-ink/60">
          {manageHint}
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
            {visibleDevices.map((d) => (
              <li key={d.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-ink">
                  <span className="font-medium">{d.label}</span>
                  <span className="text-ink/55"> · added {fmt(d.createdAt)} · last seen {fmt(d.lastSeenAt)} · expires {fmt(d.expiresAt)}</span>
                </span>
                {isLoopbackHost() && (
                  <button
                    type="button" onClick={() => revoke(d.id)}
                    className="px-3 py-1.5 rounded-lg border border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50 min-h-[44px] fine-pointer:min-h-0"
                  >Revoke</button>
                )}
                {/* Revoke removed rather than left disabled-and-failing (#2269) — the row's
                    action cell is left empty; the explanation renders once, below the list
                    (review round 2, Finding 4), not repeated on every row. */}
              </li>
            ))}
          </ul>
          {!isLoopbackHost() && visibleDevices.length > 0 && (
            // NOT recoveryHint(): that helper points at "Authorize this browser", which
            // navigates TO castwright.local and back — useless (an unbreakable loop) for
            // a caller who is already on castwright.local trying to revoke, so it needs
            // this route's own hint, not the 401/lapsed-auth one.
            <p className="mt-2 text-xs text-ink/45">{revokeLoopbackOnlyHint}</p>
          )}
          <div className="mt-5">
            <LanCertStatus variant="admin" onStatus={onCertStatus} />
          </div>
        </>
      )}
    </section>
  );
}
