import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  plugins: [
    /* Plan 81 wave 4 — `coarse-pointer:` variant matches `@media (pointer: coarse)`
       (touchscreens). Lets components surface a fallback for hover-only
       affordances without a JS pointer-type check. Example use:
       `opacity-0 group-hover:opacity-100 coarse-pointer:opacity-60` —
       reveals on hover for mouse users, stays faintly visible on touch
       devices where hover doesn't exist. */
    plugin(({ addVariant }) => {
      addVariant('coarse-pointer', '@media (pointer: coarse)');
      addVariant('fine-pointer', '@media (pointer: fine)');
    }),
  ],
  theme: {
    extend: {
      colors: {
        canvas: { DEFAULT: 'var(--canvas)', warm: 'var(--canvas-warm)' },
        ink: { DEFAULT: 'var(--ink)', soft: 'var(--ink-soft)' },
        peach: { DEFAULT: 'var(--peach)', soft: 'var(--peach-soft)' },
        magenta: 'var(--magenta)',
        purple: { deep: 'var(--purple-deep)' },
      },
      fontFamily: {
        sans: ['"General Sans"', '"Neue Montreal"', 'Inter', 'system-ui', 'sans-serif'],
        serif: ['Lora', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'gradient-cta': 'var(--gradient-cta)',
        'gradient-cta-horizontal': 'var(--gradient-cta-horizontal)',
        'gradient-progress': 'var(--gradient-progress)',
        'gradient-hero-wash': 'var(--gradient-hero-wash)',
        'gradient-image-wash': 'var(--gradient-image-wash)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        float: 'var(--shadow-float)',
        drawer: 'var(--shadow-drawer)',
      },
      borderRadius: { sm: '8px', md: '12px', lg: '20px', xl: '28px', '2xl': '40px', '3xl': '56px' },
    },
  },
};

export default config;
