'use client';

import { useEffect, useState } from 'react';

// Light by default per design_guidelines.json ("Light theme by default...
// Must have a Light/Dark theme toggle") — dark only applies once the user
// explicitly toggles it, persisted to localStorage. The matching
// before-hydration script lives in app/layout.tsx (next/script,
// beforeInteractive) so the class is set before first paint; this hook
// just keeps React's own state in sync with it.
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  function toggle() {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      localStorage.setItem('theme', next);
      return next;
    });
  }

  return { theme, toggle };
}
