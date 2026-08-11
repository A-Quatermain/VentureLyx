/**
 * Venturelyx :: API server.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import contextPlugin from './plugins/context.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import { healthy, shutdown } from './lib/db.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// Fail fast and loudly rather than starting half-configured.
for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'VAULT_KEY']) {
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

await app.register(authRoutes, { prefix: '/v1' });
await app.register(dataRoutes, { prefix: '/v1' });

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
