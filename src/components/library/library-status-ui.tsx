/* Status-pill metadata for library cards / table rows.

   Extracted from `library-grid.tsx` so the new `library-table.tsx` can
   render the same status pill (label + icon + colour) without a circular
   import via the grid. The map keys `LibraryBookStatus` 1:1 — the
   `library-status-ui.test.ts` round-trip locks the contract. */

import type { JSX } from 'react';
import {
  IconCheck,
  IconCheckCircle,
  IconPlus,
  IconSpinner,
  IconWarning,
} from '../../lib/icons';
import type { LibraryBookStatus } from '../../lib/types';

export type StatusMeta = {
  color: 'library' | 'warning' | 'peach' | 'success' | 'danger';
  label: string;
  icon: JSX.Element;
};

export const STATUS_UI: Record<LibraryBookStatus, StatusMeta> = {
  not_analysed: {
    color: 'library',
    label: 'Ready to analyse',
    icon: <IconPlus className="w-3.5 h-3.5" />,
  },
  analysing: {
    color: 'library',
    label: 'Analysing',
    icon: <IconSpinner className="w-3.5 h-3.5" />,
  },
  cast_pending: {
    color: 'warning',
    label: 'Cast confirmation',
    icon: <IconCheckCircle className="w-3.5 h-3.5" />,
  },
  generating: {
    color: 'peach',
    label: 'Generating',
    icon: <IconSpinner className="w-3.5 h-3.5" />,
  },
  complete: { color: 'success', label: 'Complete', icon: <IconCheck className="w-3.5 h-3.5" /> },
  unreadable: {
    color: 'danger',
    label: 'State unreadable',
    icon: <IconWarning className="w-3.5 h-3.5" />,
  },
  orphaned: {
    color: 'danger',
    label: 'Manuscript missing',
    icon: <IconWarning className="w-3.5 h-3.5" />,
  },
};
