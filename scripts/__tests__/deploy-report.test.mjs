import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import {
  buildCliVersions,
  buildReport,
  COMMANDS_NOT_EXECUTED,
  normalizeBinaryPath,
  validateReport,
} from '../validate-deploy.mjs'
import { buildPagesPlan } from '../emit-pages-plan.mjs'
import { findSecretPatterns } from '../scan-secrets.mjs'

const sha = 'a'.repeat(64)
const versions = {
  node: 'v26.7.0',
  npm: '11.19.0',
  supabase: { path: '~/.local/bin/supabase', version: '2.121.0', sha256: sha },
  wrangler: 'not-installed',
}

function cleanInput() {
  return {
    commit: 'e4c981c',
    cliVersions: versions,
    commandsExecuted: ['npm run build', 'supabase config validate', 'git rev-parse HEAD'],
    checks: [{ id: 'IN-4', status: 'PASS', evidence: 'count=0' }],
    pagesPlan: buildPagesPlan(),
    verbSource: { path: 'scripts/data/mutating-verbs.json', sha256: '1d16beb6', verbs: 24 },
    guardExemptions: [],
    secretScan: { trackedCount: 12, globbedCount: 2, findings: [] },
  }
}

test('deve_gravar_deploy_validation_v1_com_redacao_e_versions_medidas_em_runtime', () => {
  const report = buildReport(cleanInput())
  assert.equal(report.schema, 'deploy-validation/v1')
  assert.equal(report.mode, 'validation')
  assert.equal(report.commit, 'e4c981c')
  assert.equal(report.cliVersions.supabase.version, '2.121.0')
  assert.equal(report.cliVersions.wrangler, 'not-installed')
  assert.equal(report.mutatingVerbsDetected, 0)
  assert.equal(report.secretsFound, 0)
  assert.equal(report.result, 'PASS')
  assert.deepEqual(report.commandsNotExecuted, COMMANDS_NOT_EXECUTED)
  for (const item of ['projeto Supabase', 'link', 'migrations', 'functions deploy', 'secrets set', 'pages project create', 'pages deploy', 'Worker Asaas']) {
    assert.ok(report.commandsNotExecuted.some((c) => c.includes(item)), item)
  }
  assert.equal(validateReport(report).ok, true)

  const incoherent = { ...report, result: 'PASS', mutatingVerbsDetected: 1 }
  assert.equal(validateReport(incoherent).ok, false)

  const secret = `sb_secret_${'a'.repeat(20)}`
  const leaked = { ...report, checks: [{ id: 'IN-7', status: 'PASS', evidence: secret }] }
  assert.equal(validateReport(leaked).ok, false)
  assert.equal(JSON.stringify(report).includes(secret), false)

  const mutatedCommand = { ...report, commandsExecuted: ['npm run build', 'supabase link'] }
  assert.equal(validateReport(mutatedCommand).ok, false)

  assert.equal(validateReport({ ...report, commit: '' }).ok, false)
})

test('deve_registrar_proveniencia_do_supabase_ou_not_pinned_sem_falhar', () => {
  const home = '/home/fake-user'
  assert.equal(normalizeBinaryPath(`${home}/.local/bin/supabase`, home), '~/.local/bin/supabase')

  const available = buildCliVersions({
    home,
    node: 'v26.7.0',
    npm: '11.19.0',
    supabase: { available: true, path: `${home}/.local/bin/supabase`, version: '2.121.0', sha256: sha },
    wrangler: { available: false },
  })
  assert.deepEqual(available.supabase, { path: '~/.local/bin/supabase', version: '2.121.0', sha256: sha })
  assert.equal(available.wrangler, 'not-installed')
  assert.equal(JSON.stringify(available).includes('/home/fake-user'), false)

  const absent = buildCliVersions({ home, node: 'v26.7.0', npm: '11.19.0', supabase: { available: false }, wrangler: { available: false } })
  assert.equal(absent.supabase, 'not-pinned')
  assert.equal(absent.cliVersionsSupabase, undefined)
  assert.deepEqual(findSecretPatterns(JSON.stringify(absent)), [])

  assert.throws(() => buildCliVersions({
    home,
    node: 'v26.7.0',
    npm: '11.19.0',
    supabase: { available: true, path: `${home}/bin/supabase`, version: '2.121.0', sha256: '' },
    wrangler: { available: false },
  }), /sha256/)

  const reportWithAbsent = buildReport({ ...cleanInput(), cliVersions: absent, supabaseBinary: 'not-pinned' })
  assert.equal(reportWithAbsent.supabaseBinary, 'not-pinned')
  assert.equal(reportWithAbsent.result, 'PASS')
})
