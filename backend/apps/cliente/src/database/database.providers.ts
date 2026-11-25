import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CLIENTE_DB, type NamedDatabase } from './database.tokens';

/**
 * Provider nomeado. Pool é lazy: nenhuma conexão é aberta na inicialização
 * (BLOQUEANTE-INFRA B2). Nenhuma DDL, migration ou segredo é criado aqui.
 */
export const databaseProvider = {
  provide: CLIENTE_DB,
  inject: [ConfigService],
  useFactory: (config: ConfigService): NamedDatabase => {
    const url = config.getOrThrow<string>('CLIENTE_DATABASE_URL');
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool);

    return {
      token: CLIENTE_DB,
      schema: 'cliente',
      role: 'cliente_app_role',
      url,
      pool,
      db,
      probe: async () => {
        let client;
        try {
          client = await pool.connect();
          await client.query('SET search_path TO cliente');
          await client.query('SELECT 1');
          return true;
        } catch {
          return false;
        } finally {
          client?.release();
        }
      },
    };
  },
};
