/**
 * Venturelyx :: API server.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';

import contextPlugin, { isPaymentGateEnabled } from './plugins/context.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import operateRoutes from './routes/operate.js';
import aiRoutes from './routes/ai.js';
import reviewsRoutes from './routes/reviews.js';
import settingsRoutes from './routes/settings.js';
import locationsRoutes from './routes/locations.js';
import integrationsRoutes from './routes/integrations.js';
import growRoutes from './routes/grow.js';
import adminRoutes from './routes/admin.js';
import waitlistRoutes from './routes/waitlist.js';
import growthScanRoutes from './routes/growthScans.js';
import setupRoutes from './routes/setup.js';
import billingRoutes from './routes/billing.js';
import { healthy, shutdown } from './lib/db.js';
import { processUnsubscribe } from './lib/growUnsubscribe.js';
import { processClick } from './lib/growClickTracking.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// Fail fast and loudly rather than starting half-configured.
// STRIPE_SECRET_KEY itself is checked in lib/stripe.ts (the module that
// actually needs it) rather than duplicated here; STRIPE_WEBHOOK_SECRET is
// checked here because nothing imports it directly — only routes/billing.ts's
// webhook handler reads process.env for it at request time, which would
// otherwise fail quietly (a 500 on the first real webhook, not at boot).
for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'VAULT_KEY', 'STRIPE_WEBHOOK_SECRET']) {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} is not set`);
    process.exit(1);
  }
}
if ((process.env.VAULT_KEY ?? '').length !== 64) {
  console.error('FATAL: VAULT_KEY must be 64 hex characters (32 bytes)');
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.cookie', 'req.headers.authorization'],
    transport: process.env.NODE_ENV === 'production' ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
  },
  trustProxy: true,          // behind Caddy behind cloudflared
  bodyLimit: 1_048_576,
  disableRequestLogging: false,
});

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, {
  origin: (process.env.CORS_ORIGINS ?? 'https://app.venturelyx.com').split(','),
  credentials: true,
});
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
// Own byte cap, separate from the global JSON bodyLimit above — a contact
// list of a few thousand rows comfortably fits in 15MB as CSV or XLSX.
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  // Cloudflare passes the real client IP here; without this every request
  // appears to come from the tunnel.
  keyGenerator: (req) => (req.headers['cf-connecting-ip'] as string) ?? req.ip,
});

await app.register(contextPlugin);

app.get('/health', async (_req, reply) => {
  const db = await healthy();
  return reply.status(db ? 200 : 503).send({
    ok: db,
    service: 'venturelyx-api',
    db: db ? 'up' : 'down',
    time: new Date().toISOString(),
  });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Top-level, not under /v1 — GROW_BASE_URL/u/:token is what every Grow
// render path (preview, test-send, and growWorker.ts's real send) builds
// literally with no path prefix. Public: a recipient clicking this link, or
// a mail provider's automated RFC 8058 List-Unsubscribe-Post request, has
// no session and no org context, so this can't sit behind req.requireAuth().
app.get('/u/:token', async (req, reply) => {
  const { token } = req.params as { token: string };
  const result = await processUnsubscribe(token);
  reply.type('text/html');
  if (!result.found) {
    return reply.status(404).send('<!doctype html><p>This unsubscribe link is not valid or has expired.</p>');
  }
  return reply.send(
    `<!doctype html><p>${escapeHtml(result.email ?? 'This address')} has been unsubscribed and will not receive further email from this campaign.</p>`,
  );
});

// The actual RFC 8058 one-click target — mail providers POST here with no
// page render expected, so this always returns a bare 200/404 with no body.
app.post('/u/:token', async (req, reply) => {
  const { token } = req.params as { token: string };
  const result = await processUnsubscribe(token);
  return reply.status(result.found ? 200 : 404).send();
});

// Same public, no-session shape as /u/:token above — a link redirect click
// carries no Venturelyx session either. The destination comes only from
// grow_link_clicks' own stored url, never from anything in this request —
// see migration 019's header for why that specific property is the whole
// point (an open redirect off a domain recipients are asked to trust would
// be a real phishing vector, not a theoretical one).
app.get('/c/:token', async (req, reply) => {
  const { token } = req.params as { token: string };
  if (!/^[0-9a-f]+$/i.test(token)) {
    return reply.status(404).send('Not found');
  }
  const result = await processClick(token);
  if (!result.found || !result.url) {
    return reply.status(404).send('This link is not valid or has expired.');
  }
  return reply.redirect(result.url, 302);
});

await app.register(authRoutes, { prefix: '/v1' });
await app.register(dataRoutes, { prefix: '/v1' });
await app.register(operateRoutes, { prefix: '/v1' });
await app.register(aiRoutes, { prefix: '/v1' });
await app.register(reviewsRoutes, { prefix: '/v1' });
await app.register(settingsRoutes, { prefix: '/v1' });
await app.register(locationsRoutes, { prefix: '/v1' });
await app.register(integrationsRoutes, { prefix: '/v1' });
await app.register(growRoutes, { prefix: '/v1' });
await app.register(billingRoutes, { prefix: '/v1' });
await app.register(adminRoutes, { prefix: '/v1' });
await app.register(waitlistRoutes, { prefix: '/v1' });
// Public, no auth — exposes one non-sensitive boolean so the marketing
// site (web/'s (marketing)/page.tsx) can decide whether to show real
// prices or a "finalizing" placeholder, consistent with whether payment
// is actually being enforced yet. Nothing else here is public-readable.
// Registered under /v1 like every other route INTERNAL_API_BASE expects.
await app.register(async (v1) => {
  v1.get('/platform-status', async () => ({ paymentGateEnabled: await isPaymentGateEnabled() }));
}, { prefix: '/v1' });
await app.register(growthScanRoutes, { prefix: '/v1' });
await app.register(setupRoutes, { prefix: '/v1' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, closing`);
    await app.close();
    await shutdown();
    process.exit(0);
  });
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}
