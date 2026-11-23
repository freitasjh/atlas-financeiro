import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { loadVerbs } from '../guard-mutating-verbs.mjs'
import { refuse } from '../testing/shim-cli.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shimPath = join(root, 'scripts/testing/shim-cli.mjs')
const fixture = readFileSync(join(root, 'scripts/__tests__/fixtures/mutating-verbs-8.txt'), 'utf8')
const commands = fixture.split(/\r?\n/).filter(Boolean)

test('deve_recusar_os_oito_verbos_mutantes_com_zero_execucao_real_e_nao_ser_referenciado_em_producao', () => {
  assert.equal(commands.length, 8)
  const refused = commands.filter((command) => refuse(command))
  assert.equal(refused.length, 8)

  const withoutSecretsSet = loadVerbs().verbs.filter((v) => v !== 'supabase secrets set' && v !== 'secrets set')
  assert.equal(commands.filter((command) => refuse(command, { verbs: withoutSecretsSet })).length, 7)

  const run = spawnSync(process.execPath, [shimPath, 'supabase', 'secrets', 'set'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  assert.ok(run.stdout.includes('RECUSADO'))
  assert.ok(run.stdout.includes('pattern='))
  assert.equal(run.stdout.includes('supabase secrets set'), false)

  const production = readFileSync(join(root, 'scripts/validate-deploy.mjs'), 'utf8')
  assert.equal(production.includes('shim-cli'), false)

  const shimSource = readFileSync(shimPath, 'utf8')
  assert.equal(shimSource.includes('child_process'), false)
  assert.equal(refuse('npm run build'), false)
})
