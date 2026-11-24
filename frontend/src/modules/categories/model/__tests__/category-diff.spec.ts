// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { diffCategoryPatch } from '../category-diff'

// C2.3 (nit review Batch 1) — update vazio: early-return sem chamar o servidor.
describe('whenCategoryUpdateHasNoChanges_thenDiffReturnsNull', () => {
  it('patch idêntico ao atual retorna null', () => {
    expect(
      diffCategoryPatch(
        { name: 'Mercado', type: 'expense', color: '#22c55e' },
        { name: 'Mercado', type: 'expense', color: '#22c55e' },
      ),
    ).toBeNull()
  })

  it('nome com só espaços a mais é tratado como igual (trim)', () => {
    expect(
      diffCategoryPatch(
        { name: 'Mercado', type: 'expense', color: null },
        { name: '  Mercado  ', type: 'expense', color: null },
      ),
    ).toBeNull()
  })

  it('mudança real retorna só o patch alterado', () => {
    expect(
      diffCategoryPatch(
        { name: 'Mercado', type: 'expense', color: null },
        { name: 'Mercado Mensal', type: 'expense', color: null },
      ),
    ).toEqual({ name: 'Mercado Mensal' })
  })

  it('troca de tipo e cor compõe o patch', () => {
    expect(
      diffCategoryPatch(
        { name: 'Freela', type: 'expense', color: null },
        { name: 'Freela', type: 'income', color: '#0ea5e9' },
      ),
    ).toEqual({ type: 'income', color: '#0ea5e9' })
  })
})
