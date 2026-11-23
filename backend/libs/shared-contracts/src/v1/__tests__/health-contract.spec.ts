import { describe, expect, it } from 'vitest';
import { healthEnvelopeSchema, type HealthEnvelope } from '../index';

describe('contrato v1 de health', () => {
  it('whenValidEnvelope_thenParsesWithLiteralVersionV1', () => {
    const parsed = healthEnvelopeSchema.parse({
      version: 'v1',
      data: { status: 'ok', db: 'up', context: 'cliente' },
    });
    expect(parsed.version).toBe('v1');
    const typed: HealthEnvelope = parsed;
    expect(typed.data.context).toBe('cliente');
  });

  it('whenExtraFieldPresent_thenRejectsNamingTheField', () => {
    const result = healthEnvelopeSchema.safeParse({
      version: 'v1',
      data: { status: 'ok', db: 'up', context: 'control-plane' },
      injectedField: 'x',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join(' ');
      expect(message).toContain('injectedField');
      expect(message).not.toContain(['contexto', 'inválido'].join(' '));
    }
  });

  it('whenVersionIsV2_thenRejects', () => {
    const result = healthEnvelopeSchema.safeParse({
      version: 'v2',
      data: { status: 'ok', db: 'up', context: 'cliente' },
    });
    expect(result.success).toBe(false);
  });
});
