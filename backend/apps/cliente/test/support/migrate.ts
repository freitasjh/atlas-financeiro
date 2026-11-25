import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

const MIGRATION = path.resolve(process.cwd(), 'migrations/001_cliente_auth.sql');
const LOCK_KEY = 881234567;

/** Três arquivos de teste aplicam o mesmo DDL em paralelo; lock de sessão evita corrida. */
export async function applyClienteMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(readFileSync(MIGRATION, 'utf8'));
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
