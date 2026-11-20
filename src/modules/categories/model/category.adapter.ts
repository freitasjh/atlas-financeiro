import type { Database } from '@/types/supabase'
import { isSystem } from './category'
import type { CategoryType } from './category'

export type CategoryRow = Database['public']['Tables']['categories']['Row']

/** Contrato de UI: só o que a tela consome (modelo plano, sem parent_id). */
export interface CategoryView {
  id: string
  name: string
  type: CategoryType
  color: string | null
  isSystem: boolean
  usageCount: number
}

export function toCategoryView(row: CategoryRow): CategoryView {
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'income' ? 'income' : 'expense',
    color: row.color_hex ?? null,
    isSystem: isSystem(row),
    usageCount: 0,
  }
}

/** Anexa contagens do Map (default 0), sem queries extras. */
export function withUsageCounts(
  views: CategoryView[],
  counts: Map<string, number>,
): CategoryView[] {
  return views.map((view) => ({ ...view, usageCount: counts.get(view.id) ?? 0 }))
}
