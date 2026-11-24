import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CategoriesView } from '../components/CategoriesView'
import { toCategoryView, withUsageCounts } from '../model/category.adapter'
import type { CategoryFormValues } from '../model/category-diff'
import type { CategoryPatchInput } from '../model/category'
import { useCategoriesStore } from '../store/categories.store'
import {
  CategoryInUseError,
  CategorySystemProtectedError,
  countCategoriesUsage,
  countCategoryUsage,
} from '../service/categories.service'

// C2.1 — CategoriesScreen: dono dos dados (store + adapter + contagens de uso
// sem N+1) e dos toasts. A View recebe tudo por props (hook-first).

export function CategoriesScreen() {
  const { t } = useTranslation()
  const rows = useCategoriesStore((state) => state.categories)
  const status = useCategoriesStore((state) => state.status)
  const load = useCategoriesStore((state) => state.load)
  const create = useCategoriesStore((state) => state.create)
  const update = useCategoriesStore((state) => state.update)
  const remove = useCategoriesStore((state) => state.remove)

  const [usage, setUsage] = useState<Map<string, number>>(new Map())

  const refreshUsage = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setUsage(new Map())
      return
    }
    try {
      setUsage(await countCategoriesUsage(ids))
    } catch {
      // Contagem é enriquecimento: falha não quebra a tela (default 0).
      setUsage(new Map())
    }
  }, [])

  const reload = useCallback(async () => {
    await load()
  }, [load])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    void refreshUsage(rows.map((row) => row.id))
  }, [rows, refreshUsage])

  const categories = useMemo(
    () => withUsageCounts(rows.map(toCategoryView), usage),
    [rows, usage],
  )

  const handleCreate = useCallback(
    async (values: CategoryFormValues) => {
      try {
        await create({ name: values.name, type: values.type, color: values.color })
        toast.success(t('categories.toastCreated'))
      } catch (e) {
        if (e instanceof CategorySystemProtectedError) throw new Error(t('categories.systemProtectedError'))
        throw new Error(t('categories.saveError'))
      }
    },
    [create, t],
  )

  const handleUpdate = useCallback(
    async (id: string, patch: CategoryPatchInput) => {
      // Defesa em profundidade: patch vazio nunca chega ao servidor.
      if (Object.keys(patch).length === 0) return
      try {
        await update(id, patch)
        toast.success(t('categories.toastUpdated'))
      } catch (e) {
        if (e instanceof CategorySystemProtectedError) throw new Error(t('categories.systemProtectedError'))
        throw new Error(t('categories.saveError'))
      }
    },
    [update, t],
  )

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await remove(id)
        toast.success(t('categories.toastRemoved'))
      } catch (e) {
        // Preserva o código legível por máquina: a View detecta 'category-in-use'
        // para abrir o BlockedDialog honesto (corrida) e traduz o toast lá.
        if (e instanceof CategoryInUseError) throw new Error('category-in-use')
        if (e instanceof CategorySystemProtectedError) throw new Error('category-system-protected')
        const message = e instanceof Error ? e.message : ''
        if (message.includes('category-in-use')) throw new Error('category-in-use')
        if (message.includes('category-system-protected')) throw new Error('category-system-protected')
        throw new Error(t('categories.removeError'))
      }
    },
    [remove, t],
  )

  const handleRevalidateUsage = useCallback(async (id: string): Promise<number> => {
    const view = categories.find((category) => category.id === id)
    if (view?.isSystem) return view.usageCount
    return countCategoryUsage(id)
  }, [categories])

  return (
    <CategoriesView
      categories={categories}
      status={status}
      // Erro cru do Supabase nunca renderiza: apresentação sempre via chave i18n.
      error={status === 'error' ? t('categories.loadError') : null}
      onRetry={() => {
        void reload()
      }}
      onCreate={handleCreate}
      onUpdate={handleUpdate}
      onRemove={handleRemove}
      onRevalidateUsage={handleRevalidateUsage}
    />
  )
}
