// Single source for the API base URL — imported by both the browser client
// (lib/api.ts) and the server-side cookie-forwarding client (lib/session.ts)
// so it's never duplicated or allowed to drift between the two.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE;
if (!API_BASE) {
  throw new Error('NEXT_PUBLIC_API_BASE is not set');
}
