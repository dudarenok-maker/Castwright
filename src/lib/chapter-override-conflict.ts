/* Plan 84 — detect renamed-chapter conflicts on manuscript re-upload.

   Plan 78 added a `titleOverridden: true` flag on chapters when the user
   manually renamed one via the rename modal. Plan 74 added the re-upload
   diff flow but didn't account for `titleOverridden` carrying forward
   on the SAME numeric chapter id — if the new manuscript has a different
   chapter count (or chapters inserted / removed mid-book), the override
   silently lands on whatever new chapter shares that id, which is
   typically different content.

   This helper detects the cases that need user attention. v1 v1 scope
   surfaces the conflicts as a banner in the diff modal and drops the
   overrides automatically on apply (so the override doesn't mis-attribute
   the rename). Per-row keep/drop selection is deferred to a follow-up.

   Algorithm:
   - For each old chapter where `titleOverridden === true`:
     - Look up the new chapter at the same id (1-based).
     - If the new manuscript has no chapter at that position → conflict
       (the old override has nowhere to land).
     - If the new chapter's parsed title differs from the old chapter's
       current title (the rename) → conflict (the rename targeted
       different content). When titles match we treat it as continuity
       and leave the override alone.
   - Return conflict list with both sides for UI rendering. */

export interface ChapterLite {
  id: number;
  title: string;
  titleOverridden?: boolean;
}

export interface OverrideConflict {
  oldChapterId: number;
  oldTitle: string;
  /** -1 when the new manuscript has no chapter at this position. */
  newChapterId: number;
  /** "(removed)" when the new manuscript dropped this slot. */
  newTitle: string;
}

/* Quick-and-dirty client-side chapter-heading scan over a manuscript's
   source text. Used by the re-upload diff flow to provide a candidate
   chapter list BEFORE the server's authoritative parser runs at analyse
   time. Catches the common shapes — markdown `#`-prefixed headings and
   "Chapter N[: subtitle]" — which cover the cases that produce the
   override-conflict UX (user-edited markdown / pasted plaintext). When
   no headings match we fall back to a single synthetic Chapter 1 so the
   caller still has SOMETHING to compare against. */
export function scanCandidateChapters(sourceText: string): ChapterLite[] {
  const lines = sourceText.split(/\r?\n/);
  const chapters: ChapterLite[] = [];
  let nextId = 1;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const md = line.match(/^#{1,6}\s+(.+)$/);
    if (md) {
      chapters.push({ id: nextId++, title: md[1].trim() });
      continue;
    }
    const ch = line.match(/^Chapter\s+([0-9IVXLCDM]+)\s*[:.\-—]?\s*(.*)$/i);
    if (ch) {
      const title = ch[2].trim() ? `Chapter ${ch[1]}: ${ch[2].trim()}` : `Chapter ${ch[1]}`;
      chapters.push({ id: nextId++, title });
    }
  }
  if (chapters.length === 0) {
    chapters.push({ id: 1, title: 'Chapter 1' });
  }
  return chapters;
}

export function detectOverrideConflicts(
  oldChapters: ChapterLite[],
  newChapters: ChapterLite[],
): OverrideConflict[] {
  const conflicts: OverrideConflict[] = [];
  const byId = new Map<number, ChapterLite>();
  for (const ch of newChapters) byId.set(ch.id, ch);

  for (const old of oldChapters) {
    if (!old.titleOverridden) continue;
    const fresh = byId.get(old.id);
    if (!fresh) {
      conflicts.push({
        oldChapterId: old.id,
        oldTitle: old.title,
        newChapterId: -1,
        newTitle: '(removed)',
      });
      continue;
    }
    if (fresh.title !== old.title) {
      conflicts.push({
        oldChapterId: old.id,
        oldTitle: old.title,
        newChapterId: fresh.id,
        newTitle: fresh.title,
      });
    }
  }
  return conflicts;
}
