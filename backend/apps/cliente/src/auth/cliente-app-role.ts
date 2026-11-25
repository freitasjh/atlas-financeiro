import type { Pool, PoolClient } from 'pg';

/**
 * Toda leitura/escrita de auth roda sob cliente_app_role: a conexão do provider
 * pode ser superuser (BYPASSRLS), então SET LOCAL ROLE é obrigatório para RLS
 * morder em runtime. `sub` define a policy de linha; undefined = só resolvers
 * SECURITY DEFINER (usado antes de saber o sub do refresh).
 */
export async function withClienteAppRole<T>(
  pool: Pool,
  sub: string | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE cliente_app_role');
    if (sub !== undefined) {
      await client.query("SELECT set_config('app.cliente_sub', $1, true)", [sub]);
    }
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
