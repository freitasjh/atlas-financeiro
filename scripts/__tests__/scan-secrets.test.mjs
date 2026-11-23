import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSecretPatterns, scan } from '../scan-secrets.mjs'

const sbSecret = `sb_secret_${'a'.repeat(20)}`
const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
const serviceRole = `${'service_role'}=${'value'.repeat(4)}`
const pgUrl = `${'postgres'}ql://user:pass@host/db`
const highEntropy = `${['API', 'TOKEN'].join('_')}=${'q'.repeat(40)}`

test('deve_falhar_com_redacao_para_cinco_padroes_da_denylist_e_aceitar_allowlist', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-scan-'))
  const file = 'candidatos.txt'
  writeFileSync(join(cwd, file), [sbSecret, jwt, serviceRole, pgUrl, highEntropy].join('\n'))

  const result = scan({ cwd, paths: [file] })
  assert.equal(result.secretsFound, 5)
  assert.equal(result.findings.length, 5)
  assert.deepEqual(
    [...result.findings.map((f) => f.patternId)].sort(),
    ['entropy', 'jwt', 'postgres-url', 'sb-secret', 'service-role'],
  )
  for (const finding of result.findings) {
    assert.ok(finding.path)
    assert.ok(finding.line >= 1)
    assert.ok(finding.patternId)
    assert.equal(finding.redacted, true)
  }
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(sbSecret), false)
  assert.equal(serialized.includes(jwt), false)
  assert.equal(serialized.includes('q'.repeat(40)), false)
  assert.equal(findSecretPatterns([sbSecret, jwt, serviceRole, pgUrl, highEntropy].join('\n')).length, 5)

  const allowFile = 'allowlist.txt'
  writeFileSync(
    join(cwd, allowFile),
    [
      'REPLACE_WITH_PROJECT_REF',
      'zzfake00000000000000',
      'fake-anon-key-not-a-jwt',
      '<PLACEHOLDER_ORG_ID>',
      'VITE_SUPABASE_ANON_KEY=',
    ].join('\n'),
  )
  assert.equal(scan({ cwd, paths: [allowFile] }).secretsFound, 0)
})

test('deve_detectar_segredo_em_env_production_por_glob_filesystem_mesmo_fora_do_git', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-scan-glob-'))
  mkdirSync(join(cwd, 'supabase/.temp'), { recursive: true })
  writeFileSync(join(cwd, '.env.production'), `${['API', 'TOKEN'].join('_')}=${'z'.repeat(40)}\n`)
  writeFileSync(join(cwd, 'supabase/.temp/docker.env'), `sb_secret_${'b'.repeat(20)}\n`)
  writeFileSync(join(cwd, 'supabase/.temp/cli-latest'), '2.121.0\n')

  const globbedPaths = ['.env.production', 'supabase/.temp/docker.env', 'supabase/.temp/cli-latest']
  const result = scan({ cwd, trackedPaths: [], globbedPaths })
  assert.equal(result.globbedCount, 3)
  assert.equal(result.secretsFound, 2)
  assert.equal(result.findings.length, 2)
  assert.ok(result.findings.some((f) => f.path === '.env.production' && f.ignored === true && f.line === 1))
  assert.ok(result.findings.some((f) => f.path.endsWith('docker.env')))
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('z'.repeat(40)), false)
  assert.equal(serialized.includes(`sb_secret_${'b'.repeat(20)}`), false)

  const dedup = scan({ cwd, trackedPaths: ['.env.production'], globbedPaths: ['.env.production'] })
  assert.equal(dedup.findings.length, 1)
  assert.equal(dedup.findings[0].ignored, false)
  assert.equal(dedup.trackedCount, 1)
  assert.equal(dedup.globbedCount, 1)
})
