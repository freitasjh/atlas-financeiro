import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(path.join(HERE, '../../package.json'), 'utf8'));

describe('engines e scripts do workspace backend', () => {
  it('whenPackageRead_thenEnginesNodeIsGreaterOrEqual22', () => {
    assert.equal(PKG.engines?.node, '>=22');
  });

  it('whenTestGateScriptRead_thenBothG1AndG2AreInvoked', () => {
    const script = PKG.scripts['test:gate'] ?? '';
    assert.match(script, /check-boundaries\.mjs/, 'G1 ausente do test:gate');
    assert.match(script, /eslint/, 'G2 ausente do test:gate');
  });

  it('whenScriptsRead_thenSuiteCommandsExist', () => {
    for (const name of ['test:run', 'test:gate', 'build', 'typecheck']) {
      assert.ok(PKG.scripts[name], `script ${name} ausente`);
    }
  });

  it('whenRuntimeRead_thenSatisfiesEngineRequirement', () => {
    const major = Number(process.versions.node.split('.')[0]);
    assert.ok(major >= 22, `runtime ${process.versions.node} < 22`);
  });
});
