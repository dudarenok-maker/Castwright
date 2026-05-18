import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
  plugins: [],
};

export default config;
