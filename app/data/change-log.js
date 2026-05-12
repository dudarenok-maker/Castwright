/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
const CHANGE_LOG_EVENTS = [
  { id: 1,  ts: "2 min ago",        date: "today",     type: "regenerate",         title: "Regenerated Chapter 3",                  note: "Reason: voice tuning. Eliza's authority slider moved up — re-voicing this chapter and propagating forward.", actor: "you",    chapterId: 3, revertible: true },
  { id: 2,  ts: "5 min ago",        date: "today",     type: "voice_tune",         title: "Tuned Eliza Gray's voice",               note: "Authority 40 → 55, Emotion 75 → 80. 12-second sample regenerated.",                                            actor: "you",    revertible: true },
  { id: 3,  ts: "12 min ago",       date: "today",     type: "voice_reuse",        title: "Reused Narrator voice from Solway Bay",  note: "Confirmed match at 94% — Anders Vale's narration carries forward into this book.",                              actor: "you" },
  { id: 4,  ts: "14 min ago",       date: "today",     type: "boundary_move",      title: "Moved a speaker boundary",               note: "Chapter 3 — boundary between Halloran and Eliza moved by 2 sentences.",                                          actor: "you",    chapterId: 3, revertible: true },
  { id: 5,  ts: "1 hr ago",         date: "today",     type: "chapter_complete",   title: "Chapter 2 voiced",                       note: "14:02 of audio · A Manifest Two Names Short",                                                                   actor: "system", chapterId: 2 },
  { id: 6,  ts: "2 hr ago",         date: "today",     type: "chapter_complete",   title: "Chapter 1 voiced",                       note: "12:48 of audio · The Berth at Liverpool",                                                                       actor: "system", chapterId: 1 },
  { id: 7,  ts: "3 hr ago",         date: "today",     type: "generation_started", title: "Audiobook generation started",            note: "7 chapters queued · 4 voices · estimated 38 minutes total.",                                                    actor: "you" },
  { id: 8,  ts: "Yesterday, 4:12pm", date: "yesterday", type: "voice_lock",         title: "Locked Captain Halloran's voice",        note: "Voice profile finalised — won't auto-regenerate when other voices change.",                                      actor: "you" },
  { id: 9,  ts: "Yesterday, 3:45pm", date: "yesterday", type: "cast_confirm",       title: "Confirmed the cast",                     note: "4 characters: Narrator, Captain Halloran, Eliza Gray, Marcus the Cook.",                                          actor: "you" },
  { id: 10, ts: "Yesterday, 3:30pm", date: "yesterday", type: "analysis_complete",  title: "Analysis complete",                       note: "Detected 4 speaking characters · 1 matched from your library (Narrator from Solway Bay).",                       actor: "system" },
  { id: 11, ts: "Yesterday, 3:28pm", date: "yesterday", type: "import",             title: "Manuscript imported",                    note: "84,000 words · 24 chapters · 1.2 MB markdown",                                                                  actor: "you" },
  { id: 12, ts: "Last week",         date: "earlier",   type: "library_add",        title: "Added Solway Bay narrator to library",   note: "Anders Vale voice saved as reusable — used 11 times so far.",                                                   actor: "you" },
];


Object.assign(window, { CHANGE_LOG_EVENTS });
