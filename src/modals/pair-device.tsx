/* Pair-a-device modal (plan 188, app-2 web half).

   The Castwright Companion app pairs to this server over LAN HTTPS by reading a
   QR that carries `{ url, token, caFingerprint }` — the server URL, the srv-20
   LAN access token, and the mkcert root CA's SHA-256 (so the app fetches
   /cert/root.crt, verifies the fingerprint, and pins it WITHOUT an OS cert
   install). The server already exposes all three at GET /api/export/lan
   (api.getExportLanUrls → ExportLanInfo); this modal just renders them as a
   scannable QR, plus the raw values for manual entry as a fallback.

   Pairing is only possible in LAN HTTPS mode with a configured token + a
   resolvable CA — otherwise we explain how to enable it rather than drawing a
   QR the app can't act on. */

import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

import { api } from '../lib/api';
import { IconClose, IconCopy, IconQrCode, IconShield, IconCheck } from '../lib/icons';
import type { ExportLanInfo } from '../lib/types';

interface PairDeviceModalProps {
  open: boolean;
  onClose: () => void;
}

/** The exact payload the companion app parses (PairedServer.fromQrPayload). */
interface PairingPayload {
  url: string;
  token: string;
  caFingerprint: string;
}

/** Reduce the raw LAN info to a complete pairing payload, or null when pairing
    isn't possible yet (not HTTPS, no token, no CA, or no reachable URL). */
export function toPairingPayload(info: ExportLanInfo | null): PairingPayload | null {
  if (!info) return null;
  const url = info.urls[0];
  if (info.protocol !== 'https' || !url || !info.token || !info.caFingerprint) return null;
  return { url, token: info.token, caFingerprint: info.caFingerprint };
}

export function PairDeviceModal({ open, onClose }: PairDeviceModalProps) {
  const [info, setInfo] = useState<ExportLanInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  /* Fetch the LAN pairing info each time the modal opens (the token / CA can
     change between server runs, so don't cache across opens). */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setQrDataUrl(null);
    api
      .getExportLanUrls()
      .then((r) => {
        if (cancelled) return;
        setInfo(r);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /* Memoised so the QR effect below only re-runs when the values actually
     change (not on every render). */
  const payload = useMemo(() => toPairingPayload(info), [info]);

  /* Render the QR from the JSON payload once we have a complete one. */
  useEffect(() => {
    if (!payload) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(JSON.stringify(payload), { margin: 1, scale: 6 })
      .then((d) => {
        if (!cancelled) setQrDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

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
          className="bg-white rounded-3xl shadow-float w-full max-w-md pointer-events-auto fade-in overflow-hidden max-h-[90vh] overflow-y-auto"
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

            {status === 'ready' && !payload && (
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

            {status === 'ready' && payload && (
              <div className="space-y-4">
                <p>
                  In the app, tap <strong>Pair a device → Scan QR</strong> and point the camera here.
                  Your phone must be on the same Wi‑Fi.
                </p>
                <div className="grid place-items-center">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="Pairing QR code"
                      data-testid="pair-qr-image"
                      className="w-56 h-56 rounded-xl border border-ink/10"
                    />
                  ) : (
                    <div className="w-56 h-56 rounded-xl border border-ink/10 grid place-items-center text-ink/40">
                      Generating…
                    </div>
                  )}
                </div>

                <details className="rounded-xl border border-ink/10 bg-ink/[0.02]">
                  <summary className="px-4 py-3 cursor-pointer text-ink/70 font-medium select-none">
                    Or enter these manually
                  </summary>
                  <div className="px-4 pb-4 space-y-3">
                    <CopyRow label="Server URL" value={payload.url} />
                    <CopyRow label="Access token" value={payload.token} mono />
                    <CopyRow label="CA fingerprint (SHA-256)" value={payload.caFingerprint} mono />
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
