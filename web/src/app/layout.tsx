import type { Metadata } from 'next';
import localFont from 'next/font/local';
import Script from 'next/script';
import '@/styles/globals.css';

// Self-hosted from public/fonts/ rather than next/font/google: the
// Docker build container can't reach fonts.googleapis.com (BuildKit's
// isolated builder network has no working egress there, even though the
// host and plain `docker run` containers do) — builds hung indefinitely
// mid-build fetching them. Self-hosting makes the build network-independent
// and faster; files are pre-subset to exactly the glyphs this app uses.
//
// One family (IBM Plex Sans) for both --font-display and --font-ui now —
// docs/design_guidelines.json dropped the separate brutalist display face
// (Chivo) in favor of weight/size alone carrying heading hierarchy. Kept as
// two separate font-display declarations (rather than pointing font-display
// at --font-ui) so the two Tailwind classes can still diverge later without
// touching every call site again.
const display = localFont({
  src: [
    { path: '../../public/fonts/ibm-plex-sans-600.woff2', weight: '600' },
    { path: '../../public/fonts/ibm-plex-sans-700.woff2', weight: '700' },
  ],
  variable: '--font-display',
});
const ui = localFont({
  src: [
    { path: '../../public/fonts/ibm-plex-sans-400.woff2', weight: '400' },
    { path: '../../public/fonts/ibm-plex-sans-500.woff2', weight: '500' },
    { path: '../../public/fonts/ibm-plex-sans-600.woff2', weight: '600' },
  ],
  variable: '--font-ui',
});
const mono = localFont({
  src: [
    { path: '../../public/fonts/jetbrains-mono-400.woff2', weight: '400' },
    { path: '../../public/fonts/jetbrains-mono-500.woff2', weight: '500' },
    { path: '../../public/fonts/jetbrains-mono-600.woff2', weight: '600' },
    { path: '../../public/fonts/jetbrains-mono-700.woff2', weight: '700' },
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
      <body suppressHydrationWarning>
        {/* Sets the .dark class before first paint so toggling theme never
            flashes light-then-dark. Light is the default per
            design_guidelines.json — this only ever adds the class, never
            removes what SSR already rendered. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`try{if(localStorage.getItem('theme')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}`}
        </Script>
        {children}
      </body>
    </html>
  );
}
