/* Ordered render list for the Help troubleshooting groups. `setup` first (it is
   open by default); `other` ("Something else", the unknown-failure bucket) last. */
import type { CategoryId } from './help-failures';

export const HELP_CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'setup', label: 'Setup & getting started' },
  { id: 'engines', label: 'Voice engines & models' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'voices', label: 'Voices & languages' },
  { id: 'quality', label: 'Quality & directing' },
  { id: 'cast', label: 'Cast & attribution' },
  { id: 'performance', label: 'Performance & GPU' },
  { id: 'files', label: 'Files, export & devices' },
  { id: 'other', label: 'Something else' },
];
