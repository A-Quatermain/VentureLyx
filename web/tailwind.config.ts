import type { Config } from 'tailwindcss';

// Mid-rebuild: docs/design_guidelines.json (Swiss Brutalist) is now
// authoritative over docs/DESIGN.md (Daylight Ledger), but the rebuild is
// phased — sign-in/ScaleSEO/Catalog aren't migrated yet (Phase D). The old
// Daylight Ledger tokens stay defined, unchanged, so those pages render
// exactly as before with zero regression until their turn. New pages use
// the new token set below. Both live in src/styles/globals.css; this file
// only maps Tailwind utilities onto those variables.
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
        // --- Daylight Ledger (legacy, Phase D removes this block) ---
        deepwater: { DEFAULT: 'var(--deepwater)', 2: 'var(--deepwater-2)' },
        daylight: 'var(--daylight)',
        card: 'var(--card)',
        'card-sunk': 'var(--card-sunk)',
        ink: { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)' },
        pool: { DEFAULT: 'var(--pool)', soft: 'var(--pool-soft)' },
        sun: { DEFAULT: 'var(--sun)', soft: 'var(--sun-soft)' },
        growth: { DEFAULT: 'var(--growth)', soft: 'var(--growth-soft)' },
        alert: { DEFAULT: 'var(--alert)', soft: 'var(--alert-soft)' },
        line: { DEFAULT: 'var(--line)', 2: 'var(--line-2)' },

        // --- Swiss Brutalist (docs/design_guidelines.json) ---
        // "surface" not "card" — the legacy `card`/`card-sunk` keys above
        // are non-theme-reactive (Daylight Ledger never had dark mode). If
        // this new, dark-mode-aware token shared the `card` name, toggling
        // dark mode on an un-migrated page would flip its background dark
        // while its text stayed the old fixed ink color — unreadable.
        // Keeping them separate until Phase D removes the legacy block.
        background: 'hsl(var(--bg))',
        foreground: 'hsl(var(--fg))',
        surface: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-fg))',
        },
        // Plain var(), not hsl(var()) — the spec's border is an alpha-blended
        // rgba(), not a solid HSL triplet like the other tokens below (those
        // stay HSL specifically because GrowthGauge's inline SVG reads
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
      borderRadius: {
        // legacy Daylight Ledger keys — Phase D removes these
        card: '14px',
        button: '11px',
      },
      boxShadow: {
        // legacy Daylight Ledger key — Phase D removes this. Swiss
        // Brutalist has no shadows by design; new components use borders.
        card: 'var(--shadow)',
      },
    },
  },
  plugins: [],
};

export default config;
