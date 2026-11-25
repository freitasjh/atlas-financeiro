import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { loadB2Env } from './support/b2-gate';
import { applyClienteMigration } from './support/migrate';

// AUTH-09: DDL versionada aplicada em CLIENTE_DB real (B2 PASS). Nenhum skip,
// nenhum mock de store, nenhuma URL/senha no arquivo — env vem de .env.local.
const env = loadB2Env();
const TABLES = ['credenciais', 'refresh_tokens', 'revogacoes', 'mfa'] as const;

let pool: Pool;

beforeAll(async () => {
  expect(env.CLIENTE_DATABASE_URL, 'CLIENTE_DATABASE_URL ausente (B2)').toBeTruthy();
  pool = new Pool({ connectionString: env.CLIENTE_DATABASE_URL });
  await applyClienteMigration(pool);
  // Role sem grant: usada somente para provar negação por privilégio (sem senha).
  await pool.query(
    [
      'DO $$ BEGIN',
      "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cliente_unauth_role') THEN",
      '    CREATE ROLE cliente_unauth_role NOLOGIN;',
      '  END IF;',
      'END $$;',
    ].join('\n'),
  );
});

afterAll(async () => {
  await pool?.end();
});

async function asAppRole<T>(sub: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cliente_app_role');
    await client.query('SELECT set_config($1, $2, true)', ['app.cliente_sub', sub]);
    const result = await work(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seed(client: PoolClient, sub: string, hash: string): Promise<void> {
  await client.query(
    'INSERT INTO cliente.credenciais (sub, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    [sub, `${sub}@example.test`, 'scrypt$ln=17,r=8,p=1$salt', 'admin'],
  );
  await client.query(
    [
      'INSERT INTO cliente.refresh_tokens',
      ' (sub, token_hash, family_id, jti, estado, expira_em)',
      " VALUES ($1, $2, $3, $4, 'ativo', now() + interval '1 hour')",
    ].join(''),
    [sub, hash, `family-${sub}`, `jti-${sub}`],
  );
  await client.query(
    'INSERT INTO cliente.revogacoes (jti, sub, motivo) VALUES ($1, $2, $3)',
    [`jti-${sub}`, sub, 'teste'],
  );
  await client.query(
    'INSERT INTO cliente.mfa (sub, enrolled) VALUES ($1, true)',
    [sub],
  );
}

describe('RLS real em CLIENTE_DB (AUTH-09)', () => {
  it('whenRoleReadsClienteSchema_thenOnlyOwnRows', async () => {
    const hash = createHash('sha256').update('opaco-a').digest('hex');
    await asAppRole('u-a', async (client) => {
      await seed(client, 'u-a', hash);
      await client.query('SELECT set_config($1, $2, true)', ['app.cliente_sub', 'u-b']);
      for (const table of TABLES) {
        const foreign = await client.query(`SELECT count(*)::int AS n FROM cliente.${table}`);
        expect(foreign.rows[0].n, `${table} não pode ver linha de outro sub`).toBe(0);
      }
      await client.query('SELECT set_config($1, $2, true)', ['app.cliente_sub', 'u-a']);
      for (const table of TABLES) {
        const own = await client.query(`SELECT count(*)::int AS n FROM cliente.${table}`);
        expect(own.rows[0].n, `${table} deve ver só a própria linha`).toBe(1);
      }
    });
  });

  it('whenUnauthorizedRole_thenDenied', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE cliente_unauth_role');
      let code = '';
      try {
        await client.query('SELECT token_hash FROM cliente.refresh_tokens LIMIT 1');
      } catch (error) {
        code = (error as { code?: string }).code ?? '';
      }
      expect(code, 'negação por privilégio (42501)').toBe('42501');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // O DDL não vaza para o segundo banco provisionado no B2.
    const controlPlane = new Pool({ connectionString: env.CONTROL_PLANE_DATABASE_URL });
    try {
      const leaked = await controlPlane.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'cliente'",
      );
      expect(leaked.rows[0].n, 'CLIENTE_DB não vaza para CONTROL_PLANE_DB').toBe(0);
    } finally {
      await controlPlane.end();
    }
  });

  it('whenTokenHashInspected_thenNoPlaintext', async () => {
    const opaque = `opaque-${randomBytes(16).toString('hex')}`;
    const hash = createHash('sha256').update(opaque).digest('hex');

    await asAppRole('u-hash', async (client) => {
      await client.query(
        [
          'INSERT INTO cliente.refresh_tokens',
          ' (sub, token_hash, family_id, jti, estado, expira_em)',
          " VALUES ($1, $2, $3, $4, 'ativo', now() + interval '1 hour')",
        ].join(''),
        ['u-hash', hash, 'family-hash', 'jti-hash'],
      );
      const stored = await client.query(
        'SELECT token_hash, estado FROM cliente.refresh_tokens WHERE sub = $1',
        ['u-hash'],
      );
      expect(stored.rows[0].token_hash).toBe(hash);
      expect(stored.rows[0].token_hash).not.toBe(opaque);
      expect(opaque).not.toContain(stored.rows[0].token_hash);

      let code = '';
      try {
        await client.query(
          [
            'INSERT INTO cliente.refresh_tokens',
            ' (sub, token_hash, family_id, jti, estado, expira_em)',
            " VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')",
          ].join(''),
          ['u-hash', `h-${randomBytes(8).toString('hex')}`, 'family-hash', 'jti-bad', 'pendente'],
        );
      } catch (error) {
        code = (error as { code?: string }).code ?? '';
      }
      expect(code, 'check de estado ativo|usado|revogado').toBe('23514');
    });
  });
});
