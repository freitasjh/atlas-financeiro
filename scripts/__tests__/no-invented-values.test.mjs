import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDist, projectRefsInText, substituteProjectRef } from '../../scripts/check-dist.mjs'
import { buildPagesPlan, isPagesPlanValid } from '../emit-pages-plan.mjs'
import { MUTATING_VERBS_SHA256, scan } from '../guard-mutating-verbs.mjs'
import { findSecretPatterns, scan as scanSecrets } from '../scan-secrets.mjs'
import {
  buildReport,
  evaluateCommandList,
  FAKE_ENV,
  makeConfigValidateStep,
  validateReport,
} from '../validate-deploy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runbook = readFileSync(join(root, '.doc/runbook-deploy-primeiro-corte.md'), 'utf8')
const reportText = readFileSync(join(root, '.doc/relatorio-validacao-deploy.json'), 'utf8')
const MARKER = '<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->'
const TEMPLATE = `# Validação (executável agora)\nconteúdo\n${MARKER}\n# Aplicação (somente humano, após aprovação)\nconteúdo\n`

const REAL_VALUE_PATTERNS = [
  { id: 'real-ref-domain', re: /https:\/\/(?!zzfake)[a-z0-9][a-z0-9-]{15,}\.supabase\.co/i },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'secret', re: /sb_secret_[A-Za-z0-9_-]{16,}/ },
  { id: 'org-id', re: /\borg-[a-z0-9]{8,}\b/i },
  { id: 'home-path', re: /\/home\/[A-Za-z0-9_.-]+\// },
]

function cleanSources() {
  const names = ['validate-deploy.mjs', 'guard-mutating-verbs.mjs', 'scan-secrets.mjs', 'emit-pages-plan.mjs']
  const sources = names.map((name) => ({
    path: `scripts/${name}`,
    text: readFileSync(join(root, 'scripts', name), 'utf8'),
  }))
  sources.push({ path: 'package.json', scripts: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts })
  return sources
}

test('deve_garantir_que_ref_dominio_org_e_chaves_reais_nao_aparecem_e_que_toda_cli_citada_tem_fonte_datada', () => {
  const text = `${runbook}\n${reportText}`
  for (const { id, re } of REAL_VALUE_PATTERNS) {
    assert.equal(re.test(text), false, `valor real detectado: ${id}`)
  }
  assert.equal(findSecretPatterns(text).length, 0)
  assert.ok(runbook.includes('zzfake00000000000000'))
  assert.ok(runbook.includes('fake-anon-key-not-a-jwt'))
  assert.ok(runbook.includes('<PLACEHOLDER_PAGES_PROJECT>'))
  assert.ok(runbook.includes('<PLACEHOLDER_BRANCH>'))

  for (const source of [
    'https://supabase.com/docs/reference/cli/introduction — 2026-11-22',
    'https://developers.cloudflare.com/workers/wrangler/commands/pages/ — 2026-11-22',
    'https://developers.cloudflare.com/pages/get-started/direct-upload/ — 2026-11-22',
  ]) {
    assert.ok(runbook.includes(source), `fonte datada ausente: ${source}`)
  }
  for (const command of ['supabase config validate', 'wrangler pages deploy', 'npm run build', 'git rev-parse HEAD']) {
    assert.ok(runbook.includes(command))
  }
})

test('deve_validar_o_gate_P3_com_zero_mutante_executado_e_zero_PII', () => {
  const fixture = readFileSync(join(root, 'scripts/__tests__/fixtures/mutating-verbs-8.txt'), 'utf8')
  const guardFixture = scan({ text: fixture, runbookText: TEMPLATE, sources: [] })
  const guardClean = scan({ text: '', runbookText: TEMPLATE, sources: cleanSources(), packageJsonDiff: 'clean' })

  const secretCwd = mkdtempSync(join(tmpdir(), 'opencode-p3-secret-'))
  const injected = `sb_secret_${'a'.repeat(20)}`
  writeFileSync(join(secretCwd, '.env.production'), `API_TOKEN=${injected}\n`)
  const secretResult = scanSecrets({ cwd: secretCwd, trackedPaths: [], globbedPaths: ['.env.production'] })

  const executed = ['npm run build', 'supabase config validate', 'git rev-parse HEAD', 'node scripts/emit-pages-plan.mjs']
  const commandVerdict = evaluateCommandList(executed)
  const configStep = makeConfigValidateStep({ binaryAvailable: true, output: 'ok\n', exitCode: 0 })

  const distCwd = mkdtempSync(join(tmpdir(), 'opencode-p3-dist-'))
  mkdirSync(join(distCwd, 'dist/assets'), { recursive: true })
  const headers = substituteProjectRef(readFileSync(join(root, 'public/_headers'), 'utf8'), FAKE_ENV.SUPABASE_PROJECT_REF)
  writeFileSync(join(distCwd, 'dist/_headers'), headers)
  writeFileSync(join(distCwd, 'dist/index.html'), '<!doctype html><html><body>ok</body></html>')
  writeFileSync(join(distCwd, 'dist/assets/app.js'), 'console.log("ok")\n')
  const distErrors = checkDist({ cwd: distCwd })

  const plan = buildPagesPlan()
  const report = buildReport({
    commit: 'e4c981c',
    cliVersions: {
      node: 'v26.7.0',
      npm: '11.19.0',
      supabase: { path: '~/.local/bin/supabase', version: '2.121.0', sha256: 'a'.repeat(64) },
      wrangler: 'not-installed',
    },
    commandsExecuted: executed,
    checks: [{ id: 'IN-4', status: 'PASS', evidence: 'count=0' }],
    pagesPlan: plan,
  })

  const p3 = [
    guardFixture.count === 8 && guardClean.count === 0 && guardClean.verbSource.sha256 === MUTATING_VERBS_SHA256,
    secretResult.secretsFound > 0 && secretResult.findings.every((f) => f.redacted === true),
    commandVerdict.rejected.length === 0,
    configStep.ok === true && configStep.remoteAttempt === false,
    distErrors.length === 0 && [...projectRefsInText(headers)].join() === 'zzfake00000000000000',
    isPagesPlanValid(plan) === true && plan.mutationExecuted === false,
    validateReport(report).ok === true && !JSON.stringify(report).includes('/home/'),
  ]
  assert.equal(p3.filter(Boolean).length, 7, `gate P3: ${JSON.stringify(p3)}`)
  assert.equal(p3.every(Boolean), true)
  assert.equal(findSecretPatterns(JSON.stringify(secretResult)).length > 0, false)
  assert.equal(JSON.stringify(secretResult).includes(injected), false)
})
