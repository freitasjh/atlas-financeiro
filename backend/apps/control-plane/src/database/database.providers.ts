import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CONTROL_PLANE_DB, type NamedDatabase } from './database.tokens';

/**
 * Provider nomeado. Pool é lazy: nenhuma conexão é aberta na inicialização
 * (BLOQUEANTE-INFRA B2). Nenhuma DDL, migration ou segredo é criado aqui.
 */
export const databaseProvider = {
  provide: CONTROL_PLANE_DB,
  inject: [ConfigService],
  useFactory: (config: ConfigService): NamedDatabase => {
    const url = config.getOrThrow<string>('CONTROL_PLANE_DATABASE_URL');
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool);

    return {
      token: CONTROL_PLANE_DB,
      schema: 'control_plane',
      role: 'control_plane_app_role',
      url,
      db,
      probe: async () => {
        let client;
        try {
          client = await pool.connect();
          await client.query('SET search_path TO control_plane');
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
