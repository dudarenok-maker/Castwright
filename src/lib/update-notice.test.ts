import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppInfo } from './types';
import {
  getDismissedVersion,
  dismissUpdate,
  shouldShowUpdateNotice,
  __resetForTests,
} from './update-notice';

const base: AppInfo = {
  appVersion: '1.8.0',
  sidecarVersion: null,
  schemas: {},
  lastSeenAppVersion: null,
  showWhatsNew: false,
  releaseNotes: '',
};

beforeEach(() => {
  localStorage.clear();
  __resetForTests();
});

describe('shouldShowUpdateNotice', () => {
  it('shows when an update is available and not dismissed', () => {
    const info = { ...base, updateAvailable: true, latestVersion: '1.9.0' };
    expect(shouldShowUpdateNotice(info, null)).toBe(true);
  });

  it('hides when the latest equals the dismissed version', () => {
    const info = { ...base, updateAvailable: true, latestVersion: '1.9.0' };
    expect(shouldShowUpdateNotice(info, '1.9.0')).toBe(false);
  });

  it('re-shows when a yanked release regresses latest to a different unseen version', () => {
    const info = { ...base, updateAvailable: true, latestVersion: '1.8.5' };
    expect(shouldShowUpdateNotice(info, '1.9.0')).toBe(true);
  });

  it('hides while showWhatsNew is true', () => {
    const info = { ...base, showWhatsNew: true, updateAvailable: true, latestVersion: '1.9.0' };
    expect(shouldShowUpdateNotice(info, null)).toBe(false);
  });

  it('hides on null info or no update', () => {
    expect(shouldShowUpdateNotice(null, null)).toBe(false);
    expect(shouldShowUpdateNotice({ ...base, updateAvailable: false }, null)).toBe(false);
    expect(shouldShowUpdateNotice({ ...base, updateAvailable: null }, null)).toBe(false);
  });
});

describe('dismissUpdate', () => {
  it('records the version and notifies subscribers', () => {
    const seen: (string | null)[] = [];
    dismissUpdate('1.9.0');
    expect(getDismissedVersion()).toBe('1.9.0');
    expect(localStorage.getItem('castwright:dismissedUpdateVersion')).toBe('1.9.0');
  });

  it('does not throw when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => dismissUpdate('1.9.0')).not.toThrow();
    expect(getDismissedVersion()).toBe('1.9.0'); // in-memory still updates
    spy.mockRestore();
  });
});
