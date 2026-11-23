import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { evaluateCommandList, makeConfigValidateStep } from '../validate-deploy.mjs'

test('deve_registrar_config_validate_sem_flags_deprecados_e_sem_chamada_remota', () => {
  const step = makeConfigValidateStep({ binaryAvailable: true, output: 'config validated\n', exitCode: 0 })
  assert.equal(step.command, 'supabase config validate')
  assert.ok(step.evidence.length > 0)
  assert.equal(step.evidence.includes('config validated'), false, 'saída bruta não é registrada')
  assert.equal(step.remoteAttempt, false)
  assert.deepEqual(step.deprecatedFlags, [])
  assert.equal(step.ok, true)

  assert.equal(evaluateCommandList(['supabase config validate --linked']).rejected.length, 1)
  assert.equal(evaluateCommandList(['supabase config validate --project-ref abc']).rejected.length, 1)
  assert.equal(evaluateCommandList(['supabase db push --dry-run']).rejected.length, 1)

  const missing = makeConfigValidateStep({ binaryAvailable: false })
  assert.equal(missing.ok, true)
  assert.equal(missing.evidence.includes('not-installed'), true)
  assert.match(missing.evidence, /2026-11-22/)

  const unlinked = makeConfigValidateStep({
    binaryAvailable: true,
    output: 'sem projeto linkado\n',
    exitCode: 1,
    acceptUnlinkedExit: true,
  })
  assert.equal(unlinked.acceptUnlinkedExit, true)
  assert.equal(unlinked.ok, true, 'exit=1 sem link é aceito quando declarado')

  const unlinkedStrict = makeConfigValidateStep({
    binaryAvailable: true,
    output: 'sem projeto linkado\n',
    exitCode: 1,
  })
  assert.equal(unlinkedStrict.ok, false, 'sem acceptUnlinkedExit, exit=1 falha')

  const unlinkedRemote = makeConfigValidateStep({
    binaryAvailable: true,
    output: 'sem projeto linkado\n',
    exitCode: 1,
    acceptUnlinkedExit: true,
    remoteAttempt: true,
  })
  assert.equal(unlinkedRemote.ok, false, 'remoteAttempt nunca é aceito')

  const empty = makeConfigValidateStep({ binaryAvailable: true, output: '', exitCode: 0 })
  assert.equal(empty.ok, false, 'evidência vazia falha fechado')

  const remote = makeConfigValidateStep({ binaryAvailable: true, output: 'ok', exitCode: 0, remoteAttempt: true })
  assert.equal(remote.ok, false)
})
