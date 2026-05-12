/* Domain model sketches — not enforced at runtime; rewrite as TS interfaces in the migrated app.

@typedef {Object} Character
  @property {string} id
  @property {string} name
  @property {"narrator"|"halloran"|"eliza"|"marcus"} color
  @property {string} role           Short role descriptor ("Captain · POV", etc.)
  @property {number} lines          Total lines of dialogue in the manuscript
  @property {string[]} attributes   Voice-attribute tags
  @property {string=} voiceId       FK → Voice.id
  @property {"matched"|"generated"|"tuned"|"locked"} voiceState
  @property {{bookTitle:string, bookId:string, confidence:number}=} matchedFrom
  @property {{warmth:number, pace:number, formality:number}} tone

@typedef {Object} Voice
  @property {string} id
  @property {string} character
  @property {string} bookTitle
  @property {string} bookId
  @property {string[]} attributes
  @property {[string,string]} gradient
  @property {number} usedIn
  @property {"current"|"library"} source
  @property {boolean=} reusable

@typedef {Object} Chapter
  @property {number} id
  @property {string} title
  @property {"queued"|"generating"|"done"|"failed"} state
  @property {number} progress       0..1
  @property {string} duration       "MM:SS"
  @property {number} totalLines
  @property {Object<string, "queued"|"generating"|"done"|"skipped">} characters

@typedef {Object} Sentence
  @property {number} absIdx
  @property {string} charId
  @property {string} text
  @property {number=} confidence

@typedef {Object} Book
  @property {string} id
  @property {string} title
  @property {string} author
  @property {[string,string]} coverGradient
  @property {string} runtime          "11h 24m"
  @property {string} status

@typedef {Object} Revision
  @property {string} id
  @property {number} chapterId
  @property {string=} characterId
  @property {string} reason
  @property {string} triggeredAgo
  @property {SegmentDiff[]} segments

@typedef {Object} DriftEvent
  @property {string} id
  @property {string} characterId
  @property {number} chapterId
  @property {"warmth"|"pace"|"timbre"} dimension
  @property {number} delta
*/

window.__TYPES_LOADED = true;
