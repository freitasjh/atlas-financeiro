export const CONTROL_PLANE_DB = 'CONTROL_PLANE_DB';

export interface NamedDatabase {
  readonly token: typeof CONTROL_PLANE_DB;
  readonly schema: 'control_plane';
  readonly role: 'control_plane_app_role';
  readonly url: string;
  readonly db: ReturnType<typeof import('drizzle-orm/node-postgres').drizzle>;
  probe(): Promise<boolean>;
}
