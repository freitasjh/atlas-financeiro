// @vitest-environment happy-dom
// O2.3 — applyRules puro: keyword→category_id, primeira vence por prioridade,
// nunca sobrescreve categoria manual; sem regra = null.
import { describe, expect, it } from 'vitest'
import { applyRules, type RuleLike, type StagedLike } from '../applyRules'

function row(description: string, category_id: string | null = null): StagedLike {
  return { description, category_id }
}

const RULES: RuleLike[] = [
  { keyword: 'pix', category_id: 'cat-pix', priority: 10 },
  { keyword: 'pix recebido', category_id: 'cat-pix-in', priority: 1 },
]

describe('whenDescriptionMatchesRule_thenFirstByPriorityWins', () => {
  it('PIX RECEBIDO casa a regra mais prioritária', () => {
    const out = applyRules([row('PIX RECEBIDO de João')], RULES)
    expect(out[0].category_id).toBe('cat-pix-in')
  })

  it('match é case-insensitive e por substring', () => {
    const out = applyRules([row('pagamento Pix loja')], RULES)
    expect(out[0].category_id).toBe('cat-pix')
  })
})

describe('whenNoRuleMatches_thenCategoryStaysNull', () => {
  it('sem regra = category_id null', () => {
    const out = applyRules([row('Boleto condomínio')], RULES)
    expect(out[0].category_id).toBeNull()
  })

  it('lista de regras vazia mantém null', () => {
    const out = applyRules([row('PIX RECEBIDO de João')], [])
    expect(out[0].category_id).toBeNull()
  })
})

describe('whenRowHasManualCategory_thenRulesNeverOverwrite', () => {
  it('categoria manual sobrevive ao apply', () => {
    const out = applyRules([row('PIX RECEBIDO de João', 'cat-manual')], RULES)
    expect(out[0].category_id).toBe('cat-manual')
  })

  it('não muta o array de entrada', () => {
    const input = [row('PIX RECEBIDO')]
    const snapshot = [...input]
    applyRules(input, RULES)
    expect(input).toEqual(snapshot)
  })
})
