import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../check-boundaries.mjs');

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'atlas-boundary-'));
  mkdirSync(path.join(root, 'apps'), { recursive: true });
  mkdirSync(path.join(root, 'libs'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(relativePath, content) {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function gate() {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], {
    encoding: 'utf8',
  });
}

function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

describe('G1 check-boundaries — árvore limpa', () => {
  it('whenCleanTree_thenPassesAndReportsZeroCrossImports', () => {
    put('apps/cliente/src/app.module.ts', "import { HealthModule } from './health/health.module';\nexport const x = HealthModule;\n");
    put('apps/cliente/src/health/health.module.ts', 'export class HealthModule {}\n');
    put('apps/control-plane/src/app.module.ts', "import { HealthModule } from './health/health.module';\nexport const y = HealthModule;\n");
    put('apps/control-plane/src/health/health.module.ts', 'export class HealthModule {}\n');
    put('libs/shared-contracts/src/v1/index.ts', "import { z } from 'zod';\nexport const s = z.strictObject({ version: z.literal('v1') });\n");
    put('bridge.ts', "import { z } from 'zod';\nexport const schema = z.string();\n");

    const result = gate();
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /0 cruzados/);
    assert.match(output(result), /0 módulos proibidos/);
    assert.match(output(result), /\[G1\]/);
    assert.match(output(result), /raiz/);
  });
});

describe('G1 check-boundaries — fixture negativa de import cruzado', () => {
  it('whenClienteImportsControlPlane_thenFailsNamingFileSpecifierAndRule', () => {
    put('apps/control-plane/src/marker.ts', 'export const marker = 1;\n');
    put(
      'apps/cliente/src/bad.ts',
      "import { marker } from '../../control-plane/src/marker';\nexport const leaked = marker;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /apps\/cliente\/src\/bad\.ts/);
    assert.match(output(result), /control-plane\/src\/marker/);
    assert.match(output(result), /cross-context/);
  });

  it('whenControlPlaneImportsCliente_thenFailsNamingFileSpecifierAndRule', () => {
    put('apps/cliente/src/marker.ts', 'export const marker = 1;\n');
    put(
      'apps/control-plane/src/bad.ts',
      "import { marker } from '../../cliente/src/marker';\nexport const leaked = marker;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /apps\/control-plane\/src\/bad\.ts/);
    assert.match(output(result), /cliente\/src\/marker/);
    assert.match(output(result), /cross-context/);
  });

  it('whenReExportFromOtherApp_thenFails', () => {
    put('apps/control-plane/src/marker.ts', 'export const marker = 1;\n');
    put(
      'apps/cliente/src/reexport.ts',
      "export { marker } from '../../control-plane/src/marker';\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /reexport/);
  });

  it('whenDynamicImportFromOtherApp_thenFails', () => {
    put(
      'apps/cliente/src/dynamic.ts',
      "export async function load() { return import('apps/control-plane/src/marker'); }\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /apps\/control-plane\/src\/marker/);
    assert.match(output(result), /dynamic-import|cross-context/);
  });
});

describe('G1 check-boundaries — fixture negativa de módulo proibido', () => {
  it('whenGlobalDecoratorUsed_thenFailsNamingFileAndRule', () => {
    put(
      'apps/cliente/src/global.module.ts',
      "@Global()\nexport class GlobalModule {}\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /apps\/cliente\/src\/global\.module\.ts/);
    assert.match(output(result), /@Global\(\)/);
  });

  it('whenPaymentModuleImported_thenFails', () => {
    put(
      'apps/control-plane/src/billing.module.ts',
      "import { AsaasModule } from 'asaas-webhook';\nexport const m = AsaasModule;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /asaas/i);
    assert.match(output(result), /modulo-proibido/);
  });

  it('whenCheckoutModuleImported_thenFails', () => {
    put(
      'apps/cliente/src/checkout.module.ts',
      "import { CheckoutModule } from './checkout/checkout.module';\nexport const m = CheckoutModule;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /checkout/);
    assert.match(output(result), /modulo-proibido/);
  });

  it('whenMessagingTransportImported_thenFails', () => {
    put(
      'apps/cliente/src/events.module.ts',
      "import { ClientProxy } from '@nestjs/microservices';\nexport const p = ClientProxy;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /ClientProxy/);
    assert.match(output(result), /modulo-proibido/);
  });

  it('whenLibExportsProvider_thenFails', () => {
    put(
      'libs/shared-contracts/src/v1/index.ts',
      "import { DrizzleModule } from '@nestjs/drizzle';\nexport const p = DrizzleModule;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /DrizzleModule/);
    assert.match(output(result), /lib-provider/);
  });
});

describe('G1 check-boundaries — shared e raiz não podem importar apps', () => {
  it('whenSharedImportsAppCliente_thenFailsNamingFileSpecifierAndRule', () => {
    put('apps/cliente/src/marker.ts', 'export const marker = 1;\n');
    put(
      'libs/shared-contracts/src/v1/injected.ts',
      "import { marker } from '../../../../apps/cliente/src/marker';\nexport const leaked = marker;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /libs\/shared-contracts\/src\/v1\/injected\.ts/);
    assert.match(output(result), /apps\/cliente\/src\/marker/);
    assert.match(output(result), /cross-context/);
    assert.match(output(result), /shared/);
  });

  it('whenSharedDynamicImportsAppControlPlane_thenFails', () => {
    put(
      'libs/shared-contracts/src/v1/injected.ts',
      "export async function load() { return import('apps/control-plane/src/marker'); }\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /apps\/control-plane\/src\/marker/);
    assert.match(output(result), /dynamic-import|cross-context/);
  });

  it('whenSharedReexportsAppCliente_thenFails', () => {
    put(
      'libs/shared-contracts/src/v1/injected.ts',
      "export { marker } from 'apps/cliente/src/marker';\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /reexport|cross-context/);
  });

  it('whenSharedFixtureRemoved_thenGatePassesAgain', () => {
    const clean = "import { z } from 'zod';\nexport const s = z.strictObject({ version: z.literal('v1') });\n";
    put(
      'libs/shared-contracts/src/v1/index.ts',
      "import { marker } from '../../../../apps/cliente/src/marker';\nexport const leaked = marker;\n",
    );

    const before = gate();
    assert.notEqual(before.status, 0, output(before));

    put('libs/shared-contracts/src/v1/index.ts', clean);
    const after = gate();
    assert.equal(after.status, 0, output(after));
  });

  it('whenRootLooseFileImportsAppCliente_thenFails', () => {
    put(
      'bridge.ts',
      "import { marker } from './apps/cliente/src/marker';\nexport const leaked = marker;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /bridge\.ts/);
    assert.match(output(result), /apps\/cliente\/src\/marker/);
    assert.match(output(result), /cross-context/);
    assert.match(output(result), /raiz/);
  });

  it('whenRootLooseFileRequiresAppControlPlane_thenFails', () => {
    put(
      'bridge.cjs',
      "const marker = require('apps/control-plane/src/marker');\nmodule.exports = marker;\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /bridge\.cjs/);
    assert.match(output(result), /apps\/control-plane\/src\/marker/);
    assert.match(output(result), /cross-context/);
  });
});

describe('G1 check-boundaries — env e segredos', () => {
  it('whenGenericDatabaseUrlUsed_thenFails', () => {
    put(
      'apps/cliente/src/config.ts',
      'export const url = process.env.DATABASE_URL;\n',
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /DATABASE_URL/);
    assert.match(output(result), /env-proibido/);
  });

  it('whenOnlyFrozenEnvNamesUsed_thenPasses', () => {
    put(
      'apps/cliente/src/config.ts',
      "export const a = process.env.CLIENTE_DATABASE_URL;\nexport const b = process.env.CLIENTE_JWT_SECRET;\n",
    );
    put(
      'apps/control-plane/src/config.ts',
      "export const a = process.env.CONTROL_PLANE_DATABASE_URL;\nexport const b = process.env.CONTROL_PLANE_JWT_AUDIENCE;\n",
    );

    const result = gate();
    assert.equal(result.status, 0, output(result));
  });

  it('whenLiteralConnectionStringVersioned_thenFails', () => {
    put(
      'apps/cliente/src/config.ts',
      "export const url = 'postgresql://user:password@db.internal:5432/cliente';\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /segredo-versionado/);
  });

  it('whenLiteralJwtSecretVersioned_thenFails', () => {
    put(
      'apps/cliente/src/auth/config.ts',
      "export const secret = 'FAKE_SECRET_SENTINEL_DO_NOT_USE_IN_PROD';\n",
    );

    const result = gate();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /segredo-versionado/);
  });
});
