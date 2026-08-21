// Browser calls only (lib/api.ts, lib/sse.ts) — baked into the client bundle
// at build time, so it has to be the real public hostname.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE;
if (!API_BASE) {
  throw new Error('NEXT_PUBLIC_API_BASE is not set');
}

// Server components only (lib/session.ts). The web container and the api
// container sit on the same Docker network — going out through
// api.venturelyx.com and back in for every SSR request means every page
// load depends on the Cloudflare Tunnel being up even though the two
// containers can already reach each other directly. No NEXT_PUBLIC_ prefix
// on purpose: Next.js only inlines that prefix into the client bundle, so
// naming it this way is also what keeps it out of browser code entirely,
// not just convention.
//
// Deliberately not validated here with a throw, unlike API_BASE above:
// NEXT_PUBLIC_API_BASE gets statically replaced by Next.js at build time in
// every bundle it appears in, server and client alike, so a throw guarding
// it is provably dead code either way. INTERNAL_API_BASE has no such
// replacement — this file is also imported by lib/api.ts and lib/sse.ts,
// which client components pull in, and a throw here would ship inside
// their bundle too, undefined and always-true in the browser. The
// (session.ts-only) check lives where this is actually read instead.
export const INTERNAL_API_BASE = process.env.INTERNAL_API_BASE;
