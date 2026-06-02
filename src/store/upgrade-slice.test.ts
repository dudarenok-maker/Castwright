/* fs-1 — pin the upgrade slice lifecycle. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../lib/api', () => ({
  api: {
    upgradeStage: vi.fn(),
    upgradeApply: vi.fn(),
    upgradeAbort: vi.fn(),
    upgradeState: vi.fn(),
  },
}));
import { api } from '../lib/api';
import {
  upgradeSlice,
  upgradeActions,
  stageUpgrade,
  applyUpgrade,
  abortUpgrade,
  pollUpgradeState,
} from './upgrade-slice';

function makeStore() {
  return configureStore({ reducer: { upgrade: upgradeSlice.reducer } });
}

const CANDIDATE = {
  candidateVersion: '1.7.0',
  runningVersion: '1.6.0',
  reqHash: 'h',
  requiresPipInstall: false,
  isDowngrade: false,
};

beforeEach(() => vi.clearAllMocks());

describe('upgradeSlice', () => {
  it('stages a candidate: staging → staged', async () => {
    vi.mocked(api.upgradeStage).mockResolvedValue(CANDIDATE);
    const store = makeStore();
    const p = store.dispatch(stageUpgrade(new File([''], 'x.zip')));
    expect(store.getState().upgrade.status).toBe('staging');
    await p;
    const s = store.getState().upgrade;
    expect(s.status).toBe('staged');
    expect(s.candidate).toEqual(CANDIDATE);
  });

  it('records a staging failure as an error', async () => {
    vi.mocked(api.upgradeStage).mockRejectedValue(new Error('Upgrade staging failed (412): downgrade'));
    const store = makeStore();
    await store.dispatch(stageUpgrade(new File([''], 'x.zip')));
    const s = store.getState().upgrade;
    expect(s.status).toBe('error');
    expect(s.error).toContain('downgrade');
  });

  it('flips to applying on apply', async () => {
    vi.mocked(api.upgradeApply).mockResolvedValue(undefined);
    const store = makeStore();
    const p = store.dispatch(applyUpgrade());
    expect(store.getState().upgrade.status).toBe('applying');
    await p;
  });

  it('captures an apply-phase error from a poll', async () => {
    vi.mocked(api.upgradeState).mockResolvedValue({ phase: 'error', error: 'npm ci exited 1', busy: false });
    const store = makeStore();
    await store.dispatch(pollUpgradeState());
    const s = store.getState().upgrade;
    expect(s.status).toBe('error');
    expect(s.error).toBe('npm ci exited 1');
  });

  it('resets to idle on abort and on resetUpgrade', async () => {
    vi.mocked(api.upgradeStage).mockResolvedValue(CANDIDATE);
    vi.mocked(api.upgradeAbort).mockResolvedValue(undefined);
    const store = makeStore();
    await store.dispatch(stageUpgrade(new File([''], 'x.zip')));
    expect(store.getState().upgrade.candidate).not.toBeNull();
    await store.dispatch(abortUpgrade());
    expect(store.getState().upgrade.status).toBe('idle');
    expect(store.getState().upgrade.candidate).toBeNull();

    store.dispatch(stageUpgrade.fulfilled(CANDIDATE, '', new File([''], 'x.zip')));
    store.dispatch(upgradeActions.resetUpgrade());
    expect(store.getState().upgrade.status).toBe('idle');
  });
});
