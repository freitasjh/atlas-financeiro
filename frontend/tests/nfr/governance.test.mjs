// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { DEBT_MARKER, debtHits, gitDiff, sectionOf, sourceFiles, specText } from '../helpers/scan.ts'

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

  it('zero rota inventada e zero chamada de rede no código frontend-native', () => {
    const net = 'fet' + 'ch'
    const xhr = 'XMLHttp' + 'Request'
    const hits = sourceFiles()
      .filter((f) => !f.rel.startsWith('src/'))
      .filter((f) => new RegExp(`\\b${net}\\s*\\(|${xhr}`).test(f.text))
      .map((f) => f.rel)
    expect(hits).toEqual([])
    expect(gitDiff(['backend/apps']).trim()).toBe('')
  })

  it('zero segredo, dívida localizada e protected path intacto', () => {
    expect(debtHits()).toEqual([])
    expect(gitDiff(['harness.config.json']).trim()).toBe('')
    expect(DEBT_MARKER).toContain('SUPABASE')
  })
})
