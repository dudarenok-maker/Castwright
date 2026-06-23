// Pairs with docs/features/archive/08-audio-tag-auto-detection.md (audio-tag detection layer).

import { describe, expect, it } from 'vitest';
import {
  tagShoutingDialog,
  tagExcitedDialog,
  tagHesitantDialog,
  tagMarkdownEmphasis,
  tagHtmlEmphasis,
} from './audio-tags.js';

describe('tagShoutingDialog', () => {
  it('tags long all-caps dialogue and title-cases the run', () => {
    const out = tagShoutingDialog('She yelled "GET OUT NOW".');
    expect(out).toBe('She yelled "[shouting] Get Out Now".');
  });

  it('tags short all-caps dialogue when it ends in !', () => {
    const out = tagShoutingDialog('"NO!" he cried.');
    expect(out).toBe('"[shouting] No!" he cried.');
  });

  it('does not tag short all-caps without ! (avoids OK / AC false-positives)', () => {
    expect(tagShoutingDialog('"OK" she said.')).toBe('"OK" she said.');
    expect(tagShoutingDialog('"AC" he replied.')).toBe('"AC" he replied.');
  });

  it('leaves mixed-case quotes alone', () => {
    expect(tagShoutingDialog('"Hello there!" she said.')).toBe('"Hello there!" she said.');
  });

  it('is idempotent — does not double-tag an already-tagged quote', () => {
    const once = tagShoutingDialog('"GET OUT!"');
    const twice = tagShoutingDialog(once);
    expect(twice).toBe(once);
  });

  it('handles smart quotes', () => {
    const out = tagShoutingDialog('She yelled “GET OUT”.');
    expect(out).toBe('She yelled “[shouting] Get Out”.');
  });

  it('preserves text outside quotes verbatim', () => {
    const out = tagShoutingDialog('Before "HELLO THERE" after.');
    expect(out).toBe('Before "[shouting] Hello There" after.');
  });
});

describe('tagExcitedDialog', () => {
  it('tags dialogue containing !', () => {
    expect(tagExcitedDialog('"Watch out!" he said.')).toBe('"[excited] Watch out!" he said.');
  });

  it('does not tag dialogue without !', () => {
    expect(tagExcitedDialog('"Just a quiet thought."')).toBe('"Just a quiet thought."');
  });

  it('cedes to shouting precedence — does not stack on top of a shouting tag', () => {
    const shouted = tagShoutingDialog('"GET OUT!"');
    expect(tagExcitedDialog(shouted)).toBe(shouted);
  });

  it('skips pure full-caps shouts even before tagShoutingDialog runs', () => {
    // Precedence is in-detector: tagExcitedDialog itself checks isShoutingRun
    // and bails before adding a tag, so a yet-untagged shout doesn't
    // accidentally become [excited].
    expect(tagExcitedDialog('"NO!"')).toBe('"NO!"');
  });

  it('is idempotent', () => {
    const once = tagExcitedDialog('"Hey!"');
    expect(tagExcitedDialog(once)).toBe(once);
  });
});

describe('tagHesitantDialog', () => {
  it('tags dialogue starting with an ellipsis', () => {
    expect(tagHesitantDialog('"… I suppose."')).toBe('"[hesitant] … I suppose."');
  });

  it('tags dialogue ending in two-dot ellipsis', () => {
    expect(tagHesitantDialog('"I suppose.."')).toBe('"[hesitant] I suppose.."');
  });

  it('tags dialogue ending in three-dot ellipsis', () => {
    expect(tagHesitantDialog('"Maybe..."')).toBe('"[hesitant] Maybe..."');
  });

  it('leaves dialogue without leading or trailing ellipsis alone', () => {
    expect(tagHesitantDialog('"I am sure."')).toBe('"I am sure."');
  });

  it('is idempotent', () => {
    const once = tagHesitantDialog('"… maybe."');
    expect(tagHesitantDialog(once)).toBe(once);
  });
});

describe('tagMarkdownEmphasis', () => {
  it('converts *foo* to [emphatic] foo', () => {
    expect(tagMarkdownEmphasis('this is *important* news')).toBe(
      'this is [emphatic] important news',
    );
  });

  it('converts _foo_ to [emphatic] foo', () => {
    expect(tagMarkdownEmphasis('this is _stressed_ syllable')).toBe(
      'this is [emphatic] stressed syllable',
    );
  });

  it('converts **bold** to [emphatic] bold (no double tag)', () => {
    expect(tagMarkdownEmphasis('a **strong** point')).toBe('a [emphatic] strong point');
  });

  it('converts __bold__ to [emphatic] bold', () => {
    expect(tagMarkdownEmphasis('a __strong__ point')).toBe('a [emphatic] strong point');
  });

  it('leaves lone asterisks alone', () => {
    expect(tagMarkdownEmphasis('a * stray')).toBe('a * stray');
  });

  it('leaves whitespace-only emphasis alone', () => {
    expect(tagMarkdownEmphasis('a *  * stray')).toBe('a *  * stray');
  });
});

describe('tagHtmlEmphasis', () => {
  it('converts <em> tags to [emphatic]', () => {
    expect(tagHtmlEmphasis('this is <em>vital</em>.')).toBe('this is [emphatic] vital.');
  });

  it('converts <i>, <strong>, <b> tags', () => {
    expect(tagHtmlEmphasis('<i>x</i> <strong>y</strong> <b>z</b>')).toBe(
      '[emphatic] x [emphatic] y [emphatic] z',
    );
  });

  it('case-insensitive on tag name', () => {
    expect(tagHtmlEmphasis('<EM>loud</EM>')).toBe('[emphatic] loud');
  });

  it('passes through unrelated tags', () => {
    expect(tagHtmlEmphasis('<p>hi</p>')).toBe('<p>hi</p>');
  });
});

describe('audio-tags — non-English quotes + Unicode case (seam 3c)', () => {
  it('tags shouting inside German „…" quotes (umlaut caps)', () => {
    // „SCHNELL!" — German low/high quotes, all-caps incl. no umlaut here but Unicode-cap path
    const out = tagShoutingDialog('Er rief „SCHNELL!"');
    expect(out).toContain('[shouting]');
    expect(out).not.toContain('SCHNELL'); // denormalised to Schnell
  });
  it('tags shouting inside Russian «…» quotes (Cyrillic caps) — previously a silent miss', () => {
    const out = tagShoutingDialog('Он крикнул «БЫСТРО!»');
    expect(out).toContain('[shouting]');
  });
  it('tags excited dialogue inside Spanish «…!» quotes', () => {
    const out = tagExcitedDialog('Ella dijo «¡Cuidado!»');
    expect(out).toContain('[excited]');
  });
  it('leaves English smart-quote behaviour unchanged', () => {
    expect(tagShoutingDialog('She yelled "GET OUT".')).toBe('She yelled "[shouting] Get Out".');
  });
});
