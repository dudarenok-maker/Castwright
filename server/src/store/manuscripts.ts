/* In-memory manuscript store. Server restart wipes state — fine for first slice. */

export type ManuscriptFormat = 'markdown' | 'plaintext' | 'epub' | 'pdf';

export interface ChapterHint {
  /** 1-based index used as the canonical chapter id. */
  id: number;
  title: string;
  /** Normalised plain text body, with paragraph breaks preserved as \n\n. */
  body: string;
}

export interface ManuscriptRecord {
  manuscriptId: string;
  format: ManuscriptFormat;
  title: string;
  wordCount: number;
  byteSize: number;
  uploadedAt: string;
  /** Concatenated body across all chapters; what we hand to the analysis stage. */
  sourceText: string;
  chapterHints: ChapterHint[];
}

const store = new Map<string, ManuscriptRecord>();

export function putManuscript(record: ManuscriptRecord): void {
  store.set(record.manuscriptId, record);
}

export function getManuscript(id: string): ManuscriptRecord | undefined {
  return store.get(id);
}

export function listManuscripts(): ManuscriptRecord[] {
  return Array.from(store.values());
}
