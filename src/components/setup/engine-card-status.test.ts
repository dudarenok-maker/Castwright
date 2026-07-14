import { describe, it, expect } from 'vitest';
import { runtimeIsBlocking, runtimeLivenessPill } from './engine-card-status';

describe('runtime liveness classification', () => {
  it('transient starting is NOT a blocker (neutral)', () => {
    expect(
      runtimeIsBlocking({ installedOnDisk: true, pythonFound: true, process: 'starting' }),
    ).toBe(false);
    expect(
      runtimeLivenessPill({ installedOnDisk: true, pythonFound: true, process: 'starting' }),
    ).toEqual({ tone: 'neutral', label: expect.stringMatching(/starting/i) });
  });
  it('down/crashed ARE blockers', () => {
    expect(
      runtimeIsBlocking({ installedOnDisk: true, pythonFound: true, process: 'crashed' }),
    ).toBe(true);
    expect(runtimeIsBlocking({ installedOnDisk: true, pythonFound: true, process: 'down' })).toBe(
      true,
    );
  });
  it('not-installed-on-disk IS a blocker regardless of process', () => {
    expect(
      runtimeIsBlocking({ installedOnDisk: false, pythonFound: true, process: 'down' }),
    ).toBe(true);
  });
  it('not-installed-on-disk renders no pill (the card tells the story)', () => {
    expect(
      runtimeLivenessPill({ installedOnDisk: false, pythonFound: true, process: 'down' }),
    ).toBeNull();
  });
  it('ready renders no pill', () => {
    expect(
      runtimeLivenessPill({ installedOnDisk: true, pythonFound: true, process: 'ready' }),
    ).toBeNull();
  });
  it('down/crashed render an alarm pill', () => {
    expect(
      runtimeLivenessPill({ installedOnDisk: true, pythonFound: true, process: 'down' }),
    ).toEqual({ tone: 'alarm', label: expect.stringMatching(/not running/i) });
    expect(
      runtimeLivenessPill({ installedOnDisk: true, pythonFound: true, process: 'crashed' }),
    ).toEqual({ tone: 'alarm', label: expect.stringMatching(/crashed/i) });
  });
});
