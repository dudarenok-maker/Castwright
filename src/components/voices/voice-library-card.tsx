/* fs-38 Wave 1, Task 15 — VoiceLibraryCard.

   Presents one "My voices" library entry: name, inline tag editor (add on
   Enter / remove on ×), pin toggle, language chip, per-engine readiness chip
   (from `entry.engines.qwen.status`), a preview-play button (calls
   `api.sampleLibraryVoice`), and a quiet provenance marker. Tag/pin edits
   dispatch the Task 13 `patchEntry` thunk directly — it's optimistic, so the
   slice applies the patch to the matching entry immediately. Assign/Edit are
   left to the parent via callback props: Task 16 wires the assign-to-
   character picker onto `onAssign`; `MyVoicesSection` wires `onEdit` to open
   `RedesignLibraryVoiceModal`. */

import { useState } from 'react';
import { useAppDispatch } from '../../store';
import { patchEntry, revokeVoice, type VoiceLibraryEntry } from '../../store/voice-library-slice';
import { Pill } from '../primitives';
import { IconStar, IconPlay, IconPause, IconSpinner, IconClose, IconWarning } from '../../lib/icons';
import { useSamplePlayback } from '../../lib/use-sample-playback';
import { api } from '../../lib/api';
import { VoiceProvenanceBadge } from './voice-provenance-badge';
import { ConfirmDialog } from '../../modals/confirm-dialog';

interface Props {
  entry: VoiceLibraryEntry;
  onAssign?: (entry: VoiceLibraryEntry) => void;
  onEdit?: (entry: VoiceLibraryEntry) => void;
}

type QwenStatus = 'ready' | 'deriving' | 'stale' | 'failed';

const ENGINE_STATUS_LABEL: Record<QwenStatus, string> = {
  ready: 'Qwen ✓',
  deriving: 'Qwen …',
  stale: 'Qwen ⟳',
  failed: 'Qwen ⚠',
};

const ENGINE_STATUS_COLOR: Record<QwenStatus, 'success' | 'neutral' | 'warning' | 'danger'> = {
  ready: 'success',
  deriving: 'neutral',
  stale: 'warning',
  failed: 'danger',
};

/* fs-38 Wave 3b2, Task 9 — the server now resolves a cloned voice's Qwen
   model per-chapter and fails loud when it's Broken (see task-9-brief.md).
   Derive the same state here so the My-voices card can warn the user before
   they hit it at render time. Repairable self-heals at next render (a fresh
   derive request), so it's a softer signal than Broken. */
type ClonedVoiceState = 'broken' | 'repairable' | null;

export function deriveClonedVoiceState(entry: VoiceLibraryEntry): ClonedVoiceState {
  if (entry.consent?.revokedAt || !entry.master || entry.engines.qwen?.status === 'failed') {
    return 'broken';
  }
  if (entry.engines.qwen?.status === 'stale') {
    return 'repairable';
  }
  return null;
}

export function VoiceLibraryCard({ entry, onAssign, onEdit }: Props) {
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const [tagDraft, setTagDraft] = useState('');
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);

  const qwenStatus = entry.engines.qwen?.status;
  const playing = playback.isPlaying && !!sampleUrl && playback.currentUrl === sampleUrl;

  function addTag() {
    const tag = tagDraft.trim();
    if (!tag || entry.tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    void dispatch(
      patchEntry({ voiceUuid: entry.voiceUuid, patch: { tags: [...entry.tags, tag] } }),
    );
    setTagDraft('');
  }

  function removeTag(tag: string) {
    void dispatch(
      patchEntry({
        voiceUuid: entry.voiceUuid,
        patch: { tags: entry.tags.filter((t) => t !== tag) },
      }),
    );
  }

  function togglePin() {
    void dispatch(patchEntry({ voiceUuid: entry.voiceUuid, patch: { pinned: !entry.pinned } }));
  }

  function confirmRevoke() {
    setConfirmRevokeOpen(false);
    void dispatch(revokeVoice(entry.voiceUuid));
  }

  async function playSample() {
    if (playing) {
      playback.stop();
      return;
    }
    setSampleError(null);
    setSampleLoading(true);
    try {
      const { url } = await api.sampleLibraryVoice(entry.voiceUuid);
      setSampleUrl(url);
      await playback.play(url);
    } catch (e) {
      setSampleError((e as Error).message || 'Preview failed.');
    } finally {
      setSampleLoading(false);
    }
  }

  return (
    <div
      data-testid={`voice-library-card-${entry.voiceUuid}`}
      className="rounded-2xl border border-ink/10 bg-white p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-ink truncate">{entry.name}</p>
          <ProvenanceMarker entry={entry} />
        </div>
        <button
          type="button"
          onClick={togglePin}
          aria-label={entry.pinned ? 'Unpin voice' : 'Pin voice'}
          aria-pressed={entry.pinned}
          data-testid={`voice-library-pin-${entry.voiceUuid}`}
          className={`w-8 h-8 grid place-items-center rounded-full transition-colors shrink-0 min-h-[44px] min-w-[44px] fine-pointer:min-h-0 fine-pointer:min-w-0 ${entry.pinned ? 'bg-peach text-ink' : 'text-ink/30 hover:text-ink hover:bg-ink/6'}`}
        >
          <IconStar className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {entry.languageCode && (
          <Pill color="neutral">
            <span data-testid={`voice-library-language-${entry.voiceUuid}`}>
              {entry.languageCode}
            </span>
          </Pill>
        )}
        {qwenStatus && (
          <Pill color={ENGINE_STATUS_COLOR[qwenStatus]}>
            <span data-testid={`voice-library-engine-qwen-${entry.voiceUuid}`}>
              {ENGINE_STATUS_LABEL[qwenStatus]}
            </span>
          </Pill>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {entry.tags.map((tag) => (
          <span
            key={tag}
            data-testid={`voice-library-tag-${entry.voiceUuid}-${tag}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-ink/4 text-ink/70 border border-ink/10"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
              data-testid={`voice-library-tag-remove-${entry.voiceUuid}-${tag}`}
              className="text-ink/40 hover:text-ink"
            >
              <IconClose className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder="Add tag…"
          aria-label={`Add a tag to ${entry.name}`}
          data-testid={`voice-library-tag-input-${entry.voiceUuid}`}
          className="min-w-[80px] flex-1 px-2 py-0.5 rounded-full text-[11px] bg-canvas border border-dashed border-ink/15 focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void playSample()}
          disabled={sampleLoading}
          aria-label={playing ? 'Stop preview' : 'Play preview'}
          data-testid={`voice-library-play-${entry.voiceUuid}`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta disabled:opacity-50 disabled:cursor-wait transition-colors min-h-[44px] fine-pointer:min-h-0"
        >
          {sampleLoading ? (
            <IconSpinner className="w-3 h-3" />
          ) : playing ? (
            <IconPause className="w-3 h-3" />
          ) : (
            <IconPlay className="w-3 h-3" />
          )}
          <span>{sampleLoading ? 'Loading…' : playing ? 'Stop' : 'Preview'}</span>
        </button>
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(entry)}
            data-testid={`voice-library-edit-${entry.voiceUuid}`}
            className="px-3 py-1.5 rounded-full text-xs font-semibold text-ink/70 hover:text-ink hover:bg-ink/6 transition-colors min-h-[44px] fine-pointer:min-h-0"
          >
            Edit
          </button>
        )}
        {onAssign && (
          <button
            type="button"
            onClick={() => onAssign(entry)}
            data-testid={`voice-library-assign-${entry.voiceUuid}`}
            className="ml-auto px-3 py-1.5 rounded-full text-xs font-semibold text-ink/70 hover:text-ink hover:bg-ink/6 transition-colors min-h-[44px] fine-pointer:min-h-0"
          >
            Assign
          </button>
        )}
        {entry.provenance === 'cloned' && (
          <button
            type="button"
            onClick={() => setConfirmRevokeOpen(true)}
            data-testid={`voice-library-revoke-${entry.voiceUuid}`}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold text-red-600/90 hover:bg-red-600/10 transition-colors min-h-[44px] fine-pointer:min-h-0 ${onAssign ? '' : 'ml-auto'}`}
          >
            Revoke
          </button>
        )}
      </div>
      {sampleError && (
        <p
          className="text-[11px] text-red-600/90 font-medium"
          data-testid={`voice-library-play-error-${entry.voiceUuid}`}
        >
          ⚠ {sampleError}
        </p>
      )}
      {/* User-directed fix (fs-38 Wave 3b2) — revoke now also erases the
          person's original recording, an irreversible action, so it gets a
          real two-step confirm (matching the app's other destructive-action
          dialogs, e.g. library-grid's book delete) instead of the previous
          window.confirm. The copy states every consequence up front: the
          voice stops working, the recording + everything derived from it is
          gone for good, it can't be undone, and any character currently cast
          to it will fail to render until reassigned. */}
      <ConfirmDialog
        open={confirmRevokeOpen}
        eyebrow="Revoke"
        title={`Revoke "${entry.name}"?`}
        icon={<IconWarning className="w-4 h-4" />}
        variant="danger"
        body={
          <div className="space-y-2">
            <p>
              &ldquo;{entry.name}&rdquo; will stop working immediately — it can no longer be used
              or played.
            </p>
            <p>
              The original recording and everything derived from it are permanently deleted.
            </p>
            <p>
              Any character currently cast to &ldquo;{entry.name}&rdquo; will fail to render
              until reassigned to another voice.
            </p>
            <p className="text-red-700/80 font-medium">This can&rsquo;t be undone.</p>
          </div>
        }
        confirmLabel="Revoke & delete recording"
        onConfirm={confirmRevoke}
        onClose={() => setConfirmRevokeOpen(false)}
      />
    </div>
  );
}

/* Quiet provenance marker — all three branches land now (task-15 brief),
   though only `designed` was exercised in Wave 1. `cloned` lands with
   Task 13 (badge + consent summary); `imported` still arrives with
   import. */
function ProvenanceMarker({ entry }: { entry: VoiceLibraryEntry }) {
  switch (entry.provenance) {
    case 'designed':
      return (
        <p
          data-testid={`voice-library-provenance-${entry.voiceUuid}`}
          className="text-[10px] uppercase tracking-wide text-ink/40 font-semibold"
        >
          My voice
        </p>
      );
    case 'cloned': {
      const clonedState = deriveClonedVoiceState(entry);
      return (
        <span
          data-testid={`voice-library-provenance-${entry.voiceUuid}`}
          className="inline-flex items-center gap-2 text-xs text-ink/70"
        >
          <VoiceProvenanceBadge slot={{ name: '', provenance: 'cloned' }} />
          {entry.consent && (
            <span>
              {entry.consent.personName} · {entry.consent.relationship}
            </span>
          )}
          {clonedState && (
            <Pill color={clonedState === 'broken' ? 'danger' : 'warning'}>
              <span data-testid={`voice-library-clonestate-${entry.voiceUuid}`}>
                {clonedState === 'broken' ? 'Needs attention' : 'Will re-derive'}
              </span>
            </Pill>
          )}
        </span>
      );
    }
    case 'imported':
      // Wave 3 — imported-voice provenance treatment lands with import.
      return null;
  }
}
