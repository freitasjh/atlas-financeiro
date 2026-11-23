import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { buildPagesPlan, isPagesPlanValid, PAGES_PLAN } from '../emit-pages-plan.mjs'
import { scan } from '../guard-mutating-verbs.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const emitterPath = join(root, 'scripts/emit-pages-plan.mjs')
const MARKER = '<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->'
const RUNBOOK = `# Validação (executável agora)\nconteúdo\n${MARKER}\n# Aplicação (somente humano, após aprovação)\nconteúdo\n`

const EXPECTED = {
  schema: 'pages-plan/v1',
  mode: 'validation',
  project: '<PLACEHOLDER_PAGES_PROJECT>',
  branch: '<PLACEHOLDER_BRANCH>',
  directory: 'dist',
  intendedCommands: [
    'npm run build',
    'npx wrangler pages deploy dist --project-name <PLACEHOLDER_PAGES_PROJECT> --branch <PLACEHOLDER_BRANCH>',
  ],
  mutationExecuted: false,
  notes: ['wrangler pages deploy nao tem --dry-run na doc consultada em 2026-11-22'],
}

test('deve_emitir_exatamente_um_objeto_pages_plan_v1_sem_spawn_de_wrangler', () => {
  assert.deepEqual(buildPagesPlan(), EXPECTED)
  assert.deepEqual(PAGES_PLAN, EXPECTED)
  assert.equal(isPagesPlanValid(buildPagesPlan()), true)

  const run = spawnSync(process.execPath, [emitterPath], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0)
  assert.equal(run.stderr, '')
  const parsed = JSON.parse(run.stdout)
  assert.deepEqual(parsed, EXPECTED)
  assert.equal(run.stdout.trim().startsWith('{'), true)
  assert.equal(run.stdout.trim().endsWith('}'), true)

  assert.equal(isPagesPlanValid({ ...EXPECTED, mutationExecuted: true }), false)
  assert.equal(isPagesPlanValid({ ...EXPECTED, project: 'real-project' }), false)
  assert.equal(isPagesPlanValid({ ...EXPECTED, notes: ['sem fonte'] }), false)
  assert.equal(isPagesPlanValid({ ...EXPECTED, intendedCommands: [EXPECTED.intendedCommands[0], 'npx wrangler pages deploy dist --dry-run'] }), false)

  const source = readFileSync(emitterPath, 'utf8')
  assert.equal(/spawn\s*\(\s*['"]wrangler/.test(source), false)
  assert.equal(/child_process/.test(source), false)
})

test('deve_nao_tratar_literais_de_plano_e_relatorio_como_sitios_executaveis', () => {
  const literalSource = 'const plan = ' + JSON.stringify(EXPECTED) + '\n'
  const literalScan = scan({ text: '', runbookText: RUNBOOK, sources: [{ path: 'scripts/emit-pages-plan.mjs', text: literalSource }] })
  assert.equal(literalScan.count, 0, 'literal de plano é dado, não sítio executável')

  const executable = scan({
    text: '',
    runbookText: RUNBOOK,
    sources: [{ path: 'scripts/emit-pages-plan.mjs', text: 'spawn("wrangler", ["pages", "deploy"])\n' }],
  })
  assert.equal(executable.ok, false)
  assert.ok(executable.count > 0)

  const reportLiteral = 'const report = ' + JSON.stringify({ schema: 'deploy-validation/v1', notes: ['pages deploy'] }) + '\n'
  const reportScan = scan({ text: '', runbookText: RUNBOOK, sources: [{ path: 'scripts/validate-deploy.mjs', text: reportLiteral }] })
  assert.equal(reportScan.count, 0)
})
