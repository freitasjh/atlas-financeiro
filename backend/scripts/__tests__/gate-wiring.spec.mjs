import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, '../..');
const PKG = JSON.parse(readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'));

describe('wiring do gate de fronteiras (S2)', () => {
  it('whenGateScriptRead_thenG1IsInvokedDirectly', () => {
    assert.match(PKG.scripts['test:gate'], /node scripts\/check-boundaries\.mjs/);
  });

  it('whenGateScriptRead_thenG2EslintRuleIsInvokedDirectly', () => {
    assert.match(PKG.scripts['test:gate'], /eslint /);
  });

  it('whenEslintConfigRead_thenNoRestrictedImportsIsConfiguredWithTypeImportsForbidden', () => {
    const config = readFileSync(path.join(BACKEND_ROOT, 'eslint.config.mjs'), 'utf8');
    assert.match(config, /no-restricted-imports/);
    assert.match(config, /allowTypeImports:\s*false/);
    assert.match(config, /apps\/cliente/);
    assert.match(config, /apps\/control-plane/);
  });

  it('whenBoundaryScriptRead_thenItScansStaticReExportAndDynamicSpecifiers', () => {
    const script = readFileSync(path.join(BACKEND_ROOT, 'scripts/check-boundaries.mjs'), 'utf8');
    assert.match(script, /kind: 'reexport'/);
    assert.match(script, /kind: 'dynamic-import'/);
    assert.match(script, /process\.exitCode\s*=\s*1/);
  });

  it('whenNegativeFixtureSpecRead_thenItProvesFailureBeforeAnySuccessLine', () => {
    const spec = readFileSync(path.join(HERE, 'check-boundaries.spec.mjs'), 'utf8');
    assert.match(spec, /whenReExportFromOtherApp_thenFails/);
    assert.match(spec, /whenDynamicImportFromOtherApp_thenFails/);
    assert.match(spec, /assert\.notEqual\(result\.status, 0\)/);
  });
});
