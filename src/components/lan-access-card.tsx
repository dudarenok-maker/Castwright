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

// #2278 — optimistic starting point (matches the pre-#2278 hardcoded value)
// for the revoke hint below: assumed until <LanCertStatus>'s onStatus
// callback reports the actually-bound port, and — if that fetch never
// succeeds — kept PERMANENTLY, not just "until" the first response. On a
// cert-less box degraded to loopback HTTP, that means this can briefly (or,
// on a failed fetch, indefinitely) compose an https:// URL against a plain
// HTTP listener. Accepted tradeoff: a dead link during that window vs. no
// address at all during the common case where LAN HTTPS is actually up.
const DEFAULT_HTTPS_PORT = 8443;

// The `https://localhost:<port>` fragment REVOKE_LOOPBACK_ONLY_HINT builds
// its sentence around, or null when LAN HTTPS isn't actually bound
// (httpsActive: false — cert-less, degraded to loopback HTTP). Naming a
// specific https address in that state would be a dead link of a new kind
// (wrong protocol, not just a stale port), so the caller falls back to
// hostname-only wording instead of composing a guaranteed-dead URL.
function loopbackHttpsOrigin(active: boolean, port: number): string | null {
  return active ? `https://localhost:${port}` : null;
}

// #2278 review round 3, Finding 1 — shown on a 403 from createDevicePairSession
// when the response wasn't genuine JSON `{error}` prose (ApiError.fromServer
// false — an HTML 403 from an interposed proxy or the :443 forwarder, say),
// so the raw synthetic "pair-session failed (403)" string never reaches the
// user. Same copy PairDeviceModal falls back to, for one consistent voice.
const PAIRING_RESTRICTED_FALLBACK = 'Pairing can only be started from the computer running Castwright.';

export function LanAccessCard() {
  const [devices, setDevices] = useState<PublicDevice[] | null>(null);
  // #2278 review Finding 1 — the SERVER's own 401 message (already
  // port-correct — requireLanToken in server/src/lan-auth.ts builds it from
  // pairingOriginHint()), not a client-composed hint: this card can't learn
  // the port from GET /api/lan/cert/status itself, because that route sits
  // behind the exact same requireLanToken guard as listDevices, so a 401 on
  // one always means a 401 on the other. null until a 401 lands.
  const [manageHint, setManageHint] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [session, setSession] = useState<
    { url: string; friendlyUrl?: string; expiresAt: number } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [selfErr, setSelfErr] = useState<string | null>(null);
  // #2278 review Finding 5 (nit) — optimistic default: assumes LAN HTTPS is
  // active until onCertStatus below says otherwise (see DEFAULT_HTTPS_PORT's
  // comment for the tradeoff this makes on a degraded/never-resolved fetch).
  const [httpsActive, setHttpsActive] = useState(true);
  // #2278 review round 3 (nit) — named boundPort, not httpsPort: the wire
  // field (server/src/routes/lan-cert.ts's LanCertStatus.boundPort) was
  // renamed for exactly this reason — it's whatever the server bound, HTTP
  // or HTTPS, not necessarily an HTTPS port. Reintroducing "https" into this
  // state's own name one layer in would undo that.
  const [boundPort, setBoundPort] = useState(DEFAULT_HTTPS_PORT);

  // #2278 review Finding 1/6 — fed by <LanCertStatus> below (rendered only
  // in the !manageHint branch) via its existing onStatus callback, instead
  // of this card issuing its own second, independent GET
  // /api/lan/cert/status: that duplicate fetch could never actually resolve
  // on the one branch (401/manageHint) it would have mattered for (see the
  // manageHint comment above), and left two copies of the same state free to
  // drift — e.g. never refreshing here after "Regenerate certificate".
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
        // #2278 review Finding 1 — render the server's own message verbatim;
        // it already names the live port (see the manageHint comment above).
        if (e instanceof ApiError && e.status === 401) setManageHint(e.message);
        else setErr(String(e));
      });
  };
  useEffect(refresh, []);

  const authorize = async () => {
    setErr(null);
    try { setSession(await api.createDevicePairSession({ label: label.trim() || 'Device' })); }
    catch (e) {
      // A 403 here means this browser reached the server from a bare LAN IP
      // (not loopback or the friendly hostname) — the server's own message
      // (pairingOriginHint(), #2278 review Finding 1) already names the
      // actual bound port, so render it as-is. But only when it's genuinely
      // from the server (round 3, Finding 1): a non-JSON 403 body (an
      // interposed proxy, the :443 forwarder) falls back to a bare
      // "pair-session failed (403)" developer string, which must not become
      // the user's entire explanation.
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
        // Same cause + server-provided copy (with the same fromServer gate)
        // as the 403 branch in authorize() above.
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
