import { test } from '../testing/test-shim.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTATING_VERBS_SHA256, loadVerbs, scan } from '../guard-mutating-verbs.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = join(root, 'scripts/__tests__/fixtures/mutating-verbs-8.txt')
const fixture = readFileSync(fixturePath, 'utf8')
const MARKER = '<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->'
const RUNBOOK = `# Validação (executável agora)\nconteúdo de validação\n${MARKER}\n# Aplicação (somente humano, após aprovação)\nconteúdo humano\n`
const EMPTY_RUNBOOK = `# Validação (executável agora)\n${MARKER}\n# Aplicação (somente humano, após aprovação)\nconteúdo humano\n`

function cleanSources() {
  const names = ['validate-deploy.mjs', 'guard-mutating-verbs.mjs', 'scan-secrets.mjs', 'emit-pages-plan.mjs']
  const sources = names.map((name) => ({
    path: `scripts/${name}`,
    text: readFileSync(join(root, 'scripts', name), 'utf8'),
  }))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  sources.push({ path: 'package.json', scripts: pkg.scripts })
  return sources
}

test('deve_barrar_24_verbos_e_variantes_dry_run_com_count_8_na_fixture', () => {
  const verbs = loadVerbs()
  assert.equal(verbs.verbs.length, 24)
  assert.equal(verbs.sha256, MUTATING_VERBS_SHA256)

  const result = scan({ text: fixture, scope: 'validation', runbookText: RUNBOOK, sources: [] })
  assert.equal(result.count, 8)
  assert.equal(result.blocked.length, 8)
  assert.equal(result.verbSource.verbs, 24)
  assert.equal(result.verbSource.sha256, MUTATING_VERBS_SHA256)
  assert.equal(result.ok, false)

  const variants = [
    'SUPABASE   LINK',
    'supabase\n   db push --dry-run',
    '# comentário de shell\nsupabase secrets unset --dry-run',
    'supabase pull --dry-run',
    'supabase config pull --dry-run',
    'wrangler pages deploy dist',
  ].join('\n')
  const variantResult = scan({ text: variants, scope: 'validation', runbookText: RUNBOOK, sources: [] })
  assert.equal(variantResult.count, 6, 'maiúsculas, quebras, comentário e --dry-run casam')

  const outOfScope = scan({ text: fixture, scope: 'application', runbookText: RUNBOOK, sources: [] })
  assert.equal(outOfScope.count, 0)

  const noMarker = scan({ text: fixture, runbookText: RUNBOOK.replace(MARKER, ''), sources: [] })
  assert.equal(noMarker.ok, false)
  assert.ok(noMarker.count > 0)

  const twoMarkers = scan({ text: fixture, runbookText: RUNBOOK.replace(MARKER, `${MARKER}\n${MARKER}`), sources: [] })
  assert.equal(twoMarkers.ok, false)
  assert.ok(twoMarkers.count > 0)

  const emptySection = scan({ text: fixture, runbookText: EMPTY_RUNBOOK, sources: [] })
  assert.equal(emptySection.ok, false)
  assert.ok(emptySection.count > 0)
})

test('deve_passar_com_implementacao_limpa_quando_verbos_aparecem_apenas_em_dados_marcados', () => {
  const sources = cleanSources()
  const clean = scan({
    text: '',
    scope: 'validation',
    runbookText: RUNBOOK,
    sources,
    packageJsonDiff: execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json'], {
      cwd: root,
      encoding: 'utf8',
    }).length === 0 ? 'clean' : 'dirty',
  })
  assert.equal(clean.count, 0)
  assert.equal(clean.ok, true)
  assert.equal(clean.packageJsonDiff, 'clean')

  const dir = mkdtempSync(join(tmpdir(), 'opencode-guard-'))
  const badData = join(dir, 'mutating-verbs.json')
  const bytes = readFileSync(join(root, 'scripts/data/mutating-verbs.json'))
  const tampered = Buffer.from(bytes)
  tampered[1] = 0x58 // altera 1 byte sem tocar no original
  writeFileSync(badData, tampered)
  const badHash = scan({ text: '', runbookText: RUNBOOK, sources, verbPath: badData })
  assert.equal(badHash.ok, false)
  assert.ok(badHash.count > 0)
  assert.ok(badHash.blocked.some((b) => b.reason === 'verb-source-integrity'))

  const injected = [
    ...sources.slice(0, 1).map((s) => ({ ...s, text: `${s.text}\nspawn("supabase", ["db", "push"])\n` })),
    ...sources.slice(1),
  ]
  const malicious = scan({ text: '', runbookText: RUNBOOK, sources: injected })
  assert.equal(malicious.ok, false)
  assert.ok(malicious.blocked.some((b) => b.verb === 'supabase db push'))
  assert.equal(malicious.blocked[0].file, 'scripts/validate-deploy.mjs')

  const unexempted = scan({
    text: '',
    runbookText: RUNBOOK,
    sources: [{ path: 'scripts/allowed.mjs', text: 'exec("supabase config validate")\n' }],
  })
  assert.equal(unexempted.ok, false, 'comando permitido sem guard-exempt: falha fechado')

  const exempted = scan({
    text: '',
    runbookText: RUNBOOK,
    sources: [{
      path: 'scripts/allowed.mjs',
      text: '/* guard-exempt: reason=allowlist IN-3 comando local read-only */\nexec("supabase config validate")\n',
    }],
  })
  assert.equal(exempted.count, 0)
  assert.equal(exempted.exemptions.length, 1)
  assert.ok(exempted.exemptions[0].reason.includes('allowlist'))

  const badReason = scan({
    text: '',
    runbookText: RUNBOOK,
    sources: [{ path: 'scripts/allowed.mjs', text: '/* guard-exempt: curto */\nexec("supabase config validate")\n' }],
  })
  assert.equal(badReason.ok, false)

  const dirty = scan({ text: '', runbookText: RUNBOOK, sources, packageJsonDiff: 'dirty' })
  assert.equal(dirty.ok, false)
  assert.equal(dirty.packageJsonDiff, 'dirty')

  const scriptVerb = scan({
    text: '',
    runbookText: RUNBOOK,
    sources: [{ path: 'package.json', scripts: { deploy: 'wrangler pages deploy dist' } }],
  })
  assert.equal(scriptVerb.ok, false)
  assert.ok(scriptVerb.count > 0)
})
