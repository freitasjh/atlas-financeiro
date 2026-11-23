import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ALLOWED_COMMANDS, evaluateCommandList, isAllowedCommand } from '../validate-deploy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('deve_retornar_exit_1_para_comando_fora_da_allowlist_IN3_e_exit_0_para_lista_fechada', () => {
  const closed = [
    'node scripts/validate-deploy.mjs',
    'node scripts/check-dist.mjs',
    'npm run build',
    'supabase --version',
    'supabase config validate',
    'wrangler --version',
    'git rev-parse HEAD',
    'node scripts/emit-pages-plan.mjs',
  ]
  assert.ok(ALLOWED_COMMANDS.includes('supabase config validate'))
  assert.equal(evaluateCommandList(closed).rejected.length, 0)
  assert.equal(evaluateCommandList(closed).allowed.length, closed.length)

  const withLink = evaluateCommandList([...closed, 'supabase link'])
  assert.equal(withLink.rejected.length, 1)
  assert.equal(withLink.rejected[0], 'supabase link')

  const withPagesDeploy = evaluateCommandList([...closed, 'wrangler pages deploy dist'])
  assert.equal(withPagesDeploy.rejected.length, 1)
  assert.equal(withPagesDeploy.exitCode, 1)

  const withoutConfigValidate = ALLOWED_COMMANDS.filter((c) => c !== 'supabase config validate')
  assert.equal(isAllowedCommand('supabase config validate', { allowlist: withoutConfigValidate }), false)

  assert.equal(isAllowedCommand(['supabase', 'config', 'validate']), true)
  assert.equal(isAllowedCommand('supabase config validate --linked'), false)
  assert.equal(isAllowedCommand('supabase db push --dry-run'), false)

  const source = readFileSync(resolve(root, 'scripts/validate-deploy.mjs'), 'utf8')
  assert.equal(source.includes('shim-cli'), false)
  assert.equal(/spawn\s*\(\s*['"]supabase/.test(source), false)
  assert.equal(/spawn\s*\(\s*['"]wrangler/.test(source), false)
})
