import { useState, type ReactNode } from 'react';
import { CHAR_COLORS, shade } from '../lib/colors';
import { IconArrow, IconLink, IconPlay, IconSparkle, IconSpinner } from '../lib/icons';
import type { CharColor, Voice } from '../lib/types';

type ButtonVariant = 'dark' | 'light' | 'ghost' | 'danger' | 'peach';
type ButtonSize = 'sm' | 'md';

interface PrimaryButtonProps {
  children: ReactNode;
  variant?: ButtonVariant;
  onClick?: () => void;
  icon?: boolean;
  size?: ButtonSize;
  disabled?: boolean;
}
export function PrimaryButton({
  children,
  variant = 'dark',
  onClick,
  icon = true,
  size = 'md',
  disabled = false,
}: PrimaryButtonProps) {
  const styles: Record<ButtonVariant, string> = {
    dark: 'bg-ink text-canvas hover:bg-ink-soft',
    light: 'bg-canvas text-ink hover:bg-white',
    ghost: 'bg-transparent text-ink border border-ink/15 hover:bg-ink/5',
    danger: 'bg-magenta text-white hover:opacity-90',
    peach: 'bg-peach text-ink hover:bg-peach/90',
  };
  const sizing = size === 'sm' ? 'pl-3.5 pr-1 py-1 text-xs' : 'pl-5 pr-1.5 py-1.5 text-sm';
  const dot = size === 'sm' ? 'w-5 h-5' : 'w-7 h-7';
  const disabledCls = disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : '';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-full font-medium transition-colors ${sizing} ${styles[variant]} ${disabledCls}`}
    >
      <span>{children}</span>
      {icon && (
        <span className={`grid place-items-center rounded-full bg-white/15 ${dot}`}>
          <IconArrow className="w-3.5 h-3.5" />
        </span>
      )}
    </button>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block px-3 py-1 rounded-full border border-ink/10 text-xs font-medium text-ink/80 bg-white">
      {children}
    </span>
  );
}

interface MixedHeadingProps {
  regular: ReactNode;
  bold?: ReactNode;
  level?: 'h1' | 'h2' | 'h3';
  className?: string;
}
export function MixedHeading({ regular, bold, level = 'h2', className = '' }: MixedHeadingProps) {
  const sizing = level === 'h1' ? 'text-3xl md:text-4xl lg:text-5xl' : 'text-2xl md:text-3xl';
  const Tag = level;
  return (
    <Tag className={`${sizing} font-medium leading-[1.1] tracking-tight text-ink ${className}`}>
      {regular} {bold && <span className="font-bold">{bold}</span>}
    </Tag>
  );
}

interface AvatarProps {
  name: string;
  color?: CharColor;
  size?: number;
}
export function Avatar({ name, color = 'narrator', size = 36 }: AvatarProps) {
  const initials = name
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const c = CHAR_COLORS[color] ?? CHAR_COLORS.narrator;
  return (
    <div
      className="rounded-full grid place-items-center text-white font-semibold shrink-0"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${c.hex}, ${shade(c.hex, -25)})`,
        fontSize: size * 0.36,
      }}
    >
      {initials}
    </div>
  );
}

export function ColorDot({ color, size = 10 }: { color?: CharColor; size?: number }) {
  const c = CHAR_COLORS[color ?? 'narrator'] ?? CHAR_COLORS.narrator;
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: c.hex }}
    />
  );
}

interface VoiceSwatchProps {
  voice?: Voice | null;
  size?: 'sm' | 'md' | 'lg';
  selected?: boolean;
  showLabel?: boolean;
  onSelect?: (id?: string) => void;
  /* Sample is being generated for this swatch. Forces the play overlay
     visible with a spinner in place of the play icon so the user gets
     immediate feedback after clicking — same affordance as the row-level
     "Generating…" pill, but on the swatch itself for parity wherever this
     primitive renders. Pointer events are suppressed so the busy state
     can't fire a second concurrent request. */
  loading?: boolean;
}
export function VoiceSwatch({
  voice,
  size = 'md',
  selected = false,
  showLabel = true,
  onSelect,
  loading = false,
}: VoiceSwatchProps) {
  const [hovered, setHovered] = useState(false);
  const dim = { sm: 36, md: 64, lg: 96 }[size];
  const ringSize = dim + 10;
  const [from, to] = voice?.gradient ?? ['#A43C6C', '#3C194F'];
  const overlayVisible = loading || hovered;
  const accessibleLabel = onSelect
    ? loading
      ? `Generating sample for ${voice?.character ?? 'voice'}`
      : `Play sample for ${voice?.character ?? 'voice'}`
    : undefined;
  return (
    <div className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={() => onSelect?.(voice?.id)}
        disabled={loading}
        aria-busy={loading || undefined}
        aria-label={accessibleLabel}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`relative inline-grid place-items-center transition-transform hover:scale-[1.02] ${loading ? 'cursor-wait' : ''}`}
        style={{ width: ringSize, height: ringSize }}
      >
        <span
          className={`absolute inset-0 rounded-full transition-opacity ring-peach-2 ${selected ? 'opacity-100' : 'opacity-0'}`}
        />
        <span
          className="rounded-full shadow-[0_8px_24px_rgba(15,14,13,0.12)] relative overflow-hidden"
          style={{
            width: dim,
            height: dim,
            background: `radial-gradient(circle at 30% 30%, ${from}, ${to})`,
          }}
        >
          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full opacity-40">
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="white"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
          </svg>
          <span
            className={`absolute inset-0 grid place-items-center bg-ink/35 transition-opacity ${overlayVisible ? 'opacity-100' : 'opacity-0'}`}
          >
            {loading ? (
              <IconSpinner className="w-5 h-5 text-white" />
            ) : (
              <IconPlay className="w-5 h-5 text-white" />
            )}
          </span>
        </span>
      </button>
      {showLabel && voice && (
        <div className="mt-2">
          <p className="text-sm font-semibold text-ink leading-tight">{voice.character}</p>
        </div>
      )}
    </div>
  );
}

type PillColor = 'neutral' | 'success' | 'warning' | 'danger' | 'peach' | 'library';
export function Pill({ children, color = 'neutral' }: { children: ReactNode; color?: PillColor }) {
  const map: Record<PillColor, string> = {
    neutral: 'bg-ink/4 text-ink/70 border-ink/10',
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    danger: 'bg-rose-50 text-rose-700 border-rose-200',
    peach: 'bg-peach/15 text-magenta border-peach/30',
    library: 'bg-purple-deep/6 text-purple-deep border-purple-deep/15',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${map[color]}`}
    >
      {children}
    </span>
  );
}

/* Small provenance badge — sits beside the lifecycle status pill (the "tag")
   to mark a character whose voice was carried from a prior book in the
   series. Orthogonal to the lifecycle state (Designed/Generated/Tuned/Locked)
   so both can show at once. Deliberately lighter-weight than `Pill` (smaller
   text, no border) so it reads as a secondary marker, not a second tag. */
export function CarriedBadge() {
  return (
    <span
      data-testid="reused-badge"
      title="Voice carried from a prior book in this series"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-purple-deep/70 bg-purple-deep/4"
    >
      <IconLink className="w-2.5 h-2.5" />
      Carried
    </span>
  );
}

/* fs-25 — additive capability marker shown under a Qwen character's voice
   label when it has ≥1 designed emotion variant. Composes with (never
   replaces) the lifecycle pill + Reused badge. */
export function VariantsBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="variants-badge"
      title={`${count} emotion ${count === 1 ? 'variant' : 'variants'} designed`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-magenta/80 bg-magenta/5"
    >
      <IconSparkle className="w-2.5 h-2.5" />
      {count > 1 ? `Variants · ${count}` : 'Variants'}
    </span>
  );
}

/* fe-34 — warning sibling of VariantsBadge: shown on a designed Qwen voice card
   when the character speaks in-use emotions that have no designed variant yet
   (count from `missingVariantCountByVoiceId`). Mirrors the cast view's amber
   "N tags need a variant" row badge so both surfaces signal the same gap. */
export function NeedsVariantsBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="needs-variants-badge"
      title={`${count} in-use ${count === 1 ? 'emotion' : 'emotions'} still ${count === 1 ? 'needs' : 'need'} a designed variant`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-amber-700 bg-amber-500/10"
    >
      <IconSparkle className="w-2.5 h-2.5" />
      Needs · {count}
    </span>
  );
}

/* Coming-soon affordance for still-mocked sections (listener-app cards,
   download tiles, export-queue rows). Sits in the title row of each card
   and pairs with disabled action buttons so smoke passes can't mistake demo
   UI for shipped behaviour. */
export function ComingSoonBadge({ label = 'Soon' }: { label?: string }) {
  return (
    <span
      data-testid="coming-soon-badge"
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-peach/20 text-magenta border border-peach/40"
    >
      {label}
    </span>
  );
}
