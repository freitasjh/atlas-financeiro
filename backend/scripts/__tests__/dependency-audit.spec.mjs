import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, '../..');

describe('auditoria de dependências do backend (S3)', () => {
  it('whenAuditRuns_thenZeroHighOrCriticalFindings', { timeout: 180000 }, () => {
    const result = spawnSync('npm', ['audit', '--audit-level=high', '--json'], {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, String(result.error));
    const payload = JSON.parse(result.stdout);
    const counts = payload.metadata?.vulnerabilities ?? {};
    assert.equal(
      counts.high ?? 0,
      0,
      `high findings: ${JSON.stringify(payload.vulnerabilities ?? {})}`,
    );
    assert.equal(
      counts.critical ?? 0,
      0,
      `critical findings: ${JSON.stringify(payload.vulnerabilities ?? {})}`,
    );
  });
});
