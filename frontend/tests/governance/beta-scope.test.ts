// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { DEBT_MARKER, forbiddenHits, gitDiff, secretPatternHits, sectionOf, specText } from '../helpers/scan'

describe('BIGBANG-08 — beta sem meio de cobrança, gate não removido (H1/H2)', () => {
  it('zero assinatura de meio de cobrança no código frontend-native', () => {
    const scope = ['payA', 'payB', 'payC', 'payD'] as const
    expect(forbiddenHits().filter((h) => (scope as readonly string[]).includes(h.token))).toEqual([])
  })

  it('zero padrão de credencial real (gate ativo, não asserção morta)', () => {
    expect(secretPatternHits()).toEqual([])
    expect(Object.keys(forbiddenHits().reduce<Record<string, number>>((acc, h) => {
      acc[h.token] = (acc[h.token] ?? 0) + 1
      return acc
    }, {}))).not.toContain('keyMaterial')
  })

  it('gate antigo foi substituído, não apagado; dívida localizada', () => {
    expect(gitDiff(['harness.config.json']).trim()).toBe('')
    const sec12 = sectionOf(specText(), 12)
    expect(sec12).toContain('DÍVIDA-SUPABASE')
    expect(sec12).toContain('registrada, não executada')
    expect(DEBT_MARKER).toContain('SUPABASE')
  })
})
