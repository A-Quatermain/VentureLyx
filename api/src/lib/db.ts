/**
 * Venturelyx :: database access.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * Every query runs inside a transaction that has already set the tenant GUCs.
 * PostgreSQL row-level security then confines the statement to one org. If a
 * route forgets `WHERE org_id = ...`, the database returns zero rows instead of
 * another client's data.
 *
 * Two hard-won details, both verified against PostgreSQL 17:
 *
 *   1. `SET LOCAL x = $1` is a SYNTAX ERROR. SET does not accept bind
 *      parameters. Use set_config(name, value, is_local) — a normal function,
 *      so parameters work, and is_local=true gives identical transaction scope.
 *
 *   2. The GUC is `app.user_id`, never `app.current_user`. `current_user` is a
 *      reserved SQL keyword and the statement will not parse.
 *
 * Transaction scope matters: these settings cannot leak into the next request
 * on a pooled connection, which is why nothing here uses plain SET.
 */
import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

const { Pool } = pg;

// Return numeric/bigint as JS numbers where safe; money stays a string so we
// never lose cents to float rounding.
pg.types.setTypeParser(20, (v) => Number(v));            // int8
pg.types.setTypeParser(1700, (v) => v);                  // numeric -> string

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 12),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'venturelyx-api',
});

pool.on('error', (err) => {
  // A pooled client died in the background. Log, don't crash the process.
  console.error({ err }, 'idle postgres client error');
});

export interface TenantContext {
  orgId: string | null;
  userId: string | null;
  isStaff: boolean;
}

export const ANON: TenantContext = { orgId: null, userId: null, isStaff: false };

/**
 * Run `fn` inside a transaction carrying tenant context.
 * Commits on success, rolls back on any throw.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.current_org', ctx.orgId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', ctx.userId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.is_staff', ctx.isStaff ? 'on' : 'off']);

    const result = await fn(makeQuerier(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export interface Querier {
  rows<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
}

function makeQuerier(client: PoolClient): Querier {
  return {
    async rows(sql, params) {
      const r = await client.query(sql, params as never);
      return r.rows as never;
    },
    async one(sql, params) {
      const r = await client.query(sql, params as never);
      return (r.rows[0] ?? null) as never;
    },
    async exec(sql, params) {
      const r = await client.query(sql, params as never);
      return r.rowCount ?? 0;
    },
  };
}

/**
 * Unscoped access for genuinely cross-tenant work: login (email -> user, before
 * an org is known), platform health, staff dashboards. Runs with is_staff on,
 * so RLS permits cross-tenant reads.
 *
 * Every call site must be deliberate. If you are reaching for this to make a
 * query "just work", the query belongs in withTenant instead.
 */
export async function withPlatform<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return withTenant({ orgId: null, userId: null, isStaff: true }, fn);
}

export async function healthy(): Promise<boolean> {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function shutdown(): Promise<void> {
  await pool.end();
}
