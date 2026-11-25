import { z } from 'zod';

/**
 * v1 congelado (ADR-001 §3 / SPEC §9.2).
 * Somente formas de dados — nenhum objeto de infraestrutura é transportado.
 * Mudança incompatível ⇒ novo diretório v2, nunca edição aqui.
 */

export const healthStatusSchema = z.strictObject({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['up', 'down']),
  context: z.enum(['cliente', 'control-plane']),
});

export const healthEnvelopeSchema = z.strictObject({
  version: z.literal('v1'),
  data: healthStatusSchema,
});

export const fieldErrorEnvelopeSchema = z.strictObject({
  version: z.literal('v1'),
  field: z.string().min(1),
  message: z.string().min(1),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type HealthEnvelope = z.infer<typeof healthEnvelopeSchema>;
export type FieldErrorEnvelope = z.infer<typeof fieldErrorEnvelopeSchema>;

// AUTH-03: acréscimos v1. Nenhum schema acima é editado; quebra ⇒ v2.
export const loginRequest = z.strictObject({
  email: z.email(),
  password: z.string().min(12),
});

export const refreshRequest = z.strictObject({
  refreshToken: z.string().min(1),
});

const sessionTokensSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

export const loginResponse = z.strictObject({
  version: z.literal('v1'),
  data: sessionTokensSchema,
});

export const refreshResponse = z.strictObject({
  version: z.literal('v1'),
  data: sessionTokensSchema,
});

// Derivado do golden AUTH-01 (admin): zero campo acrescentado, inclusive version.
export const checkResponse = z.strictObject({
  authorized: z.literal(true),
  context: z.literal('cliente'),
  role: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequest>;
export type RefreshRequest = z.infer<typeof refreshRequest>;
export type LoginResponse = z.infer<typeof loginResponse>;
export type RefreshResponse = z.infer<typeof refreshResponse>;
export type CheckResponse = z.infer<typeof checkResponse>;
