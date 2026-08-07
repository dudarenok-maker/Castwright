/* Presentational row component for a single server/sidecar config knob in
   the Advanced Settings UI. Pure props-and-callbacks — no slice access.
   The parent view wires this to the knob registry + change dispatch. */

import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { Checkbox } from '../primitives';
import type { GpuDevice, KnobDescriptor, KnobValue, StaleReason } from '../../lib/types';

// Peak VRAM footprint per device-typed engine (MB) — first-cut estimates per
// the design spec's §2.2 text, not measured; a false-positive warning here is
// low-cost (it's advisory, doesn't block the change) so precision isn't critical.
const ENGINE_PEAK_MB: Record<string, number> = {
  'tts.qwen.device': 6500,
  'tts.coqui.device': 3000,
  'tts.kokoro.device': 1000,
};

/* ── apply-mode pill label ───────────────────────────────────────────────── */

function applyLabel(apply: KnobDescriptor['apply']): string {
  switch (apply) {
    case 'live':
      return 'live';
    case 'restart-sidecar':
      return 'restart';
    case 'restart-server':
      return 'restart · app';
    case 'rebuild':
      return 'rebuilds env';
  }
}

/* Colour the apply pill: live = emerald, restart variants = amber, rebuild =
   rose (heaviest — it reinstalls the Python environment, not just a restart). */
function applyPillClasses(apply: KnobDescriptor['apply']): string {
  if (apply === 'live') {
    return 'bg-emerald-100 text-emerald-800';
  }
  if (apply === 'rebuild') {
    return 'bg-rose-100 text-rose-800';
  }
  return 'bg-amber-100 text-amber-800';
}

/* Text label for a device-knob stale_reason — carries the meaning itself so
   the badge isn't distinguished by colour alone (a11y §2.2). */
function staleReasonLabel(reason: StaleReason): string {
  switch (reason) {
    case 'cpu_fallback':
      return 'fell back to CPU';
    case 'uuid_unresolved':
      return 'card no longer found';
  }
}

/* ── editable input controls ─────────────────────────────────────────────── */

/* Revert / Reset section / Reset all need a blurring knob input to abandon
   (not commit) its edit. Two things can cause that blur, checked together:

   1. A MOUSE/pointer click: beginConfigAction() runs from onMouseDown,
      before onClick fires, and imperatively forces
      document.activeElement.blur(). This can't rely on the browser's own
      click-focuses-the-button behavior — WebKit (desktop Safari, and every
      iOS browser, which is WebKit under the hood) doesn't move focus to a
      <button> on click/tap the way Chromium/Firefox do, so no blur would
      fire there at all, and the abandoned edit would silently re-commit
      (recreating the override the click just cleared) on the row's next
      real blur. The imperative call sidesteps that entirely.
   2. KEYBOARD navigation (Tab) landing focus directly on the button: this
      IS a genuine browser focus() call in every engine (not subject to
      WebKit's click quirk), so the resulting blur's `relatedTarget`
      reliably identifies the button — checked via isConfigActionTarget.
      Without this, tabbing from a knob straight to its own Revert button
      (the common case, since Revert sits right after its knob in tab
      order) would commit the edit before Revert could abandon it.

   Only one element can be focused on the page at a time, so a single
   module-level flag for (1) — not per-row state — is enough. */
let abandonNextBlur = false;

const CONFIG_ACTION_SELECTOR = '[data-config-action]';

function isConfigActionTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(CONFIG_ACTION_SELECTOR) !== null;
}

export function beginConfigAction(scopedInput?: HTMLElement | null): void {
  // scopedInput, when passed (the row's own Revert button), only abandons
  // THAT row's input — clicking Row B's Revert must not silently discard
  // an unrelated Row A's in-progress edit just because Row A happens to
  // be what's currently focused. Reset section / Reset all don't have a
  // single row to scope to (they can legitimately affect many rows at
  // once), so they fall back to "whatever's currently focused."
  const target = scopedInput === undefined ? document.activeElement : scopedInput;
  if (!(target instanceof HTMLElement) || target !== document.activeElement) return;
  abandonNextBlur = true;
  target.blur();
  // Reset unconditionally: if the active element WAS a knob input, its
  // onBlur already consumed (and cleared) the flag synchronously inside
  // the .blur() call above. If it wasn't (nothing to abandon), this clears
  // the flag so it can't leak into some unrelated later blur.
  abandonNextBlur = false;
}

function shouldAbandonOnBlur(relatedTarget: EventTarget | null): boolean {
  const viaMouseDown = abandonNextBlur;
  abandonNextBlur = false;
  return viaMouseDown || isConfigActionTarget(relatedTarget);
}

/* ── save-error extraction (#2209) ───────────────────────────────────────── */

/** A rejected config save, distilled for display. `locked` marks the 409
    "this key is pinned in your environment" case — distinct from a
    rejected value (400, or anything else): the user needs to be told
    those two apart rather than shown one generic failure. */
export interface ConfigSaveError {
  status: number | null;
  locked: boolean;
  message: string;
}

/* configApiErrorMessage (lib/api.ts) wraps a non-2xx /api/config response
   as `Config ${action} failed (${status}): ${bodyText}` before throwing —
   ONE shared builder, called by realGetConfig ('fetch'), realPutConfig
   ('update'), AND realResetConfig ('reset'), so the three verbs cannot
   independently drift the way "update" vs "reset" already had (#2209
   review B1: this regex used to match "update" only, so every rejected
   Revert/Reset — which all go through api.resetConfig — rendered the raw
   wrapper text instead of the server's own message). `\w+` matches
   whichever verb actually failed. The route always replies with a JSON
   `{ error: string }` body on a 400/409 (server/src/routes/config.ts) —
   so bodyText is that JSON, verbatim. This pulls the server's own `error`
   string back out of the wrapper, rather than showing the wrapper text
   (or a generic "failed to save") verbatim. */
const WRAPPED_CONFIG_ERROR = /^Config \w+ failed \((\d+)\):\s*([\s\S]*)$/;

/* #2209 review "also fix" — an unparseable body can be a full HTML error
   page (a 500 from a proxy/middleware that never reached the JSON route
   handler at all); rendering that verbatim inside role="alert" is its own
   defect. Capped well past any real pair-rule message's length (#2180's
   longest is ~300 chars) so a genuine server message is never truncated. */
const MAX_SAVE_ERROR_MESSAGE_LENGTH = 500;

/** Trims, truncates, and — critically — replaces an EMPTY result with a
    real sentence: an empty body (`Config update failed (400): ` with
    nothing after the colon) previously produced `message: ''`, so the
    rendered row read "Couldn't save:" and nothing after it — turning this
    fix back into the exact silence it exists to close. */
function finalizeSaveErrorMessage(message: string, status: number | null): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return status === null
      ? "The server didn't say why."
      : `The server didn't say why (HTTP ${status}).`;
  }
  return trimmed.length > MAX_SAVE_ERROR_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_SAVE_ERROR_MESSAGE_LENGTH)}…`
    : trimmed;
}

/** Extract a displayable message + 409/other classification from a
    rejected saveOverride/resetKnob/resetGroup/resetAllConfig promise.
    `.unwrap()` re-throws RTK's SerializedError — a plain object, never a
    real Error instance — so this reads `.message` off either shape
    instead of relying on `instanceof Error`. */
export function describeConfigSaveError(reason: unknown): ConfigSaveError {
  const raw =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'object' && reason !== null && 'message' in reason
        ? String((reason as { message?: unknown }).message)
        : String(reason);

  const match = raw.match(WRAPPED_CONFIG_ERROR);
  if (!match) return { status: null, locked: false, message: finalizeSaveErrorMessage(raw, null) };

  const status = Number(match[1]);
  const body = match[2];
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      message = (parsed as { error: string }).error;
    }
  } catch {
    /* Not JSON (or an unexpected shape) — fall back to the raw body text,
       still more useful than the wrapper's "Config <action> failed (…)"
       prefix alone (capped below — the raw body can be an entire HTML
       error page). */
  }
  return { status, locked: status === 409, message: finalizeSaveErrorMessage(message, status) };
}

interface ControlProps {
  descriptor: KnobDescriptor;
  value: KnobValue;
  onChange: (raw: number | boolean | string) => void | Promise<unknown>;
  disabled: boolean;
  gpuDevices?: GpuDevice[];
  /** Exposes the number/string input's DOM node to OverrideRow's Revert
      button, so a click can scope its abandon-on-blur to THIS row's own
      input rather than whatever happens to be globally focused. Left
      unattached (stays null) for boolean/enum/device rows — they have no
      draft to abandon. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Reports the outcome of every save attempt this control makes —
      `null` to clear (a new attempt starting, or one that succeeded),
      or the extracted error when one is rejected. OverrideRow owns the
      state and renders it full-width below the control row (#2209). */
  onSaveErrorChange: (err: ConfigSaveError | null) => void;
  /** #2209 review B2 — OWNED BY OverrideRow, not this component: Revert
      (handleRevertClick, below) is a THIRD source of writes to this same
      row's saveError, alongside this component's own commitEdit/
      commitSimple, and all three must stomp on the same staleness clock
      or a stale rejection from any one of them can clobber a since-
      superseded outcome from either of the other two. Passing the ref
      down (rather than each side keeping its own) is what makes that a
      single shared clock instead of three independent ones. */
  generationRef: MutableRefObject<number>;
  /** id of the row's rendered error <p>, present only while one is shown
      — associates the control with it via aria-describedby (#2209 "also
      fix": screen-reader users tabbing back to the field previously got
      no indication anything had failed). */
  describedBy?: string;
  invalid: boolean;
}

function KnobControl({
  descriptor,
  value,
  onChange,
  disabled,
  gpuDevices,
  inputRef,
  onSaveErrorChange,
  generationRef,
  describedBy,
  invalid,
}: ControlProps) {
  const [footprintWarning, setFootprintWarning] = useState<string | null>(null);

  // Free-typed knobs (number/integer/string) get a local draft buffer,
  // committed via onChange (a network save) only on blur — not on every
  // keystroke. Firing saveOverride per character round-trips through Redux
  // (status flips to 'saving' synchronously, re-rendering every row off the
  // still-stale server value), so under real network latency a multi-digit
  // edit visibly reverts mid-keystroke. Select/checkbox/device rows are
  // single discrete actions and are unaffected.
  const [draft, setDraft] = useState(() => String(value.effective));
  const [editing, setEditing] = useState(false);
  // Read inside the effect via a ref, NOT as a dependency: the commit
  // handlers below call setEditing(false) in the same tick as dispatching
  // the save, before the save has resolved. If `editing` were a dependency,
  // that transition alone would re-run this effect against the still-stale
  // (pre-save) `value.effective` and snap the draft back to the OLD value
  // for the one render before the save resolves — reproducing the exact
  // revert-flash this component exists to prevent. Depending on
  // `value.effective` alone means this only resyncs when the server value
  // itself actually changes (a real Revert/Reset, or another tab's edit).
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Bumped whenever this field's ground truth could have moved on without
  // this specific commit's involvement: either a newer local commit (via
  // commitEdit, below) or value.effective itself changing for ANY other
  // reason (a Revert/Reset on this same field, another tab's edit, etc. —
  // the effect below bumps it on every value.effective change). A
  // rejection handler only reverts the draft if the generation is still
  // exactly what it was when THAT commit started — otherwise something
  // has already superseded it, and stomping the draft with this stale
  // save's pre-edit value would clobber whatever's now actually correct.
  // editingRef alone isn't enough: it doesn't cover a same-field Revert/
  // Reset landing while the original save is still in flight (no local
  // re-edit happens in that case, so editingRef never blocks it), and a
  // bare "did a newer local commit happen" counter alone doesn't cover
  // it either (nothing local happened — the field's truth moved out from
  // under it via an external reset instead). Owned by OverrideRow and
  // passed down as a prop (#2209 review B2) — Revert's own
  // handleRevertClick bumps and checks this SAME ref, so a stale
  // rejection from either side can't clobber the other's outcome.

  useEffect(() => {
    generationRef.current += 1;
    if (!editingRef.current) setDraft(String(value.effective));
    // value.effective moving — for ANY reason (this row's own successful
    // save, a Revert/Reset, or another tab's edit) — means whatever this
    // row was showing an error about is no longer current. #2209 req 4:
    // a stale error next to a control that now works is its own defect.
    onSaveErrorChange(null);
  }, [value.effective, onSaveErrorChange]);

  // Discard whatever's in the field without saving it — used when blur was
  // triggered by beginConfigAction() (a Revert/Reset click) rather than the
  // user genuinely moving on to another field.
  const abandonEdit = () => {
    setEditing(false);
    setDraft(String(value.effective));
  };

  // Shared by both commit paths below. A rejected save leaves the redux
  // value untouched (config-slice's `rejected` case doesn't touch
  // `values`), so the draft would otherwise stay frozen on the unsaved
  // value forever with no visible sign the save never landed — fall back
  // to the last known-good value. Guarded two ways, both required (see
  // generationRef's own comment for why neither alone is sufficient).
  const commitEdit = (parsed: number | string) => {
    const revertTo = String(value.effective);
    onSaveErrorChange(null);
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const result = onChange(parsed);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((reason: unknown) => {
        if (!editingRef.current && generationRef.current === myGeneration) setDraft(revertTo);
        // #2209 — surface the rejection too, guarded by the SAME
        // staleness check as the draft-revert above: don't show this
        // attempt's error next to a row a newer attempt (or an external
        // Revert/Reset) has already superseded.
        if (generationRef.current === myGeneration) onSaveErrorChange(describeConfigSaveError(reason));
      });
    }
  };

  /* Shared by the boolean/enum/device controls below — none of them buffer
     a local draft to revert on failure (value.effective is already their
     source of truth either way), but a rejection still needs reporting —
     #2209. Same generation-staleness guard as commitEdit's rejection
     handler, for the same reason: a rapid second change to the same
     control must not let the FIRST attempt's late rejection overwrite the
     second attempt's own (possibly successful) outcome. */
  const commitSimple = (next: number | boolean | string) => {
    onSaveErrorChange(null);
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const result = onChange(next);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((reason: unknown) => {
        if (generationRef.current === myGeneration) onSaveErrorChange(describeConfigSaveError(reason));
      });
    }
  };

  const commitNumericDraft = (raw: string, isInteger: boolean) => {
    setEditing(false);
    const parsed = isInteger ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value.effective));
      return;
    }
    // Tabbing (or clicking elsewhere) blurs whatever field focus is
    // currently sitting in, even one the user never touched — e.g. focus
    // landing on the NEXT row after Tab-ing out of the one actually being
    // edited. Only commit when the value actually changed, so merely
    // passing focus through a field can't fire a no-op save that marks it
    // overridden.
    if (parsed === Number(value.effective)) return;
    commitEdit(parsed);
  };

  const commitStringDraft = (raw: string) => {
    setEditing(false);
    if (raw === String(value.effective)) return;
    commitEdit(raw);
  };

  const base =
    'px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink ' +
    'focus:outline-hidden focus:ring-2 focus:ring-magenta/30 ' +
    'disabled:bg-ink/3 disabled:text-ink/50 disabled:cursor-not-allowed ' +
    'min-h-[44px] fine-pointer:min-h-0';

  if (descriptor.type === 'boolean') {
    return (
      <Checkbox
        checked={Boolean(value.effective)}
        disabled={disabled}
        onChange={(next) => commitSimple(next)}
        label={value.effective ? 'Enabled' : 'Disabled'}
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    );
  }

  if (descriptor.type === 'enum') {
    return (
      <select
        aria-label={descriptor.label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={String(value.effective)}
        disabled={disabled}
        onChange={(e) => commitSimple(e.target.value)}
        className={`w-full ${base}`}
      >
        {(descriptor.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (descriptor.type === 'device') {
    const current = String(value.effective);
    // idx:-1 is the synthetic "unindexed (cpu / ORT / CT2)" entry the server
    // appends so a cpu_fallback badge has somewhere to attach (gpu-devices.ts)
    // — it's not a real, pinnable card and must never become a `cuda:-1` option.
    const cudaOptions = (gpuDevices ?? []).filter((d) => d.idx >= 0).map((d) => `cuda:${d.idx}`);
    // 'mps' (Apple Silicon) isn't enumerable via GET /api/gpu/devices (CUDA-only
    // probe), but the sidecar's device grammar accepts it for all three knobs —
    // keep it a static, always-offered option rather than dropping it.
    const options = ['auto', 'cpu', 'mps', ...cudaOptions];
    // A stale/manually-set value (e.g. a card that vanished) stays selectable
    // rather than silently jumping to whatever option happens to be first.
    if (!options.includes(current)) options.push(current);

    return (
      <div>
        <select
          aria-label={descriptor.label}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={current}
          disabled={disabled}
          onChange={(e) => {
            const selected = e.target.value;
            const device = (gpuDevices ?? []).find((d) => `cuda:${d.idx}` === selected);
            const peak = ENGINE_PEAK_MB[descriptor.key];
            if (device && peak && device.free_mb < peak) {
              setFootprintWarning(
                `${device.name} may not have enough free VRAM (${device.free_mb} MB free, ~${peak} MB typically needed).`,
              );
            } else {
              setFootprintWarning(null);
            }
            commitSimple(selected);
          }}
          className={`w-full ${base}`}
        >
          {options.map((opt) => {
            const device = (gpuDevices ?? []).find((d) => `cuda:${d.idx}` === opt);
            const label = device ? `${opt} — ${device.name} (${device.free_mb} MB free)` : opt;
            return (
              <option key={opt} value={opt}>
                {label}
              </option>
            );
          })}
        </select>
        {footprintWarning && (
          <p className="text-xs text-amber-700 mt-1" role="status">{footprintWarning}</p>
        )}
      </div>
    );
  }

  if (descriptor.type === 'number' || descriptor.type === 'integer') {
    const isInteger = descriptor.type === 'integer';
    return (
      <input
        ref={inputRef}
        type="number"
        aria-label={descriptor.label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={draft}
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step ?? (isInteger ? 1 : undefined)}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) =>
          shouldAbandonOnBlur(e.relatedTarget)
            ? abandonEdit()
            : commitNumericDraft(e.target.value, isInteger)
        }
        className={`w-32 ${base}`}
      />
    );
  }

  /* string */
  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={descriptor.label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      value={draft}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) =>
        shouldAbandonOnBlur(e.relatedTarget) ? abandonEdit() : commitStringDraft(draft)
      }
      className={`w-full ${base}`}
    />
  );
}

/* ── OverrideRow ─────────────────────────────────────────────────────────── */

export interface OverrideRowProps {
  descriptor: KnobDescriptor;
  value: KnobValue;
  onChange: (raw: number | boolean | string) => void | Promise<unknown>;
  /** Revert is a config save too — POST /api/config/reset can 400 (the
      same cross-field pair rule PUT enforces), so its rejection needs the
      same surfacing as onChange's (#2209 follow-up). **Not** 409: the
      reset route has no env-locked check at all (that guard lives only in
      the PUT handler, config.ts:97), and a locked row never renders this
      button in the first place ({!locked && value.overridden} below) — so
      the 409/"pinned in your environment" copy is reachable through
      onChange but structurally unreachable through this prop. (An
      earlier version of this comment claimed 409 was reachable here too;
      it wasn't — corrected in review, #2209 B1.) */
  onRevert: () => void | Promise<unknown>;
  /** GPU cards detected via GET /api/gpu/devices — only consumed by type: 'device' knobs. */
  gpuDevices?: GpuDevice[];
}

export function OverrideRow({ descriptor, value, onChange, onRevert, gpuDevices }: OverrideRowProps) {
  const locked = value.locked;
  const inputRef = useRef<HTMLInputElement | null>(null);
  // #2209 — per-ROW error state: this is a fresh useState per rendered
  // OverrideRow instance (one per descriptor.key, keyed in the parent's
  // .map()), so two rows failing in sequence can never blank or overwrite
  // each other's message the way a single shared slice field would.
  const [saveError, setSaveError] = useState<ConfigSaveError | null>(null);
  const errorId = `knob-save-error-${descriptor.key}`;

  // #2209 review B2 — ONE staleness clock shared by every write this row
  // can make: KnobControl's own commitEdit/commitSimple (passed down as a
  // prop, below) AND this component's own handleRevertClick. Before this
  // fix each side tracked its own, so a slow Revert whose OWN rejection
  // arrived after a newer save had already succeeded still rendered its
  // stale message beside a control that now works — and the reverse: a
  // slow save's stale rejection could clobber a Revert's own outcome.
  const generationRef = useRef(0);

  // A successful Revert changes value.effective, which KnobControl's own
  // [value.effective] effect already treats as "clear this row's error
  // AND bump the shared generation" (onSaveErrorChange(null), passed
  // through as setSaveError below) — so only the REJECTED case needs
  // handling here: resetKnob.rejected leaves `values` untouched
  // (config-slice, mirroring saveOverride.rejected), so nothing else will
  // clear or set this row's error for a failed Revert.
  const handleRevertClick = () => {
    setSaveError(null);
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const result = onRevert();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((reason: unknown) => {
        if (generationRef.current === myGeneration) setSaveError(describeConfigSaveError(reason));
      });
    }
  };

  return (
    <div className="py-3 border-b border-ink/8 last:border-b-0">
      {/* Header row: label + apply pill (+ env pill when locked) */}
      <div className="flex items-start gap-2 flex-wrap mb-1">
        <span className="text-sm font-medium text-ink flex-1">{descriptor.label}</span>

        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          {locked ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink/8 text-ink/60 text-[11px] font-semibold">
              .env
            </span>
          ) : (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${applyPillClasses(descriptor.apply)}`}
            >
              {applyLabel(descriptor.apply)}
            </span>
          )}
          {value.staleReason && (
            <span
              data-testid="stale-reason-badge"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-semibold"
            >
              {staleReasonLabel(value.staleReason)}
            </span>
          )}
        </div>
      </div>

      {/* Help text */}
      <p className="text-xs text-ink/55 mb-2">{descriptor.help}</p>

      {/* Control row */}
      <div className="flex items-center gap-3 flex-wrap">
        <KnobControl
          descriptor={descriptor}
          value={value}
          onChange={onChange}
          disabled={locked}
          gpuDevices={gpuDevices}
          inputRef={inputRef}
          onSaveErrorChange={setSaveError}
          generationRef={generationRef}
          describedBy={saveError ? errorId : undefined}
          invalid={Boolean(saveError)}
        />

        {/* Env-locked indicator */}
        {locked && (
          <span className="text-xs text-ink/55 flex items-center gap-1">
            <span>🔒</span>
            <span>set in .env</span>
          </span>
        )}

        {/* Revert button + default value — only when overridden and not locked */}
        {!locked && value.overridden && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink/50">
              default: <span className="font-mono">{String(descriptor.default)}</span>
            </span>
            <button
              type="button"
              /* See beginConfigAction/isConfigActionTarget above — abandons
                 rather than commits whatever's mid-edit in the row's own
                 input, whether reached by mouse or by Tab. Scoped to
                 THIS row's own input (inputRef), not "whatever's globally
                 focused" — clicking one row's Revert must not silently
                 discard an unrelated row's in-progress edit. */
              data-config-action
              onMouseDown={() => beginConfigAction(inputRef.current)}
              onClick={handleRevertClick}
              className="px-2.5 py-1 rounded-lg border border-ink/15 bg-white text-xs text-ink/70 hover:bg-ink/4 min-h-[44px] fine-pointer:min-h-0"
            >
              Revert
            </button>
          </div>
        )}
      </div>

      {/* Save-error region — full width so a long #2180 pair-rule message
          wraps cleanly rather than getting squeezed against the Revert
          button, and stays readable at <640px (mobile protocol). */}
      {saveError && (
        <p
          id={errorId}
          role="alert"
          data-testid={errorId}
          className={`mt-1.5 text-xs ${saveError.locked ? 'text-amber-800' : 'text-rose-700'}`}
        >
          {saveError.locked
            ? `This is pinned in your environment and can't be changed here. (${saveError.message})`
            : `Couldn't save: ${saveError.message}`}
        </p>
      )}
    </div>
  );
}
