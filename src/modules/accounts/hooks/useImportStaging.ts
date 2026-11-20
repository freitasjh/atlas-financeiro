// O2.1 — staging de importação OFX (pré-insert, sem persistência).
// Duplicado (hash existente ou repetido no lote) nunca é selecionável.
import { useCallback, useMemo, useState } from 'react'
import { applyRules as applyRulesPure, type RuleLike } from '@/lib/rules/applyRules'

export type StagedType = 'income' | 'expense'

export interface StagedInput {
  id: string
  date: string
  description: string
  amount_cents: number
  type: StagedType
  fitid: string | null
  dedup_hash: string
}

export interface StagedRow extends StagedInput {
  category_id: string | null
  selected: boolean
  dup: boolean
}

export interface StagingCounts {
  new: number
  dup: number
  invalid: number
}

export interface LoadOptions {
  existingHashes?: Set<string>
  invalidCount?: number
}

export function useImportStaging() {
  const [rows, setRows] = useState<StagedRow[]>([])
  const [invalidCount, setInvalidCount] = useState(0)

  const load = useCallback((items: StagedInput[], options: LoadOptions = {}) => {
    const existing = options.existingHashes ?? new Set<string>()
    const seen = new Set<string>()
    setRows(
      items.map((item) => {
        const dup = existing.has(item.dedup_hash) || seen.has(item.dedup_hash)
        seen.add(item.dedup_hash)
        return { ...item, category_id: null, selected: false, dup }
      }),
    )
    setInvalidCount(options.invalidCount ?? 0)
  }, [])

  const reset = useCallback(() => {
    setRows([])
    setInvalidCount(0)
  }, [])

  const toggleRow = useCallback((id: string) => {
    setRows((prev) => prev.map((row) => (row.id === id && !row.dup ? { ...row, selected: !row.selected } : row)))
  }, [])

  const toggleAll = useCallback((checked: boolean) => {
    setRows((prev) => prev.map((row) => (row.dup ? row : { ...row, selected: checked })))
  }, [])

  const setCategory = useCallback((id: string, categoryId: string | null) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, category_id: categoryId } : row)))
  }, [])

  const applyRules = useCallback((rules: RuleLike[]) => {
    setRows((prev) => applyRulesPure(prev, rules))
  }, [])

  const counts: StagingCounts = useMemo(() => {
    let dup = 0
    for (const row of rows) if (row.dup) dup += 1
    return { new: rows.length - dup, dup, invalid: invalidCount }
  }, [rows, invalidCount])

  const confirmCount = useMemo(() => rows.filter((row) => row.selected && !row.dup).length, [rows])

  const allNewSelected = useMemo(() => {
    const fresh = rows.filter((row) => !row.dup)
    return fresh.length > 0 && fresh.every((row) => row.selected)
  }, [rows])

  return { rows, counts, confirmCount, allNewSelected, load, reset, toggleRow, toggleAll, setCategory, applyRules }
}
