import type { Metadata } from 'next';
import { Bricolage_Grotesque, Archivo, IBM_Plex_Mono } from 'next/font/google';
import '@/styles/globals.css';

const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-display',
});
const ui = Archivo({ subsets: ['latin'], variable: '--font-ui' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
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
