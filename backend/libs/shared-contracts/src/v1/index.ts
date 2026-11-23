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
