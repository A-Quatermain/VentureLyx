import type { Config } from 'tailwindcss';

// Swiss Brutalist (docs/design_guidelines.json) — authoritative over
// docs/DESIGN.md's Daylight Ledger, which this file no longer has any
// trace of (removed once the last consumer was retoken'd). Token values
// live in src/styles/globals.css; this file only maps Tailwind utilities
// onto those variables.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      screens: {
        g2: '700px',
        dt: '1080px',
      },
      colors: {
        background: 'hsl(var(--bg))',
        foreground: 'hsl(var(--fg))',
        surface: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-fg))',
        },
        // Plain var(), not hsl(var()) — the spec's border is an alpha-blended
        // rgba(), not a solid HSL triplet like the tones below (those stay
        // HSL specifically because GrowthGauge's inline SVG reads
        // hsl(var(--muted|primary|destructive|success)) directly).
        border: 'var(--border)',
        input: 'var(--border)',
        ring: 'hsl(var(--primary))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-fg))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-fg))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-fg))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-fg))',
        },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
};

export default config;
