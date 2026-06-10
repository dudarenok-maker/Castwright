/* fs-1 — Account → Application updates card. Pick a release zip, confirm the
   version delta + release notes, apply. During apply a full-screen overlay
   polls /api/upgrade/state and /api/info until the server answers on the new
   version, then reloads to pick up the new bundle.

   Self-contained: owns its slice state + the useAppInfo poller. Mounted as the
   first card in the Account view; not part of the account Save flow. */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import {
  stageUpgrade,
  applyUpgrade,
  abortUpgrade,
  pollUpgradeState,
  upgradeActions,
} from '../store/upgrade-slice';
import { notificationsActions } from '../store/notifications-slice';
import { useAppInfo } from '../lib/use-app-info';

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      data-testid="upgrade-card"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
    >
      <h2 className="text-base font-semibold text-ink">Application updates</h2>
      <p className="mt-1 text-xs text-ink/55">
        Apply a release package (.zip) to upgrade in place. Your library, settings, and voices are
        preserved, and every book is backed up before any data migration.
      </p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function UpgradeCard() {
  const dispatch = useAppDispatch();
  const upgrade = useAppSelector((s) => s.upgrade);
  const { info } = useAppInfo();
  const fileRef = useRef<HTMLInputElement>(null);
  const runningVersion = info?.appVersion ?? '…';

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void dispatch(stageUpgrade(file));
    e.target.value = ''; // allow re-picking the same file
  };

  return (
    <Card>
      <p className="text-sm text-ink/80">
        You&apos;re running <span className="font-semibold">v{runningVersion}</span>
        {info?.sidecarVersion ? ` · sidecar v${info.sidecarVersion}` : ''}.
      </p>
      <p className="mt-1 text-xs">
        <Link to="/release-notes" className="font-medium text-magenta hover:underline">
          See what&apos;s new
        </Link>
      </p>

      <input ref={fileRef} type="file" accept=".zip" onChange={onPick} className="hidden" />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={upgrade.status === 'staging' || upgrade.status === 'applying'}
        className="mt-3 min-h-[44px] sm:min-h-0 rounded-xl bg-magenta px-4 py-2 text-sm font-medium text-white hover:bg-magenta/90 disabled:opacity-50"
      >
        {upgrade.status === 'staging' ? 'Validating…' : 'Apply update package…'}
      </button>

      {upgrade.status === 'error' && upgrade.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {upgrade.error}
        </p>
      )}

      {upgrade.status === 'staged' && upgrade.candidate && (
        <UpgradeConfirm
          fromVersion={runningVersion}
          candidate={upgrade.candidate}
          releaseNotes={info?.releaseNotes ?? ''}
          onCancel={() => void dispatch(abortUpgrade())}
          onApply={() => void dispatch(applyUpgrade())}
        />
      )}

      {(upgrade.status === 'applying' || upgrade.serverState?.phase === 'restarting') &&
        upgrade.candidate && <UpgradingScreen candidateVersion={upgrade.candidate.candidateVersion} />}
    </Card>
  );
}

function UpgradeConfirm({
  fromVersion,
  candidate,
  releaseNotes,
  onCancel,
  onApply,
}: {
  fromVersion: string;
  candidate: { candidateVersion: string; isDowngrade: boolean; requiresPipInstall: boolean };
  releaseNotes: string;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div data-testid="upgrade-confirm" className="mt-4 rounded-xl border border-ink/10 bg-peach/30 p-4">
      <p className="text-sm font-semibold text-ink">
        v{fromVersion} → v{candidate.candidateVersion}
      </p>
      {candidate.isDowngrade && (
        <p className="mt-1 text-xs font-medium text-red-600">
          This package is OLDER than your current version. Downgrades are not supported and may not
          migrate data back.
        </p>
      )}
      {candidate.requiresPipInstall && (
        <p className="mt-1 text-xs text-ink/60">Python dependencies changed — the venv will reinstall.</p>
      )}
      {releaseNotes.trim() && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-ink/70">
          {releaseNotes.trim()}
        </pre>
      )}
      <p className="mt-2 text-xs text-ink/55">
        Every <code>.audiobook</code> JSON is backed up to <code>workspace/.upgrade-backups/</code>{' '}
        before any migration.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={candidate.isDowngrade}
          className="min-h-[44px] sm:min-h-0 rounded-xl bg-magenta px-4 py-2 text-sm font-medium text-white hover:bg-magenta/90 disabled:opacity-50"
        >
          Apply upgrade
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[44px] sm:min-h-0 rounded-xl border border-ink/15 px-4 py-2 text-sm font-medium text-ink/70 hover:bg-ink/5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function UpgradingScreen({ candidateVersion }: { candidateVersion: string }) {
  const dispatch = useAppDispatch();
  const { info, refresh } = useAppInfo();
  const [done, setDone] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      void dispatch(pollUpgradeState());
      void refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [dispatch, refresh]);

  // Version flipped → the new server is up. Toast, then reload to swap the bundle.
  useEffect(() => {
    if (done) return;
    if (info?.appVersion === candidateVersion) {
      setDone(true);
      dispatch(notificationsActions.pushToast({ kind: 'info', message: `Upgraded to v${candidateVersion}.` }));
      dispatch(upgradeActions.resetUpgrade());
      const t = setTimeout(() => window.location.reload(), 1200);
      return () => clearTimeout(t);
    }
  }, [info?.appVersion, candidateVersion, done, dispatch]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upgrading"
      data-testid="upgrading-screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-canvas/95 backdrop-blur-sm"
    >
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-magenta/30 border-t-magenta" />
      <p className="text-sm font-medium text-ink">
        {done ? `Upgraded to v${candidateVersion} — reloading…` : `Upgrading to v${candidateVersion}…`}
      </p>
      <p className="text-xs text-ink/55">The app is restarting. This page will refresh automatically.</p>
    </div>
  );
}
