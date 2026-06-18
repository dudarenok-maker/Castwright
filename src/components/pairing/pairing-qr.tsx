/* Shared QR + countdown + Regenerate block.
   Payload-agnostic: works for the companion CWP1* string or any URL. */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface PairingQrProps {
  payload: string;
  expiresAt: number;
  onRegenerate: () => void;
}

export function PairingQr({ payload, expiresAt, onRegenerate }: PairingQrProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    QRCode.toDataURL(payload, { margin: 4, scale: 8, errorCorrectionLevel: 'M' })
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

  const remainingMs = Math.max(0, expiresAt - now);
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);

  return (
    <div className="space-y-4">
      <div className="grid place-items-center">
        <div className="bg-white p-3 rounded-2xl border border-ink/10">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Pairing QR code"
              data-testid="pair-qr-image"
              width={288}
              height={288}
              className="block w-72 h-72"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            <div className="w-72 h-72 grid place-items-center text-ink/40">
              Generating…
            </div>
          )}
        </div>
      </div>
      <button
        onClick={onRegenerate}
        className="text-xs text-magenta hover:underline min-h-[44px]"
      >
        Regenerate code
      </button>
      <p data-testid="pair-code-countdown" className="text-xs text-ink/50">
        {remainingMs > 0
          ? `This code expires in ${mm}:${ss.toString().padStart(2, '0')}.`
          : 'This code has expired — tap Regenerate code.'}
      </p>
    </div>
  );
}
