import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDist, projectRefsInText, substituteProjectRef } from '../../scripts/check-dist.mjs'
import { FAKE_ENV, makeValidationEnv, validateValidationEnv } from '../validate-deploy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('deve_aceitar_ref_sintetico_e_rejeitar_env_com_segredo_real_com_redacao', () => {
  assert.equal(FAKE_ENV.VITE_SUPABASE_URL, 'https://zzfake00000000000000.supabase.co')
  assert.equal(FAKE_ENV.SUPABASE_PROJECT_REF, 'zzfake00000000000000')
  assert.equal(FAKE_ENV.VITE_SUPABASE_ANON_KEY, 'fake-anon-key-not-a-jwt')
  assert.equal(FAKE_ENV.NODE_ENV, 'production')

  const env = makeValidationEnv({ PATH: '/usr/bin' })
  assert.equal(env.NODE_ENV, 'production')
  assert.equal(env.VITE_SUPABASE_URL, FAKE_ENV.VITE_SUPABASE_URL)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(validateValidationEnv(env).ok, true)

  const secret = `sb_secret_${'a'.repeat(20)}`
  const bad = makeValidationEnv({ SUPABASE_SERVICE_ROLE_KEY: secret })
  const verdict = validateValidationEnv(bad)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.findings.some((f) => f.patternId === 'sb-secret'))
  assert.equal(JSON.stringify(verdict).includes(secret), false)

  const jwtAnon = makeValidationEnv({ VITE_SUPABASE_ANON_KEY: `eyJ${'a'.repeat(20)}` })
  assert.equal(validateValidationEnv(jwtAnon).ok, false)
  const localHost = makeValidationEnv({ VITE_SUPABASE_URL: 'http://localhost:54321' })
  assert.equal(validateValidationEnv(localHost).ok, false)
  const placeholder = makeValidationEnv({ VITE_SUPABASE_URL: 'https://REPLACE_WITH_PROJECT_REF.supabase.co' })
  assert.equal(validateValidationEnv(placeholder).ok, false)

  const cwd = mkdtempSync(join(tmpdir(), 'opencode-dist-'))
  mkdirSync(join(cwd, 'dist/assets'), { recursive: true })
  const template = readFileSync(join(root, 'public/_headers'), 'utf8')
  const headers = substituteProjectRef(template, FAKE_ENV.SUPABASE_PROJECT_REF)
  writeFileSync(join(cwd, 'dist/_headers'), headers)
  writeFileSync(join(cwd, 'dist/index.html'), '<!doctype html><html><body>ok</body></html>')
  writeFileSync(join(cwd, 'dist/assets/app.js'), 'console.log("ok")\n')

  assert.deepEqual(checkDist({ cwd }), [])
  assert.deepEqual([...projectRefsInText(headers)], ['zzfake00000000000000'])
  assert.equal(headers.includes('REPLACE_WITH_'), false)
  assert.equal(headers.includes("frame-ancestors 'none'"), true)

  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'scripts/check-dist.mjs'], { cwd: root })
})
