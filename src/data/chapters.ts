import type { Chapter } from '../lib/types';

export const initialChapters: Chapter[] = [
  { id: 1, title: 'The Berth at Liverpool',     duration: '12:48', state: 'done',        progress: 1.0,  characters: { narrator: 'done',        halloran: 'done',    eliza: 'skipped', marcus: 'skipped' } },
  { id: 2, title: 'A Manifest Two Names Short', duration: '14:02', state: 'done',        progress: 1.0,  characters: { narrator: 'done',        halloran: 'done',    eliza: 'done',    marcus: 'skipped' } },
  { id: 3, title: 'What the Captain Knew',      duration: '11:31', state: 'in_progress', progress: 0.42, currentLine: 278, totalLines: 661, characters: { narrator: 'in_progress', halloran: 'done',    eliza: 'queued',  marcus: 'queued' } },
  { id: 4, title: "The Cook's Particular Soup", duration: '09:14', state: 'queued',      progress: 0,    characters: { narrator: 'queued',      halloran: 'skipped', eliza: 'queued',  marcus: 'queued' } },
  { id: 5, title: 'Storms, In Theory',          duration: '13:47', state: 'queued',      progress: 0,    characters: { narrator: 'queued',      halloran: 'queued',  eliza: 'queued',  marcus: 'skipped' } },
  { id: 6, title: 'Storms, In Practice',        duration: '16:22', state: 'queued',      progress: 0,    characters: { narrator: 'queued',      halloran: 'queued',  eliza: 'queued',  marcus: 'queued' } },
  { id: 7, title: 'An Unexpected Reading',      duration: '10:08', state: 'failed',      progress: 0.15, characters: { narrator: 'failed',      halloran: 'queued',  eliza: 'queued',  marcus: 'skipped' }, errorReason: 'Voice generation timed out for Narrator at line 412' },
];
