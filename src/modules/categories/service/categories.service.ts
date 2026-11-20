import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/supabase'
import {
  buildUsageCounts,
  categorySchema,
  categoryUpdateSchema,
  isSystem,
  type CategoryInput,
  type CategoryPatchInput,
} from '../model/category'

export type CategoryRow = Database['public']['Tables']['categories']['Row']

export class CategoryInUseError extends Error {
  readonly usageCount: number
  constructor(usageCount: number) {
    super('category-in-use')
    this.name = 'CategoryInUseError'
    this.usageCount = usageCount
  }
}

export class CategorySystemProtectedError extends Error {
  constructor() {
    super('category-system-protected')
    this.name = 'CategorySystemProtectedError'
  }
}

async function requireUserId(): Promise<string> {
  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')
  return userId
}

async function fetchOwned(id: string, userId: string): Promise<CategoryRow> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('category-not-found')
  return data as CategoryRow
}

function assertEditable(row: CategoryRow): void {
  if (isSystem(row)) throw new CategorySystemProtectedError()
}

/** Lista categorias do tenant ordenadas por nome (RLS: auth.uid() = user_id). */
export async function listCategories(): Promise<CategoryRow[]> {
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as CategoryRow[]
}

export async function createCategory(input: CategoryInput): Promise<CategoryRow> {
  const userId = await requireUserId()
  const parsed = categorySchema.parse(input)
  // Colunas permitidas: name/type/color_hex. parent_id nunca escrito
  // (modelo plano); is_system não existe no schema — sem literal.
  const { data, error } = await supabase
    .from('categories')
    .insert({
      user_id: userId,
      name: parsed.name,
      type: parsed.type,
      color_hex: parsed.color,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as CategoryRow
}

export async function updateCategory(id: string, patch: CategoryPatchInput): Promise<CategoryRow> {
  const userId = await requireUserId()
  const current = await fetchOwned(id, userId)
  assertEditable(current)
  const safe = categoryUpdateSchema.parse(patch)
  const payload: Record<string, unknown> = {}
  if (safe.name !== undefined) payload.name = safe.name
  if (safe.type !== undefined) payload.type = safe.type
  if (safe.color !== undefined) payload.color_hex = safe.color
  const { data, error } = await supabase
    .from('categories')
    .update(payload)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw error
  return data as CategoryRow
}

/**
 * Exclusão com bloqueio no servidor: revalida o uso no momento de excluir
 * (contagem head) e recusa com `category-in-use`. NUNCA cascade silencioso —
 * a FK é ON DELETE SET NULL e o service barra antes de chegar nela.
 */
export async function deleteCategory(id: string): Promise<void> {
  const userId = await requireUserId()
  const current = await fetchOwned(id, userId)
  assertEditable(current)
  const usage = await countCategoryUsage(id, userId)
  if (usage > 0) throw new CategoryInUseError(usage)
  const { error } = await supabase.from('categories').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
}

/** Contagem de lançamentos vinculados (head count, sem trazer linhas). */
export async function countCategoryUsage(categoryId: string, userId?: string): Promise<number> {
  const owner = userId ?? (await requireUserId())
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', owner)
    .eq('category_id', categoryId)
  if (error) throw error
  return count ?? 0
}

/**
 * Contagens de uso para várias categorias em UMA query (sem N+1).
 * Categorias sem uso ausentam-se do Map — o adapter aplica default 0.
 */
export async function countCategoriesUsage(categoryIds: string[]): Promise<Map<string, number>> {
  if (categoryIds.length === 0) return new Map()
  const userId = await requireUserId()
  const { data, error } = await supabase
    .from('transactions')
    .select('category_id')
    .eq('user_id', userId)
    .in('category_id', categoryIds)
  if (error) throw error
  return buildUsageCounts((data ?? []) as Array<{ category_id: string | null }>)
}
