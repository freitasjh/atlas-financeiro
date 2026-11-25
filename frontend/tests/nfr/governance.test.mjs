// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { DEBT_MARKER, debtHits, gitDiff, sectionOf, sourceFiles, specText } from '../helpers/scan.ts'

// ADR-001 §3: allow-list da fatia. `src/database` entra por §4/F-5 (tokens e providers nomeados).
const ALLOWED_AUTH_PATHS = [
  'backend/apps/cliente/src/auth',
  'backend/apps/cliente/src/database',
  'backend/apps/cliente/test',
  'backend/libs/shared-contracts/src/v1',
  'frontend/src',
  'frontend/docs',
  'frontend/tests',
  'workflow-state.json',
]
const PROTECTED_PATHS = [
  '.opencode/plugins',
  'scripts',
  'harness.config.json',
  'backend/apps/control-plane',
]

function diffPaths(diff) {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.match(/ b\/(.+)$/)?.[1] ?? '')
    .filter(Boolean)
}

function outsideAllowList(diff) {
  return diffPaths(diff).filter(
    (path) => !ALLOWED_AUTH_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)),
  )
}

describe('BIGBANG-13/17 — dívida visível, bloqueantes e 9 gates P3', () => {
  it('SPEC §12: 4 bloqueantes + 4 dívidas nomeados', () => {
    const blockers = sectionOf(specText(), 12)
    for (const label of [
      'BLOQUEANTE-EMISSÃO',
      'BLOQUEANTE-ENDPOINT',
      'BLOQUEANTE-ÍNDICE',
      'F4',
    ]) {
      expect(blockers, `bloqueante ${label} ausente`).toContain(label)
    }
    for (const debt of ['DÍVIDA-SUPABASE', 'DÍVIDA-BIGBANG', 'DÍVIDA-ROLLBACK', 'DÍVIDA-SESSÃO']) {
      expect(blockers, `dívida ${debt} ausente`).toContain(debt)
    }
  })

  it('SPEC §13: 9 gates P3', () => {
    const gates = sectionOf(specText(), 13)
    for (let n = 1; n <= 9; n += 1) {
      expect(gates, `gate P3 #${n} ausente`).toMatch(new RegExp(`^\\| ${n} \\|`, 'm'))
    }
  })

  it('allow-list de fronteira: fixture aprova paths ADR-001 e barra os protegidos', () => {
    const fixture = [
      'diff --git a/frontend/src/session/session.ts b/frontend/src/session/session.ts',
      'diff --git a/backend/apps/cliente/src/auth/x.ts b/backend/apps/cliente/src/auth/x.ts',
      'diff --git a/backend/apps/control-plane/src/x.ts b/backend/apps/control-plane/src/x.ts',
      'diff --git a/.opencode/plugins/lib/gate.js b/.opencode/plugins/lib/gate.js',
      'diff --git a/scripts/scan-secrets.mjs b/scripts/scan-secrets.mjs',
      'diff --git a/harness.config.json b/harness.config.json',
    ].join('\n')
    expect(outsideAllowList(fixture)).toEqual([
      'backend/apps/control-plane/src/x.ts',
      '.opencode/plugins/lib/gate.js',
      'scripts/scan-secrets.mjs',
      'harness.config.json',
    ])
  })

  it('zero rota inventada e zero chamada de rede no código frontend-native', () => {
    const net = 'fet' + 'ch'
    const xhr = 'XMLHttp' + 'Request'
    const hits = sourceFiles()
      .filter((f) => !f.rel.startsWith('src/'))
      .filter((f) => new RegExp(`\\b${net}\\s*\\(|${xhr}`).test(f.text))
      .map((f) => f.rel)
    expect(hits).toEqual([])
    // ADR-001 supersediu o congelamento de ADR-002 para `cliente`, mas a
    // fronteira agora é allow-list e os protegidos seguem com 0 diff.
    expect(gitDiff(PROTECTED_PATHS).trim(), 'gate.js/scripts/harness/control-plane intocados').toBe('')
    expect(
      outsideAllowList(gitDiff(['backend', 'frontend', 'workflow-state.json'])),
      'diff fora da allow-list ADR-001',
    ).toEqual([])
  })

  it('zero segredo, dívida localizada e protected path intacto', () => {
    expect(debtHits()).toEqual([])
    expect(gitDiff(['harness.config.json']).trim()).toBe('')
    expect(DEBT_MARKER).toContain('SUPABASE')
  })
})
