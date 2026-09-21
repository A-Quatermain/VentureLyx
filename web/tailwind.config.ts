import type { Config } from 'tailwindcss';

// Brand blue/teal, sampled from public/brand/ (docs/design_guidelines.json
// predates the real logo and still describes indigo/violet — superseded).
// Token values live in src/styles/globals.css; this file only maps
// Tailwind utilities onto those variables.
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
        // Plain var(), not hsl(var()) — border is a solid hex, not a solid
        // HSL triplet like the tones below (those stay HSL specifically
        // because GrowthGauge's inline SVG reads
        // hsl(var(--muted|primary|destructive|success)) directly).
        border: 'var(--border)',
        input: 'var(--border)',
        ring: 'hsl(var(--primary))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          hover: 'hsl(var(--primary-hover))',
          foreground: 'hsl(var(--primary-fg))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-fg))',
          // Darker fixed variant for white text on a gradient (Button's
          // 'ai' variant) — see the --accent-deep comment in globals.css.
          deep: 'hsl(var(--accent-deep))',
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
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-fg))',
        },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
