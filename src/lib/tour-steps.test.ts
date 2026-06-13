import { describe, it, expect } from 'vitest';
import { TOUR_STEPS, stepsForScreen, TOUR_SCREENS, screenForStage } from './tour-steps';

describe('tour-steps registry', () => {
  it('has the 13 steps across 5 stations in order', () => {
    expect(TOUR_STEPS).toHaveLength(13);
    const order = TOUR_STEPS.map((s) => s.screen);
    const firstSeen = [...new Set(order)];
    expect(firstSeen).toEqual(['library', 'manuscript', 'cast', 'generate', 'listen']);
  });

  it('every step screen is a valid TourScreen', () => {
    for (const s of TOUR_STEPS) expect(TOUR_SCREENS).toContain(s.screen);
  });

  it('every non-null anchor is unique', () => {
    const anchors = TOUR_STEPS.map((s) => s.anchor).filter(Boolean) as string[];
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('stepsForScreen("cast") returns the cast mini-tour in order', () => {
    const ids = stepsForScreen('cast').map((s) => s.id);
    expect(ids).toEqual(['s6-roster', 's7-drawer', 's8-fullcast']);
  });

  it('every step id is unique', () => {
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
  });
});

describe('screenForStage', () => {
  it('screenForStage maps stage-kind + view to a TourScreen', () => {
    expect(screenForStage('books', null)).toBe('library');
    expect(screenForStage('ready', 'cast')).toBe('cast');
    expect(screenForStage('ready', 'log')).toBeNull();
    expect(screenForStage('account', null)).toBeNull();
  });
});
