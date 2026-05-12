/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
const ANALYSIS_PHASES = [
  { id: 0, label: "Reading manuscript",   detail: "Parsing markdown, mapping chapters and scenes.",                            duration: 1500 },
  { id: 1, label: "Detecting characters", detail: "Named-entity extraction, dialogue attribution, speaker resolution.",        duration: 2200 },
  { id: 2, label: "Profiling voices",     detail: "Inferring age, register, regional cues, sentence rhythm from each speaker.", duration: 2400 },
  { id: 3, label: "Matching library",     detail: "Reconciling against voices from your previous books.",                       duration: 1500 },
];

Object.assign(window, { ANALYSIS_PHASES });
