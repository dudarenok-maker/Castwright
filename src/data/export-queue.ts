import type { ExportQueueItem } from '../lib/types';

export const EXPORT_QUEUE: ExportQueueItem[] = [
  { id: 'ex1', filename: 'The Northern Star — Full audiobook.m4b',  format: 'm4b',  size: '287 MB', status: 'done',        timestamp: '2 min ago',  destination: 'Local download' },
  { id: 'ex2', filename: 'The Northern Star — Sample (CH 1–3).m4a', format: 'm4a',  size: '38 MB',  status: 'done',        timestamp: '12 min ago', destination: 'AirDrop · BookPlayer' },
  { id: 'ex3', filename: 'The Northern Star — MP3 by chapter.zip',  format: 'zip',  size: '312 MB', status: 'in_progress', timestamp: 'Now',        destination: 'Local download', progress: 0.42 },
  { id: 'ex4', filename: 'The Northern Star — Streaming link',      format: 'link', size: 'Hosted', status: 'done',        timestamp: '1 hr ago',   destination: 'Audiobookshelf · home server', url: 'https://abs.example.com/listen/4f2a' },
  { id: 'ex5', filename: 'Solway Bay — Full audiobook.m4b',         format: 'm4b',  size: '246 MB', status: 'done',        timestamp: 'Yesterday',  destination: 'Local download' },
  { id: 'ex6', filename: 'Solway Bay — Streaming link',             format: 'link', size: 'Hosted', status: 'failed',      timestamp: 'Yesterday',  destination: 'Plex', errorReason: 'Server unreachable — check Plex Media Server connection' },
];
