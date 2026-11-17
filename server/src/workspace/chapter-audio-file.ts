/* Locate a chapter's audio file on disk. Probes the audio formats produced
   by the encoder (plan 72 widened the set from mp3-only to mp3/m4a/ogg).
   Legacy `.wav` files from before plan 39 stay invisible. Voice samples
   (`server/src/routes/voice-sample.ts`) live in a different directory and
   are not handled here.

   The probe is ordered: an `.mp3` next to an `.m4a` (e.g. mid-format
   switch on the same book) resolves to whichever ranks first in
   the probe order - mp3 wins so existing books keep behaving
   identically until they're re-rendered into a new format.

   The implementation now lives in the take leaf, `./take-fields.ts` (#4326);
   this file is a thin re-export until #4335 deletes it once no importer is left. */

export {
  CHAPTER_AUDIO_EXTS,
  findChapterAudio,
  chapterAudioExists,
  type ChapterAudioExt,
  type ChapterAudioFile,
} from './take-fields.js';
