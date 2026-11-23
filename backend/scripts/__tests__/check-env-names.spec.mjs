import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = readFileSync(path.join(HERE, '../../../.spec/archive/20261122-prd-nestjs-modular-split/ADRs/ADR-001-fronteiras-nestjs/SPEC.md'), 'utf8');

describe('nomes de env congelados', () => {
  it('whenSpecDeclaresFrozenNames_thenEnvSchemaListsExactlySixNames', () => {
    const schema = readFileSync(
      path.join(HERE, '../../apps/cliente/src/config/env.schema.ts'),
      'utf8',
    );
    for (const name of [
      'CLIENTE_DATABASE_URL',
      'CLIENTE_JWT_SECRET',
      'CLIENTE_JWT_ISSUER',
      'CLIENTE_JWT_AUDIENCE',
    ]) {
      assert.match(schema, new RegExp(name), `falta ${name} no schema do cliente`);
    }
    assert.doesNotMatch(schema, /^\s*DATABASE_URL\s*:/m);
  });

  it('whenControlPlaneSchemaRead_thenListsItsFourNames', () => {
    const schema = readFileSync(
      path.join(HERE, '../../apps/control-plane/src/config/env.schema.ts'),
      'utf8',
    );
    for (const name of [
      'CONTROL_PLANE_DATABASE_URL',
      'CONTROL_PLANE_JWT_SECRET',
      'CONTROL_PLANE_JWT_ISSUER',
      'CONTROL_PLANE_JWT_AUDIENCE',
    ]) {
      assert.match(schema, new RegExp(name), `falta ${name} no schema do control-plane`);
    }
    assert.doesNotMatch(schema, /^\s*DATABASE_URL\s*:/m);
  });

  it('whenSpecIsSource_thenGenericDatabaseUrlIsForbidden', () => {
    assert.match(SPEC, /DATABASE_URL.*proibido/i);
  });
});
