/**
 * Venturelyx :: Redis client — one singleton connection, used today only
 * by the Operate intake rate limiter (routes/operateIntake.ts). Every
 * other rate limit in this app is @fastify/rate-limit's in-memory default
 * store (server.ts); this one needs a shared counter across the per-key
 * identity it limits, independent of which API process instance handles
 * a given request, so it can't be the same in-memory store.
 *
 * REDIS_URL must be forwarded to whichever service imports this file —
 * infra/docker-compose.app.yml's api service environment block sets it
 * from REDIS_PASSWORD, same env-var-forwarding discipline as every other
 * secret in this app (a var set in infra/.env but missing from a
 * service's own environment block has silently broken three separate
 * features already this session).
 */
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error('REDIS_URL is not set — required for api/src/lib/redis.ts');
}

export const redis = new Redis(REDIS_URL, {
  // Fails fast instead of buffering commands indefinitely if Redis is
  // briefly unreachable — the intake rate limiter below treats a Redis
  // error as "let the request through" (never block a real lead over an
  // infra hiccup), so a long buffer would just delay that decision.
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  console.error({ err: err.message }, 'redis client error');
});

/** 60/min per key (or any identity string), via a single INCR+EXPIRE —
 *  atomic enough for this purpose (a lost race just lets one extra
 *  request through in the rare case two increments interleave before the
 *  first's EXPIRE lands, never undercounts). Returns true if the request
 *  is allowed. Fails OPEN on a Redis error — see this file's header. */
export async function checkRateLimit(
  identity: string, limit: number, windowSeconds: number,
): Promise<boolean> {
  try {
    const key = `ratelimit:${identity}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return count <= limit;
  } catch (err) {
    console.error({ err, identity }, 'checkRateLimit: redis error, allowing request through');
    return true;
  }
}
