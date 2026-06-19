import type { SVGProps, ReactNode } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

const Svg = (path: ReactNode, props: IconProps = {}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    {path}
  </svg>
);

export const IconArrow = (p: IconProps) => Svg(<path d="M5 12h14M13 5l7 7-7 7" />, p);
export const IconArrowDn = (p: IconProps) => Svg(<path d="M6 9l6 6 6-6" />, p);
export const IconChevR = (p: IconProps) => Svg(<path d="M9 6l6 6-6 6" />, p);
export const IconCheck = (p: IconProps) => Svg(<path d="M20 6L9 17l-5-5" />, p);
export const IconClose = (p: IconProps) => Svg(<path d="M18 6L6 18M6 6l12 12" />, p);
export const IconMenu = (p: IconProps) => Svg(<path d="M4 6h16M4 12h16M4 18h16" />, p);
export const IconSearch = (p: IconProps) =>
  Svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
    p,
  );
export const IconFilter = (p: IconProps) => Svg(<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />, p);
export const IconMore = (p: IconProps) =>
  Svg(
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>,
    p,
  );
export const IconPlay = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M8 5v14l11-7z" />
  </svg>
);
export const IconPause = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
  </svg>
);
export const IconPlus = (p: IconProps) => Svg(<path d="M12 5v14M5 12h14" />, p);
export const IconWarning = (p: IconProps) =>
  Svg(
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>,
    p,
  );
export const IconSpinner = (p: IconProps) => (
  <svg viewBox="0 0 24 24" {...p}>
    <circle
      cx="12"
      cy="12"
      r="9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      opacity="0.2"
    />
    <path
      d="M21 12a9 9 0 00-9-9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <animateTransform
        attributeName="transform"
        type="rotate"
        from="0 12 12"
        to="360 12 12"
        dur="0.9s"
        repeatCount="indefinite"
      />
    </path>
  </svg>
);
export const IconWaveform = (p: IconProps) =>
  Svg(<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h2" />, p);
export const IconUpload = (p: IconProps) =>
  Svg(
    <>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </>,
    p,
  );
export const IconLock = (p: IconProps) =>
  Svg(
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </>,
    p,
  );
export const IconRefresh = (p: IconProps) =>
  Svg(
    <>
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>,
    p,
  );
export const IconDrag = (p: IconProps) =>
  Svg(
    <>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </>,
    p,
  );
export const IconBook = (p: IconProps) =>
  Svg(
    <>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </>,
    p,
  );
export const IconLink = (p: IconProps) =>
  Svg(
    <>
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07L11.71 5.24" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.76-1.71" />
    </>,
    p,
  );
export const IconStar = (p: IconProps) =>
  Svg(
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z" />,
    p,
  );
export const IconChevL = (p: IconProps) => Svg(<path d="M15 6l-6 6 6 6" />, p);
export const IconDownload = (p: IconProps) =>
  Svg(
    <>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </>,
    p,
  );
export const IconShare = (p: IconProps) =>
  Svg(
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
    </>,
    p,
  );
export const IconHeadphones = (p: IconProps) =>
  Svg(
    <path d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />,
    p,
  );
export const IconImage = (p: IconProps) =>
  Svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </>,
    p,
  );
export const IconRewind = (p: IconProps) =>
  Svg(
    <>
      <polygon points="11 19 2 12 11 5 11 19" fill="currentColor" stroke="none" />
      <polygon points="22 19 13 12 22 5 22 19" fill="currentColor" stroke="none" />
    </>,
    p,
  );
export const IconForward = (p: IconProps) =>
  Svg(
    <>
      <polygon points="13 19 22 12 13 5 13 19" fill="currentColor" stroke="none" />
      <polygon points="2 19 11 12 2 5 2 19" fill="currentColor" stroke="none" />
    </>,
    p,
  );
export const IconVolume = (p: IconProps) =>
  Svg(
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
    </>,
    p,
  );
export const IconCopy = (p: IconProps) =>
  Svg(
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </>,
    p,
  );
export const IconClock = (p: IconProps) =>
  Svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>,
    p,
  );
export const IconCheckCircle = (p: IconProps) =>
  Svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9 12l2 2 4-4" />
    </>,
    p,
  );
export const IconExternal = (p: IconProps) =>
  Svg(
    <>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
    </>,
    p,
  );
export const IconTrash = (p: IconProps) =>
  Svg(
    <>
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </>,
    p,
  );
export const IconPencil = (p: IconProps) =>
  Svg(
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
    </>,
    p,
  );
export const IconShield = (p: IconProps) =>
  Svg(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, p);
export const IconWifi = (p: IconProps) =>
  Svg(
    <>
      <path d="M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0" />
      <circle cx="12" cy="20" r="0.5" fill="currentColor" />
    </>,
    p,
  );
export const IconFolder = (p: IconProps) =>
  Svg(<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />, p);
export const IconMobile = (p: IconProps) =>
  Svg(
    <>
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </>,
    p,
  );
export const IconQrCode = (p: IconProps) =>
  Svg(
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <path d="M14 14h3v3M20 14v7M17 17h4" />
    </>,
    p,
  );
export const IconAirdrop = (p: IconProps) =>
  Svg(
    <>
      <path d="M12 2a10 10 0 0110 10" />
      <path d="M12 6a6 6 0 016 6" />
      <path d="M12 10a2 2 0 012 2" />
      <path d="M12 22l-2-4h4z" fill="currentColor" />
    </>,
    p,
  );
export const IconArrowLeft = (p: IconProps) => Svg(<path d="M19 12H5M12 19l-7-7 7-7" />, p);
export const IconEye = (p: IconProps) =>
  Svg(
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    p,
  );
export const IconSparkle = (p: IconProps) =>
  Svg(
    <path d="M12 3l2.09 4.26L18 8.5l-4 3.9.94 5.6L12 15.27 9.06 18l.94-5.6-4-3.9 3.91-1.24L12 3z" />,
    p,
  );
export const IconChevD = (p: IconProps) => Svg(<path d="M6 9l6 6 6-6" />, p);
export const IconHistory = (p: IconProps) =>
  Svg(
    <>
      <path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.5L3 9" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </>,
    p,
  );
export const IconLayers = (p: IconProps) =>
  Svg(
    <>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </>,
    p,
  );
export const IconBookO = (p: IconProps) =>
  Svg(
    <>
      <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
      <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
    </>,
    p,
  );
export const IconGrid = (p: IconProps) =>
  Svg(
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </>,
    p,
  );
export const IconBattery = (p: IconProps) =>
  Svg(
    <>
      <rect x="2" y="7" width="18" height="10" rx="2" ry="2" />
      <line x1="22" y1="11" x2="22" y2="13" />
      <rect x="4" y="9" width="13" height="6" fill="currentColor" stroke="none" />
    </>,
    p,
  );
export const IconSignal = (p: IconProps) =>
  Svg(
    <path
      d="M2 20h2v-3H2zM7 20h2v-7H7zM12 20h2v-11H12zM17 20h2v-15H17z"
      fill="currentColor"
      stroke="none"
    />,
    p,
  );
export const IconWifiBars = (p: IconProps) =>
  Svg(
    <>
      <path d="M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0" />
      <circle cx="12" cy="20" r="1.2" fill="currentColor" />
    </>,
    p,
  );
export const IconUndo = (p: IconProps) =>
  Svg(
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 00-15-6.7L3 13" />
    </>,
    p,
  );
export const IconScale = (p: IconProps) =>
  Svg(
    <>
      <path d="M16 16l4-4-4-4M8 8l-4 4 4 4M14.5 4l-5 16" />
    </>,
    p,
  );
export const IconAlertTri = (p: IconProps) =>
  Svg(
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>,
    p,
  );
export const IconAccept = (p: IconProps) =>
  Svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-6" />
    </>,
    p,
  );
export const IconReject = (p: IconProps) =>
  Svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </>,
    p,
  );
export const IconChecks = (p: IconProps) =>
  Svg(
    <>
      <path d="M16 6L7 15l-4-4" />
      <path d="M22 8l-6 6" />
    </>,
    p,
  );
export const IconTrend = (p: IconProps) =>
  Svg(
    <>
      <path d="M22 7L13.5 15.5l-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>,
    p,
  );
export const IconAB = (p: IconProps) =>
  Svg(
    <>
      <path d="M5 17l3-9 3 9M6 14h4" />
      <path d="M14 17V7h3a3 3 0 010 6h-3" />
      <path d="M14 13h3a3 3 0 010 6h-3" />
    </>,
    p,
  );
export const IconCheckBox = (p: IconProps) =>
  Svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 12l2 2 4-4" />
    </>,
    p,
  );
export const IconCheckBoxE = (p: IconProps) =>
  Svg(<rect x="3" y="3" width="18" height="18" rx="2" />, p);
export const IconSun = (p: IconProps) =>
  Svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
    p,
  );
export const IconMoon = (p: IconProps) =>
  Svg(<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />, p);
export const IconMonitor = (p: IconProps) =>
  Svg(
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>,
    p,
  );
export const IconApple = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01M12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25" />
  </svg>
);

/* Castwright brand mark — ragged-waveform-over-book glyph. Single source
   of truth for the wordmark glyph (top bar + companion-app banner). The
   peach/magenta hex fills are the brand palette; the last two bars + the
   book stroke take `currentColor` so the caller tints them. */
export const CastwaveMark = (p: IconProps) => (
  <svg viewBox="0 0 512 512" {...p}>
    <rect x="104" y="210" width="30" height="92" rx="15" fill="#f79a83" />
    <rect x="158" y="116" width="30" height="256" rx="15" fill="#f79a83" />
    <rect x="212" y="160" width="30" height="160" rx="15" fill="#a43c6c" />
    <rect x="266" y="92" width="30" height="284" rx="15" fill="#a43c6c" />
    <rect x="320" y="146" width="30" height="202" rx="15" fill="currentColor" />
    <rect x="374" y="200" width="30" height="108" rx="15" fill="currentColor" />
    <path
      d="M110 416 C 170 392, 226 392, 256 412 C 286 392, 342 392, 402 416"
      fill="none"
      stroke="currentColor"
      strokeWidth="15"
      strokeLinecap="round"
    />
  </svg>
);
