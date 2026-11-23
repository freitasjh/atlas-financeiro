import { z } from 'zod';

/** Nomes de env congelados (ADR-001 §4 / SPEC §9.4). Valores vêm do ambiente. */
export const envSchema = z.strictObject({
  CONTROL_PLANE_DATABASE_URL: z.string().min(1),
  CONTROL_PLANE_JWT_SECRET: z.string().min(1),
  CONTROL_PLANE_JWT_ISSUER: z.string().min(1),
  CONTROL_PLANE_JWT_AUDIENCE: z.string().min(1),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const forbiddenName = ['DATABASE', '_URL'].join('');
  if (Object.prototype.hasOwnProperty.call(raw, forbiddenName)) {
    throw new Error('URL genérica de banco proibida; nomeie o contexto');
  }
  return envSchema.parse({
    CONTROL_PLANE_DATABASE_URL: raw.CONTROL_PLANE_DATABASE_URL,
    CONTROL_PLANE_JWT_SECRET: raw.CONTROL_PLANE_JWT_SECRET,
    CONTROL_PLANE_JWT_ISSUER: raw.CONTROL_PLANE_JWT_ISSUER,
    CONTROL_PLANE_JWT_AUDIENCE: raw.CONTROL_PLANE_JWT_AUDIENCE,
  });
}
