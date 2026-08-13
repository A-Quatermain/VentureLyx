import type { Config } from 'tailwindcss';

// Token values live once, in src/styles/globals.css (:root custom properties),
// straight from docs/DESIGN.md. This file only maps Tailwind utilities onto
// those variables — never hardcodes a hex value.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // docs/DESIGN.md: "Desktop >=1080px: dark sidebar." `dt` is that exact
      // breakpoint; `g2` is where dashboard grids go 2-up before `dt` takes
      // them to 3-up.
      screens: {
        g2: '700px',
        dt: '1080px',
      },
      colors: {
        deepwater: { DEFAULT: 'var(--deepwater)', 2: 'var(--deepwater-2)' },
        daylight: 'var(--daylight)',
        card: { DEFAULT: 'var(--card)', sunk: 'var(--card-sunk)' },
        ink: { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)' },
        pool: { DEFAULT: 'var(--pool)', soft: 'var(--pool-soft)' },
        sun: { DEFAULT: 'var(--sun)', soft: 'var(--sun-soft)' },
        growth: { DEFAULT: 'var(--growth)', soft: 'var(--growth-soft)' },
        alert: { DEFAULT: 'var(--alert)', soft: 'var(--alert-soft)' },
        line: { DEFAULT: 'var(--line)', 2: 'var(--line-2)' },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        card: '14px',
        button: '11px',
      },
      boxShadow: {
        card: 'var(--shadow)',
      },
    },
  },
  plugins: [],
};

export default config;
