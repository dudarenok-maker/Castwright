import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CompanionAppBanner } from '../components/listen/companion-app-banner';
import * as apiMod from './api';

describe('tour anchors (smoke)', () => {
  it('companion banner carries data-tour-id', async () => {
    vi.spyOn(apiMod.api, 'checkCompanionApk').mockResolvedValue({ available: false, sizeBytes: null } as any);
    const { container } = render(<CompanionAppBanner />);
    expect(container.querySelector('[data-tour-id="companion-app-banner"]')).not.toBeNull();
  });
});
