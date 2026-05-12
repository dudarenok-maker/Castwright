/* Auto-extracted from Audiobook Prototype.html — see ARCHITECTURE.md.
   Babel scope per <script> requires globals: every export at end. */
const LOG_TYPES = {
  regenerate:         { icon: <IconRefresh className="w-3.5 h-3.5"/>,    color: "#A43C6C", label: "Regenerated"        },
  voice_tune:         { icon: <IconWaveform className="w-3.5 h-3.5"/>,   color: "#F79A83", label: "Voice tuned"        },
  voice_reuse:        { icon: <IconStar className="w-3.5 h-3.5"/>,       color: "#3C194F", label: "Voice reused"       },
  voice_lock:         { icon: <IconLock className="w-3.5 h-3.5"/>,       color: "#0F0E0D", label: "Voice locked"       },
  boundary_move:      { icon: <IconDrag className="w-3.5 h-3.5"/>,       color: "#0F0E0D", label: "Boundary moved"     },
  chapter_complete:   { icon: <IconCheck className="w-3.5 h-3.5"/>,      color: "#2F7A57", label: "Chapter generated"  },
  generation_started: { icon: <IconPlay className="w-3.5 h-3.5"/>,       color: "#A43C6C", label: "Generation started" },
  cast_confirm:       { icon: <IconCheckCircle className="w-3.5 h-3.5"/>,color: "#2F7A57", label: "Cast confirmed"     },
  analysis_complete:  { icon: <IconSparkle className="w-3.5 h-3.5"/>,    color: "#3C194F", label: "Analysis complete"  },
  import:             { icon: <IconUpload className="w-3.5 h-3.5"/>,     color: "#0F0E0D", label: "Imported"           },
  library_add:        { icon: <IconLayers className="w-3.5 h-3.5"/>,     color: "#3C194F", label: "Library updated"    },
};

Object.assign(window, { LOG_TYPES });
