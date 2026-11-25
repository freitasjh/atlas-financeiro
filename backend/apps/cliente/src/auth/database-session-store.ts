import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLIENTE_DB, type NamedDatabase } from '../database/database.tokens';
import { withClienteAppRole } from './cliente-app-role';
import type { SessionStore } from './session-store';

/** Store de produção: revogação e MFA persistem no DB, sob RLS de cliente_app_role. */
export class DatabaseSessionStore implements SessionStore {
  private readonly pool: Pool;

  constructor(@Inject(CLIENTE_DB) named: NamedDatabase) {
    this.pool = named.pool;
  }

  async isRevoked(sub: string, jti: string | undefined): Promise<boolean> {
    if (!jti) return false;
    return withClienteAppRole(this.pool, sub, async (client) => {
      const result = await client.query(
        'SELECT 1 FROM cliente.revogacoes WHERE jti = $1',
        [jti],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async revoke(sub: string, jti: string, motivo = 'revogacao'): Promise<void> {
    await withClienteAppRole(this.pool, sub, async (client) => {
      await client.query(
        'INSERT INTO cliente.revogacoes (jti, sub, motivo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [jti, sub, motivo],
      );
    });
  }

  async hasMfa(sub: string): Promise<boolean> {
    return withClienteAppRole(this.pool, sub, async (client) => {
      const result = await client.query(
        'SELECT enrolled FROM cliente.mfa WHERE sub = $1',
        [sub],
      );
      return result.rows[0]?.enrolled === true;
    });
  }

  async enrollMfa(sub: string): Promise<void> {
    await withClienteAppRole(this.pool, sub, async (client) => {
      await client.query(
        [
          'INSERT INTO cliente.mfa (sub, enrolled) VALUES ($1, true)',
          'ON CONFLICT (sub) DO UPDATE SET enrolled = true',
        ].join(' '),
        [sub],
      );
    });
  }
}
