'use client';

// This replaces the framework's own generic "Application error: a
// client-side exception has occurred" screen — it fires exactly where that
// one did: an error escaped every other boundary (including a failed
// client-side navigation fetch, e.g. hitting the app mid-deploy). It
// renders its own <html>/<body> and can't assume RootLayout's fonts or
// globals.css loaded cleanly, so styling here is inline and dependency-free
// on purpose.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F7F7F6',
          color: '#0A0A0A',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ maxWidth: 380, padding: 32, textAlign: 'center' }}>
          <p style={{ fontWeight: 900, fontSize: 20, letterSpacing: '-0.02em', margin: 0 }}>
            Venturelyx
          </p>
          <p style={{ marginTop: 16, fontSize: 14, color: '#5C5C5C', lineHeight: 1.6 }}>
            Something interrupted this page — often a moment of network trouble mid-navigation.
            Your data is untouched.
          </p>
          <div style={{ marginTop: 24, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              onClick={() => reset()}
              style={{
                minHeight: 42,
                padding: '0 20px',
                background: '#0055FF',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: 0,
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                minHeight: 42,
                padding: '0 20px',
                background: 'transparent',
                color: '#0A0A0A',
                border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 0,
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
          {error.digest && (
            <p style={{ marginTop: 20, fontSize: 11, color: '#5C5C5C', fontFamily: 'monospace' }}>
              Ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
