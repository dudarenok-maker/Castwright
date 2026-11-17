/* Crash fixture (#4242): runs epub2's own getChapter on the EPUB at
   workerData.sourcePath and never posts. With #4239's empty-href EPUB the throw
   comes from adm-zip's async inflate callback (`linkparts.shift is not a
   function`), which ends the worker (or, on a main thread, is an
   uncaughtException). */
import { workerData } from 'node:worker_threads';
import { EPub } from 'epub2';

const epub = await EPub.createAsync(workerData.sourcePath);
epub.getChapter(epub.flow[0].id, () => {});
