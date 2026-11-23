import { z } from 'zod';

/** Nomes de env congelados (ADR-001 §4 / SPEC §9.4). Valores vêm do ambiente. */
export const envSchema = z.strictObject({
  CLIENTE_DATABASE_URL: z.string().min(1),
  CLIENTE_JWT_SECRET: z.string().min(1),
  CLIENTE_JWT_ISSUER: z.string().min(1),
  CLIENTE_JWT_AUDIENCE: z.string().min(1),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const forbiddenName = ['DATABASE', '_URL'].join('');
  if (Object.prototype.hasOwnProperty.call(raw, forbiddenName)) {
    throw new Error('URL genérica de banco proibida; nomeie o contexto');
  }
  return envSchema.parse({
    CLIENTE_DATABASE_URL: raw.CLIENTE_DATABASE_URL,
    CLIENTE_JWT_SECRET: raw.CLIENTE_JWT_SECRET,
    CLIENTE_JWT_ISSUER: raw.CLIENTE_JWT_ISSUER,
    CLIENTE_JWT_AUDIENCE: raw.CLIENTE_JWT_AUDIENCE,
  });
}
