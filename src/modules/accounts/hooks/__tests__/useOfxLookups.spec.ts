// @vitest-environment happy-dom
// O3 amarelo (a) — useOfxLookups: categories + rules reais do usuário,
// fallback vazio honesto em erro/fechado.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const sbMocks = vi.hoisted(() => ({ from: vi.fn() }))

vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from },
}))

import { useOfxLookups } from '../useOfxLookups'

beforeEach(() => {
  sbMocks.from.mockReset()
})

function queryMock(result: { data: unknown; error: unknown }) {
  const chain = { select: vi.fn(), order: vi.fn(), eq: vi.fn() }
  chain.select.mockReturnValue(chain)
  chain.order.mockResolvedValue(result)
  chain.eq.mockReturnValue(chain)
  return chain
}

describe('whenLookupsLoad_thenCategoriesAndRules', () => {
  it('busca categories (id,name) e rules (keyword,target,priority) com RLS do client', async () => {
    const catQuery = queryMock({
      data: [{ id: 'c1', name: 'Alimentação' }],
      error: null,
    })
    const ruleQuery = queryMock({
      data: [{ keyword: 'ifood', target_category_id: 'c1', priority: 0 }],
      error: null,
    })
    sbMocks.from.mockImplementation((table: string) => {
      if (table === 'categories') return catQuery
      if (table === 'rules') return ruleQuery
      throw new Error(table)
    })
    const { result } = renderHook(() => useOfxLookups(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.categories).toEqual([{ id: 'c1', name: 'Alimentação' }])
    expect(result.current.rules).toEqual([
      { keyword: 'ifood', category_id: 'c1', priority: 0 },
    ])
  })

  it('modal fechado não consulta nada', () => {
    renderHook(() => useOfxLookups(false))
    expect(sbMocks.from).not.toHaveBeenCalled()
  })

  it('erro honesto: fallback vazio sem quebrar', async () => {
    sbMocks.from.mockImplementation(() => queryMock({ data: null, error: { message: 'x' } }))
    const { result } = renderHook(() => useOfxLookups(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.categories).toEqual([])
    expect(result.current.rules).toEqual([])
  })
})
