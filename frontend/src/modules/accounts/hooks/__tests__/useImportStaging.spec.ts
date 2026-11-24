// @vitest-environment happy-dom
// O2.1/O2.2/O2.4 — useImportStaging: bulk select, contagens, categoria inline
// sem sobrescrever manual, duplicado nunca selecionável.
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useImportStaging, type StagedInput } from '../useImportStaging'

function input(overrides: Partial<StagedInput> = {}): StagedInput {
  return {
    id: 'r1',
    date: '2026-11-01',
    description: 'PIX RECEBIDO',
    amount_cents: 15000,
    type: 'income',
    fitid: 'fit-1',
    dedup_hash: 'hash-1',
    ...overrides,
  }
}

describe('whenStagingLoads_thenDuplicatesAreMarkedAndUnselected', () => {
  it('marca dup por hash existente e por repetição no lote', () => {
    const { result } = renderHook(() => useImportStaging())
    act(() => {
      result.current.load(
        [input(), input({ id: 'r2', dedup_hash: 'hash-2' }), input({ id: 'r3', dedup_hash: 'hash-2' })],
        { existingHashes: new Set(['hash-1']), invalidCount: 1 },
      )
    })
    const rows = result.current.rows
    expect(rows.find((r) => r.id === 'r1')?.dup).toBe(true)
    expect(rows.find((r) => r.id === 'r2')?.dup).toBe(false)
    expect(rows.find((r) => r.id === 'r3')?.dup).toBe(true)
    expect(rows.find((r) => r.id === 'r1')?.selected).toBe(false)
    expect(result.current.counts).toEqual({ new: 1, dup: 2, invalid: 1 })
  })
})

describe('whenBulkToggles_thenOnlyNewRowsChange', () => {
  it('select-all seleciona só novos; toggle em dup é ignorado', () => {
    const { result } = renderHook(() => useImportStaging())
    act(() => {
      result.current.load([input(), input({ id: 'r2', dedup_hash: 'h2' })], {
        existingHashes: new Set(['hash-1']),
      })
    })
    act(() => {
      result.current.toggleAll(true)
    })
    expect(result.current.rows.find((r) => r.id === 'r1')?.selected).toBe(false)
    expect(result.current.rows.find((r) => r.id === 'r2')?.selected).toBe(true)
    expect(result.current.confirmCount).toBe(1)

    act(() => {
      result.current.toggleRow('r1')
    })
    expect(result.current.rows.find((r) => r.id === 'r1')?.selected).toBe(false)
    expect(result.current.confirmCount).toBe(1)

    act(() => {
      result.current.toggleRow('r2')
    })
    expect(result.current.confirmCount).toBe(0)
  })
})

describe('whenCategoryIsEdited_thenManualValueSticks', () => {
  it('setCategory preenche e applyRules posterior não sobrescreve', () => {
    const { result } = renderHook(() => useImportStaging())
    act(() => {
      result.current.load([input({ id: 'r1', dedup_hash: 'h1' })], { existingHashes: new Set() })
    })
    act(() => {
      result.current.setCategory('r1', 'cat-manual')
    })
    expect(result.current.rows[0].category_id).toBe('cat-manual')
    act(() => {
      result.current.applyRules([{ keyword: 'pix', category_id: 'cat-auto', priority: 0 }])
    })
    expect(result.current.rows[0].category_id).toBe('cat-manual')
  })

  it('applyRules preenche linha vazia mas nunca a manual', () => {
    const { result } = renderHook(() => useImportStaging())
    act(() => {
      result.current.load(
        [input({ id: 'r1', dedup_hash: 'h1' }), input({ id: 'r2', dedup_hash: 'h2', description: 'Boleto luz' })],
        { existingHashes: new Set() },
      )
    })
    act(() => {
      result.current.setCategory('r1', 'cat-manual')
    })
    act(() => {
      result.current.applyRules([{ keyword: 'pix', category_id: 'cat-auto', priority: 0 }])
    })
    expect(result.current.rows.find((r) => r.id === 'r1')?.category_id).toBe('cat-manual')
    expect(result.current.rows.find((r) => r.id === 'r2')?.category_id).toBeNull()
  })
})
