/* ops-28 — first-run wizard "LAN access" step. Advisory + soft-warning:
   never gates Finish; warns only when LAN HTTPS is requested yet the cert is
   missing/expired. */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { LanCertStatus as CertStatus } from '../../lib/api';
import { LanCertStatus, isCertWarning } from '../lan-cert-status';

export function StepLanCert() {
  const [status, setStatus] = useState<CertStatus | null>(null);
  useEffect(() => {
    api.getLanCertStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-xl font-bold text-ink">LAN access</h2>
        <p className="mt-1 text-sm text-ink/60">
          Serve your library to phones and tablets over your local network.
        </p>
      </div>

      {status && isCertWarning(status) && (
        <div
          data-testid="lan-cert-warning-banner"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          Phone/tablet pairing is off because the HTTPS certificate isn’t ready.
        </div>
      )}

      <LanCertStatus variant="wizard" />
    </div>
  );
}
