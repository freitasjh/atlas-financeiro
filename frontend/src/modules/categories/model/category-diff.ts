import type { CategoryPatchInput, CategoryType } from './category'

// C2.3 (nit review Batch 1) — update vazio: compara o formulário com a linha
// atual e retorna null quando nada mudou, para a Screen fazer early-return
// sem chamar o servidor (evita PUT vazio + reload silencioso à toa).

export interface CategoryCurrent {
  name: string
  type: CategoryType
  color: string | null
}

export interface CategoryFormValues {
  name: string
  type: CategoryType
  color: string | null
}

function normalizeColor(color: string | null | undefined): string | null {
  if (color == null) return null
  const trimmed = color.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** Diff do formulário contra a linha atual; null = sem mudança. */
export function diffCategoryPatch(
  current: CategoryCurrent,
  values: CategoryFormValues,
): CategoryPatchInput | null {
  const patch: CategoryPatchInput = {}
  if (values.name.trim() !== current.name) patch.name = values.name.trim()
  if (values.type !== current.type) patch.type = values.type
  const nextColor = normalizeColor(values.color)
  if (nextColor !== current.color) patch.color = nextColor
  return Object.keys(patch).length === 0 ? null : patch
}
