/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
const REGEN_REASONS = [
  { id: "voice",       label: "Voice tuning updated",      description: "I've adjusted one or more characters since this chapter was generated." },
  { id: "manuscript",  label: "Manuscript edits",          description: "The text in this chapter has changed and needs re-voicing." },
  { id: "quality",     label: "Quality issue — try again", description: "The result didn't sound right. Same inputs, fresh attempt." },
  { id: "other",       label: "Other reason",              description: "I'll add a note for the change log.", custom: true },
];


Object.assign(window, { REGEN_REASONS });
