import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withClienteAppRole } from './cliente-app-role';
import type { SecurityLogger } from './security-logger';

export type RefreshFailureReason = 'invalid' | 'expired' | 'reuse' | 'family-revoked';

export class RefreshError extends Error {
  readonly status = 401 as const;
  constructor(readonly reason: RefreshFailureReason) {
    super(`refresh-${reason}`);
    this.name = 'RefreshError';
  }
}

export interface IssuedRefresh {
  readonly refreshToken: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly jti: string;
  readonly sub: string;
  readonly role: string;
  readonly mfa: boolean;
}

type RotationOutcome = { error: RefreshFailureReason } | { issued: IssuedRefresh };

export function hashRefreshToken(opaque: string): string {
  return createHash('sha256').update(opaque).digest('hex');
}

export function generateOpaqueRefresh(): string {
  return randomBytes(32).toString('base64url');
}

/** Rotação atômica: ativo→usado; reuso de usado revoga a família inteira. */
export class RefreshService {
  constructor(
    private readonly pool: Pool,
    private readonly security?: SecurityLogger,
  ) {}

  /** Primeiro par da família, emitido no login; DB guarda só o hash do opaco. */
  async issue(sub: string, role: string, mfa: boolean): Promise<IssuedRefresh> {
    return withClienteAppRole(this.pool, sub, async (client) => {
      const refreshToken = generateOpaqueRefresh();
      const tokenHash = hashRefreshToken(refreshToken);
      const familyId = randomUUID();
      const jti = randomUUID();
      await client.query(
        [
          'INSERT INTO cliente.refresh_tokens',
          ' (sub, token_hash, family_id, jti, estado, expira_em)',
          " VALUES ($1, $2, $3, $4, 'ativo', now() + interval '1 hour')",
        ].join(' '),
        [sub, tokenHash, familyId, jti],
      );
      return { refreshToken, tokenHash, familyId, jti, sub, role, mfa };
    });
  }

  async rotate(opaque: string, correlationId?: string): Promise<IssuedRefresh> {
    const cid = correlationId ?? randomUUID();
    const tokenHash = hashRefreshToken(opaque);
    const outcome = await withClienteAppRole<RotationOutcome>(this.pool, undefined, async (client) => {
      const resolved = await client.query(
        'SELECT cliente.sub_por_hash_refresh($1) AS sub',
        [tokenHash],
      );
      const sub: unknown = resolved.rows[0]?.sub;
      if (typeof sub !== 'string') return { error: 'invalid' as const };
      await client.query("SELECT set_config('app.cliente_sub', $1, true)", [sub]);

      const found = await client.query(
        'SELECT family_id, jti, estado, expira_em FROM cliente.refresh_tokens WHERE token_hash = $1',
        [tokenHash],
      );
      const row = found.rows[0];
      if (row === undefined) return { error: 'invalid' as const };
      if (row.estado === 'usado' || row.estado === 'revogado') {
        await revokeFamily(client, row.family_id);
        return { error: row.estado === 'usado' ? ('reuse' as const) : ('family-revoked' as const) };
      }
      if (new Date(row.expira_em).getTime() <= Date.now()) {
        return { error: 'expired' as const };
      }

      const rotated = await client.query(
        "UPDATE cliente.refresh_tokens SET estado = 'usado' WHERE token_hash = $1 AND estado = 'ativo' RETURNING family_id",
        [tokenHash],
      );
      if (rotated.rowCount !== 1) {
        await revokeFamily(client, row.family_id);
        return { error: 'reuse' as const };
      }

      const refreshToken = generateOpaqueRefresh();
      const identity = await client.query(
        [
          'SELECT c.role, COALESCE(m.enrolled, false) AS mfa',
          'FROM cliente.credenciais c LEFT JOIN cliente.mfa m ON m.sub = c.sub',
          'WHERE c.sub = $1',
        ].join(' '),
        [sub],
      );
      const identityRow = identity.rows[0];
      if (identityRow === undefined) return { error: 'invalid' as const };
      const jti = randomUUID();
      await client.query(
        [
          'INSERT INTO cliente.refresh_tokens',
          ' (sub, token_hash, family_id, jti, estado, expira_em)',
          " VALUES ($1, $2, $3, $4, 'ativo', now() + interval '1 hour')",
        ].join(' '),
        [sub, hashRefreshToken(refreshToken), row.family_id, jti],
      );
      return {
        issued: {
          refreshToken,
          tokenHash: hashRefreshToken(refreshToken),
          familyId: row.family_id,
          jti,
          sub,
          role: identityRow.role,
          mfa: identityRow.mfa === true,
        },
      };
    });

    if ('error' in outcome) {
      // Eventos após a transação: rollback não deixa log órfão de reuso.
      if (outcome.error === 'reuse') {
        this.security?.emit('refresh-reuse', 'refresh-reused', cid);
        this.security?.emit('family-revoked', 'family-revoked', cid);
      } else if (outcome.error === 'family-revoked') {
        this.security?.emit('family-revoked', 'family-revoked', cid);
      }
      throw new RefreshError(outcome.error);
    }
    return outcome.issued;
  }
}

async function revokeFamily(client: PoolClient, familyId: string): Promise<void> {
  await client.query(
    [
      "INSERT INTO cliente.revogacoes (jti, sub, motivo)",
      " SELECT jti, sub, 'refresh-reuse' FROM cliente.refresh_tokens WHERE family_id = $1",
      ' ON CONFLICT DO NOTHING',
    ].join(' '),
    [familyId],
  );
  await client.query(
    "UPDATE cliente.refresh_tokens SET estado = 'revogado' WHERE family_id = $1 AND estado <> 'revogado'",
    [familyId],
  );
}
