/* Pair-a-device modal (plan 188, app-2 web half).

   The Castwright Companion app pairs to this server over LAN HTTPS by reading a
   QR that carries a compact CWP1 payload — the host:port, a short pairing code,
   and a fingerprint tag. The server issues a session at POST /api/pair/session;
   a 409 means pairing isn't available yet (not LAN HTTPS / no cert / no token),
   in which case we show instructions rather than a useless QR. */

import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import { IconClose, IconCopy, IconQrCode, IconShield, IconCheck } from '../lib/icons';
import type { PairSessionInfo } from '../lib/types';
import { PairingQr } from '../components/pairing/pairing-qr';

interface PairDeviceModalProps {
  open: boolean;
  onClose: () => void;
}

export function PairDeviceModal({ open, onClose }: PairDeviceModalProps) {
  const [info, setInfo] = useState<PairSessionInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [nonce, setNonce] = useState(0); // bump to regenerate the code

  /* Fetch a new pairing session each time the modal opens (or the user hits
     "Regenerate code"). Sessions are short-lived, so don't cache across opens. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    api
      .createPairSession()
      .then((r) => {
        if (cancelled) return;
        setInfo(r);
        setStatus('ready');
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setStatus(/\b409\b/.test(e?.message ?? '') ? 'unavailable' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, nonce]);

  if (!open) return null;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" data-testid="pair-device-backdrop" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          data-testid="pair-device-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Pair a device"
          className="bg-white rounded-3xl shadow-float w-full max-w-md pointer-events-auto fade-in overflow-hidden max-h-[90vh] overflow-y-auto scrollbar-thin"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconQrCode className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Castwright Companion
              </p>
              <h3 className="text-base font-bold text-ink truncate">Pair a device</h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] min-w-[44px] grid place-items-center"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed">
            {status === 'loading' && (
              <p data-testid="pair-device-loading" className="text-center py-8 text-ink/50">
                Loading pairing details…
              </p>
            )}

            {status === 'error' && (
              <p data-testid="pair-device-error" className="text-center py-8 text-ink/60">
                Couldn't load pairing details. Make sure the server is running and try again.
              </p>
            )}

            {status === 'unavailable' && (
              <div data-testid="pair-device-unavailable" className="space-y-3">
                <p>
                  Pairing needs the server running in <strong>LAN HTTPS mode</strong> with a local
                  certificate and an access token — that's what lets the app trust and authenticate
                  to your server over Wi‑Fi.
                </p>
                <ol className="list-decimal pl-5 space-y-1 text-ink/65">
                  <li>
                    Run <code className="bg-ink/5 px-1 rounded">npm run install:cert-mobile</code> once
                    to create the local certificate.
                  </li>
                  <li>
                    Set <code className="bg-ink/5 px-1 rounded">LAN_AUTH_TOKEN</code> in{' '}
                    <code className="bg-ink/5 px-1 rounded">server/.env</code>.
                  </li>
                  <li>
                    Start the server with{' '}
                    <code className="bg-ink/5 px-1 rounded">npm run start:lan</code>, then reopen this.
                  </li>
                </ol>
              </div>
            )}

            {status === 'ready' && info && (
              <div className="space-y-4">
                <p>
                  In the app, tap <strong>Pair a device → Scan QR</strong> and point the camera here.
                  Your phone must be on the same Wi‑Fi.
                </p>
                <PairingQr
                  payload={info.qrPayload}
                  expiresAt={info.expiresAt}
                  onRegenerate={() => setNonce((n) => n + 1)}
                />
                <details className="rounded-xl border border-ink/10 bg-ink/[0.02]">
                  <summary className="px-4 py-3 cursor-pointer text-ink/70 font-medium select-none">
                    Or enter these manually
                  </summary>
                  <div className="px-4 pb-4 space-y-3">
                    <CopyRow label="Server" value={info.hostPort} mono />
                    <CopyRow label="Pairing code" value={info.code} mono />
                    <CopyRow label="Fingerprint tag" value={info.fpTag} mono />
                  </div>
                </details>

                <p className="flex items-start gap-2 text-xs text-ink/50">
                  <IconShield className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    The app verifies the certificate fingerprint before trusting your server — no
                    manual certificate install needed on the phone.
                  </span>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** A labelled value with a copy-to-clipboard button. */
function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the value is still visible to copy by hand */
    }
  };
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-ink/45 font-semibold mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <span
          className={`flex-1 min-w-0 break-all text-xs text-ink/80 ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </span>
        <button
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="p-2 rounded-full hover:bg-ink/5 text-ink/50 shrink-0"
        >
          {copied ? <IconCheck className="w-3.5 h-3.5 text-magenta" /> : <IconCopy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
