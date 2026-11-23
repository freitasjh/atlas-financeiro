import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { checkRunbookStructure, scan } from '../guard-mutating-verbs.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runbookPath = resolve(root, '.doc/runbook-deploy-primeiro-corte.md')
const MARKER = '<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->'
const VALIDATION_TITLE = '# Validação (executável agora)'
const APPLICATION_TITLE = '# Aplicação (somente humano, após aprovação)'

test('deve_exigir_um_unico_marcador_de_separacao_e_duas_secoes_nomeadas', () => {
  const text = readFileSync(runbookPath, 'utf8')
  const count = text.split(MARKER).length - 1
  assert.equal(count, 1, 'marcador de separação deve ocorrer exatamente uma vez')
  assert.ok(text.includes(VALIDATION_TITLE))
  assert.ok(text.includes(APPLICATION_TITLE))
  assert.ok(text.indexOf(VALIDATION_TITLE) < text.indexOf(MARKER))
  assert.ok(text.indexOf(APPLICATION_TITLE) > text.indexOf(MARKER))
  assert.ok(text.indexOf('## Índice') > -1)
  assert.ok(text.indexOf('## Índice') < text.indexOf(VALIDATION_TITLE))
  assert.equal(checkRunbookStructure(text).ok, true)

  const withoutMarker = checkRunbookStructure(text.replace(MARKER, ''))
  assert.equal(withoutMarker.ok, false)
  assert.ok(withoutMarker.errors.some((e) => e.includes('marcador')))

  const duplicated = checkRunbookStructure(text.replace(MARKER, `${MARKER}\n${MARKER}`))
  assert.equal(duplicated.ok, false)

  const renamed = checkRunbookStructure(text.replace(APPLICATION_TITLE, '# Deploy'))
  assert.equal(renamed.ok, false)

  const applicationText = text.slice(text.indexOf(MARKER) + MARKER.length)
  assert.ok(/pages deploy/.test(applicationText), 'seção de aplicação nomeia o verbo')
  const scoped = scan({ text: applicationText, scope: 'application', runbookText: text, sources: [] })
  assert.equal(scoped.count, 0, 'texto da seção de aplicação está fora do escopo executável')
})
