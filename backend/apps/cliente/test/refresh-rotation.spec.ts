import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { RefreshError, RefreshService } from '../src/auth/refresh-service';
import { loadB2Env } from './support/b2-gate';
import { applyClienteMigration } from './support/migrate';

const env = loadB2Env();
const prefix = `rtest-${randomUUID().slice(0, 8)}`;
let pool: Pool;
let service: RefreshService;

const hashOf = (opaque: string): string => createHash('sha256').update(opaque).digest('hex');
const opaque = (): string => randomBytes(32).toString('base64url');

async function asAppRole<T>(sub: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cliente_app_role');
    await client.query("SELECT set_config('app.cliente_sub', $1, true)", [sub]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seed(sub: string, token: string, options: { expired?: boolean } = {}): Promise<string> {
  const family = `${prefix}-family-${sub}`;
  await asAppRole(sub, async (client) => {
    await client.query(
      'INSERT INTO cliente.credenciais (sub, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [sub, `${sub}@example.test`, 'scrypt$ln=17,r=8,p=1$seed', 'admin'],
    );
    await client.query(
      [
        'INSERT INTO cliente.refresh_tokens',
        ' (sub, token_hash, family_id, jti, estado, expira_em)',
        ' VALUES ($1, $2, $3, $4, $5, now() + ($6 || \' minute\')::interval)',
      ].join(' '),
      [sub, hashOf(token), family, `jti-${sub}`, 'ativo', options.expired ? '-1' : '60'],
    );
  });
  return family;
}

beforeAll(async () => {
  expect(env.CLIENTE_DATABASE_URL, 'CLIENTE_DATABASE_URL ausente (B2)').toBeTruthy();
  pool = new Pool({ connectionString: env.CLIENTE_DATABASE_URL });
  await applyClienteMigration(pool);
  service = new RefreshService(pool);
});

afterAll(async () => {
  await pool?.query('DELETE FROM cliente.revogacoes WHERE sub LIKE $1', [`${prefix}%`]);
  await pool?.query('DELETE FROM cliente.refresh_tokens WHERE sub LIKE $1', [`${prefix}%`]);
  await pool?.query('DELETE FROM cliente.credenciais WHERE sub LIKE $1', [`${prefix}%`]);
  await pool?.end();
});

describe('rotação de refresh opaco em DB real (AUTH-07)', () => {
  it('whenRefreshRotated_thenOnlyHashStored', async () => {
    const sub = `${prefix}-a`;
    const token = opaque();
    await seed(sub, token);

    const issued = await service.rotate(token);
    expect(issued.refreshToken).not.toBe(token);
    expect(issued.refreshToken.split('.')).toHaveLength(1);
    expect(issued.sub).toBe(sub);

    const rows = await pool.query(
      'SELECT token_hash, estado FROM cliente.refresh_tokens WHERE sub = $1 ORDER BY id',
      [sub],
    );
    expect(rows.rows.map((row) => row.estado)).toEqual(['usado', 'ativo']);
    expect(rows.rows.map((row) => row.token_hash)).toEqual([hashOf(token), hashOf(issued.refreshToken)]);
    expect(rows.rows.map((row) => row.token_hash)).not.toContain(token);
    expect(rows.rows.map((row) => row.token_hash)).not.toContain(issued.refreshToken);
  });

  it('whenUsedRefreshReused_thenFamilyRevoked', async () => {
    const sub = `${prefix}-b`;
    const token = opaque();
    const family = await seed(sub, token);
    await service.rotate(token);

    await expect(service.rotate(token)).rejects.toMatchObject({
      status: 401,
      reason: 'reuse',
    } satisfies Partial<RefreshError>);

    const tokens = await pool.query(
      'SELECT estado FROM cliente.refresh_tokens WHERE family_id = $1',
      [family],
    );
    expect(tokens.rows.length).toBeGreaterThanOrEqual(2);
    expect(tokens.rows.every((row) => row.estado === 'revogado')).toBe(true);

    const revocations = await pool.query(
      "SELECT jti FROM cliente.revogacoes WHERE sub = $1 AND motivo = 'refresh-reuse'",
      [sub],
    );
    expect(revocations.rows.length).toBeGreaterThan(0);
  });

  it('whenUsedAndExpiredRefreshReused_thenFamilyRevoked', async () => {
    const sub = `${prefix}-d`;
    const token = opaque();
    const family = await seed(sub, token);
    await service.rotate(token);
    await asAppRole(sub, async (client) => {
      await client.query(
        "UPDATE cliente.refresh_tokens SET expira_em = now() - interval '1 minute' WHERE token_hash = $1",
        [hashOf(token)],
      );
    });

    await expect(service.rotate(token)).rejects.toMatchObject({
      status: 401,
      reason: 'reuse',
    } satisfies Partial<RefreshError>);

    const tokens = await pool.query(
      'SELECT estado FROM cliente.refresh_tokens WHERE family_id = $1',
      [family],
    );
    expect(tokens.rows.length).toBeGreaterThanOrEqual(2);
    expect(tokens.rows.every((row) => row.estado === 'revogado')).toBe(true);
  });

  it('whenCredentialMissing_thenRotationRejectedBeforeInsert', async () => {
    const sub = `${prefix}-sem-credencial`;
    const token = opaque();
    const family = `${prefix}-family-${sub}`;
    await asAppRole(sub, async (client) => {
      await client.query(
        [
          'INSERT INTO cliente.refresh_tokens',
          ' (sub, token_hash, family_id, jti, estado, expira_em)',
          " VALUES ($1, $2, $3, $4, 'ativo', now() + interval '1 hour')",
        ].join(' '),
        [sub, hashOf(token), family, `jti-${sub}`],
      );
    });
    const count = async (): Promise<number> => {
      const result = await pool.query(
        'SELECT count(*)::int AS n FROM cliente.refresh_tokens WHERE family_id = $1',
        [family],
      );
      return result.rows[0].n;
    };
    expect(await count()).toBe(1);

    await expect(service.rotate(token)).rejects.toMatchObject({
      status: 401,
      reason: 'invalid',
    } satisfies Partial<RefreshError>);
    expect(await count()).toBe(1);
  });

  it('whenTamperedAndExpired_thenBoth401WithDistinctReasons', async () => {
    const sub = `${prefix}-c`;
    await seed(sub, opaque(), { expired: true });
    const expiredToken = opaque();
    await pool.query(
      [
        'UPDATE cliente.refresh_tokens',
        " SET token_hash = $1, expira_em = now() - interval '1 minute'",
        ' WHERE sub = $2',
      ].join(' '),
      [hashOf(expiredToken), sub],
    );

    const tampered = await service.rotate(opaque()).catch((error: unknown) => error);
    const expired = await service.rotate(expiredToken).catch((error: unknown) => error);
    expect(tampered).toBeInstanceOf(RefreshError);
    expect(expired).toBeInstanceOf(RefreshError);
    expect((tampered as RefreshError).status).toBe(401);
    expect((expired as RefreshError).status).toBe(401);
    expect((tampered as RefreshError).reason).toBe('invalid');
    expect((expired as RefreshError).reason).toBe('expired');
    expect((tampered as RefreshError).reason).not.toBe((expired as RefreshError).reason);
  });
});
