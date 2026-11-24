import { z } from 'zod'

// C1.1 — categorias: model puro. Sem valores monetários aqui (só cadastro).
// - name: trim 1..120; type: income|expense; color: trim max 32 nullish
//   (mapeada para color_hex no banco).
// - parent_id: fora de escopo (SPEC §4, modelo plano congelado). O objeto zod
//   usa strip padrão: parent_id tolerado na entrada é descartado e nunca
//   chega ao service. Follow-up: reavaliar subcategorias quando houver demanda.
// - is_system: a coluna NÃO existe no schema atual (verificado em
//   0026_default_categories: só icon_code/color_hex/spending_limit_cents).
//   isSystem() é defensivo: lê a flag se um dia ela existir (migration
//   futura) — hoje sempre false, sem inventar coluna no banco.

export const CATEGORY_TYPES = ['income', 'expense'] as const
export type CategoryType = (typeof CATEGORY_TYPES)[number]

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(CATEGORY_TYPES),
  color: z.string().trim().max(32).nullish().transform((v) => v ?? null),
})

export type CategoryInput = z.input<typeof categorySchema>

export const categoryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.enum(CATEGORY_TYPES).optional(),
  color: z.string().trim().max(32).nullish().optional(),
})

export type CategoryPatchInput = z.infer<typeof categoryUpdateSchema>

type MaybeSystem = { is_system?: unknown } | Record<string, unknown> | object

/** Flag de seed: defensiva — coluna ainda não existe no banco. */
export function isSystem(row: MaybeSystem): boolean {
  return (row as { is_system?: unknown }).is_system === true
}

/** Contagem de uso por categoria em passada única (sem N+1). */
export function buildUsageCounts(
  rows: Array<{ category_id?: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = row.category_id
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}
