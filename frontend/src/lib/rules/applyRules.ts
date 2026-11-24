// O2.3 — regras keyword→category_id client-side (RF-06).
// Puro: primeira regra por prioridade vence; nunca sobrescreve categoria manual.

export interface RuleLike {
  keyword: string
  category_id: string
  priority: number
}

export interface StagedLike {
  description: string
  category_id: string | null | undefined
}

/** Aplica regras em linhas de staging; só preenche quando category_id está vazia. */
export function applyRules<T extends StagedLike>(rows: T[], rules: RuleLike[]): T[] {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority)
  return rows.map((row) => {
    if (row.category_id !== null && row.category_id !== undefined && row.category_id !== '') {
      return row
    }
    const haystack = row.description.toLowerCase()
    const hit = ordered.find(
      (rule) => rule.keyword.trim() !== '' && haystack.includes(rule.keyword.trim().toLowerCase()),
    )
    if (!hit) return { ...row, category_id: null }
    return { ...row, category_id: hit.category_id }
  })
}
