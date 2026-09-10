#!/usr/bin/env node
// =============================================================================
// Venturelyx :: Grow contacts import (CLI)
//
//   node scripts/import-contacts.js --org <uuid> --file <path> [--dry-run]
//
// Loads a normalized CSV (the shape /opt/outreach/data/contacts_normalized.csv
// is in) into grow_contacts for one org. All row parsing/validation lives in
// api/src/lib/growContactImport.js — this file is just the CLI shell around
// it (arg parsing, file reading, DB connection, report printing) so the
// web upload endpoint (POST /v1/grow/contacts/import/*) can use the exact
// same rules without a second implementation to drift out of sync.
//
// --dry-run parses and validates the file and prints the report below, but
// never opens a database connection — the `pg` client is only imported once
// an actual write is about to happen, so a dry run has no dependency on
// pg being installed or the database being reachable at all.
//
// Idempotent: INSERT ... ON CONFLICT (org_id, email) DO NOTHING, so
// re-running the same file (or a file with overlapping rows) is safe.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { INSERT_COLUMNS, processRows, summarize } from '../api/src/lib/growContactImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---- CLI args ---------------------------------------------------------------

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  if (!values.org || !values.file) {
    console.error('Usage: node scripts/import-contacts.js --org <uuid> --file <path> [--dry-run]');
    process.exit(1);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.org)) {
    console.error(`FATAL: --org "${values.org}" doesn't look like a uuid.`);
    process.exit(1);
  }
  if (!fs.existsSync(values.file)) {
    console.error(`FATAL: --file "${values.file}" not found.`);
    process.exit(1);
  }

  return { org: values.org, file: values.file, dryRun: values['dry-run'] };
}

// ---- Reporting ----------------------------------------------------------------

function printReport({ org, file, summary }) {
  console.log(`Org:      ${org}`);
  console.log(`File:     ${file}`);
  console.log(`Rows:     ${summary.totalRows} data row(s) (header excluded)`);
  console.log(`  accepted: ${summary.acceptedCount}`);
  console.log(`  rejected: ${summary.rejectedCount}`);

  console.log('\nAccepted contacts by tier:');
  if (summary.byTier.length === 0) {
    console.log('  (none)');
  } else {
    for (const { tier, count } of summary.byTier) console.log(`  ${tier}: ${count}`);
  }

  console.log(`\nUnique recipient domains: ${summary.uniqueDomains}`);

  if (summary.rejectionsByCode.length > 0) {
    console.log('\nRejected rows by reason:');
    for (const { code, count, examples } of summary.rejectionsByCode) {
      console.log(`  ${code}: ${count}`);
      for (const ex of examples.slice(0, 3)) {
        console.log(`      line ${ex.line} (${ex.email}): ${ex.detail}`);
      }
      if (count > 3) console.log(`      ...and ${count - 3} more`);
    }
  }
}

// ---- Database (only touched on a real run) -------------------------------------

// Same convention as scripts/migrate.sh: read infra/.env for whatever isn't
// already in the environment, rather than requiring the caller to export
// everything by hand first.
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.POSTGRES_HOST || '127.0.0.1';
  const port = process.env.POSTGRES_PORT || '5432';
  const { APP_DB_USER: user, APP_DB_PASSWORD: password, POSTGRES_DB: db } = process.env;
  if (!user || !password || !db) {
    throw new Error(
      'DATABASE_URL is not set, and APP_DB_USER/APP_DB_PASSWORD/POSTGRES_DB are not all set either '
      + '(check infra/.env)',
    );
  }
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

// Connects as the app role, not the superuser: grow_contacts has RLS
// FORCEd (see app.apply_tenant_rls() in 009_grow.sql), so writes here go
// through the exact same tenant boundary a real request would, rather than
// a maintenance script quietly bypassing it. set_config(name, value, true)
// is the only way to set a GUC with a bind parameter — plain
// `SET LOCAL app.current_org = $1` is a syntax error — and the GUC really
// is `app.user_id`, never `app.current_user` (a reserved word). Both match
// api/src/lib/db.ts's withTenant exactly, for the same reasons.
async function insertContacts(org, contacts) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', org]);
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.is_staff', 'off']);

    const orgRow = await client.query('SELECT id FROM organizations WHERE id = $1', [org]);
    if (orgRow.rowCount === 0) {
      throw new Error(`org ${org} not found`);
    }

    let inserted = 0;
    const CHUNK = 200;
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const chunk = contacts.slice(i, i + CHUNK);
      const values = [];
      const rowPlaceholders = chunk.map((contact, ri) => {
        const base = ri * INSERT_COLUMNS.length;
        INSERT_COLUMNS.forEach((col) => values.push(contact[col]));
        const ph = INSERT_COLUMNS.map((_, ci) => `$${base + ci + 1}`).join(',');
        return `(${ph})`;
      }).join(',\n');

      const res = await client.query(
        `INSERT INTO grow_contacts (${INSERT_COLUMNS.join(',')})
         VALUES ${rowPlaceholders}
         ON CONFLICT (org_id, email) DO NOTHING`,
        values,
      );
      inserted += res.rowCount ?? 0;
    }

    await client.query('COMMIT');
    console.log(`\nInserted ${inserted} new contact(s). ${contacts.length - inserted} already existed (skipped).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// ---- Main -----------------------------------------------------------------

async function main() {
  const { org, file, dryRun } = parseCliArgs();
  const text = fs.readFileSync(file, 'utf8');
  const { totalRows, accepted, rejections } = processRows(text, org);
  const summary = summarize({ totalRows, accepted, rejections });

  printReport({ org, file, summary });

  if (dryRun) {
    console.log('\nDry run: no database connection was made, nothing was written.');
    return;
  }

  if (accepted.length === 0) {
    console.log('\nNothing to insert.');
    return;
  }

  loadEnvFile(path.join(ROOT, 'infra', '.env'));
  await insertContacts(org, accepted);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
