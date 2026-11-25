import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loginRequest,
  loginResponse,
  refreshRequest,
  refreshResponse,
  checkResponse,
} from '../index';

const GOLDEN = path.resolve(
  process.cwd(),
  'apps/cliente/test/golden/auth-before.fixture.json',
);

describe('contratos v1 aditivos de autenticação (AUTH-03)', () => {
  it('whenExtraField_thenStrictObjectRejectsNamingField', () => {
    const result = loginRequest.safeParse({
      email: 'cliente@example.com',
      password: 'senha-com-12',
      injectedField: 'x',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // z.strictObject reporta chave desconhecida no nível raiz; o nome vai na mensagem.
      expect(result.error.message).toContain('injectedField');
      expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('whenPasswordShorterThan12_then400', () => {
    const result = loginRequest.safeParse({
      email: 'cliente@example.com',
      password: 'curta',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('password');
    }
  });

  it('whenEnvelopesParsed_thenVersionV1IsRequired', () => {
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900 };
    expect(loginResponse.safeParse({ version: 'v1', data: tokens }).success).toBe(true);
    expect(refreshResponse.safeParse({ version: 'v1', data: tokens }).success).toBe(true);
    expect(loginResponse.safeParse({ version: 'v2', data: tokens }).success).toBe(false);
    expect(refreshResponse.safeParse({ version: 'v2', data: tokens }).success).toBe(false);
    expect(refreshRequest.safeParse({ refreshToken: 'opaco' }).success).toBe(true);
  });

  it('whenCheckResponseComparedToGolden_thenNoExtraField', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
      casos: Record<string, { snapshot: { body: Record<string, unknown> } }>;
    };
    const body = golden.casos.admin.snapshot.body;

    expect(Object.keys(checkResponse.shape).sort()).toEqual(Object.keys(body).sort());
    expect(checkResponse.safeParse(body).success).toBe(true);
    expect(checkResponse.safeParse({ ...body, injectedField: 'x' }).success).toBe(false);
  });
});
