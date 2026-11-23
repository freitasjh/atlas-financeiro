import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from '../testing/test-shim.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runbookPath = resolve(root, '.doc/runbook-deploy-primeiro-corte.md')
const MARKER = '<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->'
const VALIDATION_TITLE = '# Validação (executável agora)'
const APPLICATION_TITLE = '# Aplicação (somente humano, após aprovação)'

function stripDiacritics(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function configPairs(section) {
  const pairs = []
  for (const line of String(section ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim().replace(/^`|`$/g, ''))
    const key = cells[1] ?? ''
    const value = cells[2] ?? ''
    const match = key.match(/(enable_signup|enable_confirmations|enroll_enabled|verify_enabled)/)
    if (match && /^(true|false)$/i.test(value)) pairs.push(`${match[1]}=${value.toLowerCase()}`)
  }
  return pairs
}

function checklist(text) {
  const markerCount = text.split(MARKER).length - 1
  const markerIndex = text.indexOf(MARKER)
  const validation = markerIndex >= 0 ? text.slice(0, markerIndex) : text
  const application = markerIndex >= 0 ? text.slice(markerIndex + MARKER.length) : ''
  const validationNormalized = stripDiacritics(validation)
  const activeIndex = validation.indexOf('active = true')
  const migrationIndex = validation.indexOf('0051_operator_gate.sql')
  const pushIndex = validation.indexOf('supabase db push')
  return {
    markerCount,
    validationBeforeMarker: validation.includes(VALIDATION_TITLE),
    applicationAfterMarker: application.includes(APPLICATION_TITLE),
    values: configPairs(validation),
    simCount: (validation.match(/\*\*SIM\*\*/g) ?? []).length,
    hasCopyWarning: validationNormalized.includes('nao copiar `config.toml` local'),
    bootstrapOrderOk: activeIndex >= 0 && migrationIndex > activeIndex && pushIndex > migrationIndex,
    applicationIrreversible: /irreversib/i.test(application) && /Direct Upload/i.test(application),
    applicationHasWorkerDeploy: /wrangler deploy\b/.test(application),
  }
}

test('deve_listar_cinco_valores_com_duas_divergencias_e_ordem_bootstrap_antes_da_0051', () => {
  const text = readFileSync(runbookPath, 'utf8')
  const result = checklist(text)

  assert.equal(result.markerCount, 1)
  assert.equal(result.validationBeforeMarker, true)
  assert.equal(result.applicationAfterMarker, true)

  assert.deepEqual(result.values.sort(), [
    'enable_confirmations=true',
    'enable_signup=false',
    'enable_signup=true',
    'enroll_enabled=false',
    'verify_enabled=true',
  ])
  assert.equal(result.simCount, 2)
  assert.equal(result.hasCopyWarning, true)
  assert.equal(result.bootstrapOrderOk, true)
  assert.equal(result.applicationIrreversible, true)
  assert.equal(result.applicationHasWorkerDeploy, false)

  // Contraprova: nenhum mutante é tolerado.
  assert.equal(checklist(text.replace('verify_enabled` | `true`', 'verify_enabled` | `false`')).values.includes('verify_enabled=true'), false)
  assert.equal(checklist(text.replace(MARKER, `**SIM**\n${MARKER}`)).simCount, 3)
  assert.equal(checklist(text.replace('não copiar `config.toml` local', 'copiar `config.toml` local')).hasCopyWarning, false)

  const reversed = `${VALIDATION_TITLE}\nactive = true\nsupabase db push\n0051_operator_gate.sql\n${MARKER}\n${APPLICATION_TITLE}\nirreversibilidade Direct Upload\n`
  assert.equal(checklist(reversed).bootstrapOrderOk, false)
  assert.equal(checklist(`${text}\nwrangler deploy --name exemplo\n`).applicationHasWorkerDeploy, true)
  assert.equal(checklist(text.replace(MARKER, '')).markerCount, 0)
  assert.equal(checklist(text.replace(MARKER, `${MARKER}\n${MARKER}`)).markerCount, 2)
})
