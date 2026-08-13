import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@/styles/globals.css';

// Self-hosted from public/fonts/ rather than next/font/google: the
// Docker build container can't reach fonts.googleapis.com (BuildKit's
// isolated builder network has no working egress there, even though the
// host and plain `docker run` containers do) — builds hung indefinitely
// mid-build fetching them. Self-hosting makes the build network-independent
// and faster; files are pre-subset to exactly the glyphs this app uses.
const display = localFont({
  src: [
    { path: '../../public/fonts/bricolage-grotesque-700.woff2', weight: '700' },
    { path: '../../public/fonts/bricolage-grotesque-800.woff2', weight: '800' },
  ],
  variable: '--font-display',
});
const ui = localFont({
  src: [
    { path: '../../public/fonts/archivo-400.woff2', weight: '400' },
    { path: '../../public/fonts/archivo-500.woff2', weight: '500' },
    { path: '../../public/fonts/archivo-600.woff2', weight: '600' },
  ],
  variable: '--font-ui',
});
const mono = localFont({
  src: [
    { path: '../../public/fonts/ibm-plex-mono-400.woff2', weight: '400' },
    { path: '../../public/fonts/ibm-plex-mono-500.woff2', weight: '500' },
    { path: '../../public/fonts/ibm-plex-mono-600.woff2', weight: '600' },
  ],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Venturelyx — Command Center',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${ui.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      {/* Password managers / dark-mode extensions inject attributes here
          before React hydrates; without this, that alone can make React
          abandon hydration and leave the DOM inert. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
