import { describe, expect, it } from 'vitest'
import {
  buildUsageCounts,
  categorySchema,
  categoryUpdateSchema,
  isSystem,
} from '../category'

// C1.1 — model zod + isSystem defensivo + usageCount via Map (sem N+1).

describe('whenCategoryNameIsValidated_thenTrimAndLengthAreEnforced', () => {
  it('aceita nome válido com trim', () => {
    const parsed = categorySchema.parse({ name: '  Alimentação  ', type: 'expense' })
    expect(parsed.name).toBe('Alimentação')
  })

  it('recusa nome vazio ou só espaços', () => {
    expect(() => categorySchema.parse({ name: '   ', type: 'expense' })).toThrow()
    expect(() => categorySchema.parse({ name: '', type: 'expense' })).toThrow()
  })

  it('recusa nome com mais de 120 caracteres', () => {
    expect(() => categorySchema.parse({ name: 'x'.repeat(121), type: 'expense' })).toThrow()
    expect(categorySchema.parse({ name: 'x'.repeat(120), type: 'expense' }).name).toHaveLength(120)
  })
})

describe('whenCategoryTypeIsValidated_thenOnlyIncomeOrExpensePass', () => {
  it('aceita income e expense', () => {
    expect(categorySchema.parse({ name: 'Salário', type: 'income' }).type).toBe('income')
    expect(categorySchema.parse({ name: 'Aluguel', type: 'expense' }).type).toBe('expense')
  })

  it('recusa tipo desconhecido', () => {
    expect(() => categorySchema.parse({ name: 'X', type: 'transfer' })).toThrow()
    expect(() => categorySchema.parse({ name: 'X' })).toThrow()
  })
})

describe('whenCategoryColorIsValidated_thenTrimMax32Nullish', () => {
  it('aceita cor válida, null e ausente', () => {
    expect(categorySchema.parse({ name: 'X', type: 'expense', color: ' #ff0808 ' }).color).toBe(
      '#ff0808',
    )
    expect(categorySchema.parse({ name: 'X', type: 'expense', color: null }).color).toBeNull()
    expect(categorySchema.parse({ name: 'X', type: 'expense' }).color).toBeNull()
  })

  it('recusa cor com mais de 32 caracteres', () => {
    expect(() =>
      categorySchema.parse({ name: 'X', type: 'expense', color: 'x'.repeat(33) }),
    ).toThrow()
  })
})

describe('whenParentIdIsProvided_thenItIsIgnoredWithFollowUpNote', () => {
  it('tolera parent_id mas o remove do resultado (modelo plano congelado)', () => {
    // Follow-up: subcategorias (parent_id) fora de escopo — SPEC §4.
    // O campo é tolerado na entrada e descartado: nunca chega ao service.
    const parsed = categorySchema.parse({
      name: 'Filha',
      type: 'expense',
      parent_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(parsed).not.toHaveProperty('parent_id')
  })

  it('update também ignora parent_id', () => {
    const parsed = categoryUpdateSchema.parse({
      name: 'Nova',
      parent_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(parsed).not.toHaveProperty('parent_id')
  })
})

describe('whenRowHasSystemFlag_thenIsSystemDetectsItDefensively', () => {
  it('retorna false para linhas sem a coluna (schema atual, sem is_system)', () => {
    expect(isSystem({ id: 'c1' } as never)).toBe(false)
    expect(isSystem({ is_system: null } as never)).toBe(false)
    expect(isSystem({ is_system: false } as never)).toBe(false)
  })

  it('retorna true apenas quando a coluna existir e for true (migration futura)', () => {
    expect(isSystem({ is_system: true } as never)).toBe(true)
  })
})

describe('whenUsageCountsAreBuilt_thenSinglePassMapWithoutNPlusOne', () => {
  it('conta category_id não-nulos em uma única passada', () => {
    const counts = buildUsageCounts([
      { category_id: 'a' },
      { category_id: 'b' },
      { category_id: 'a' },
      { category_id: null },
      {},
    ])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
    expect(counts.has('c')).toBe(false)
    expect(counts.size).toBe(2)
  })

  it('lista vazia gera mapa vazio', () => {
    expect(buildUsageCounts([]).size).toBe(0)
  })
})
