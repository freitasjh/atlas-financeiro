export const CLIENTE_DB = 'CLIENTE_DB';

export interface NamedDatabase {
  readonly token: typeof CLIENTE_DB;
  readonly schema: 'cliente';
  readonly role: 'cliente_app_role';
  readonly url: string;
  readonly db: ReturnType<typeof import('drizzle-orm/node-postgres').drizzle>;
  probe(): Promise<boolean>;
}
