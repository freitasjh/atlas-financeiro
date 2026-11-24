import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BudgetsView } from '../components/BudgetsView'
import { toBudgetView, withSpending } from '../model/budget.adapter'
import { mapBudgetError } from '../model/budget-errors'
import { toMonthFirstDay } from '../model/budget'
import type { BudgetInput, BudgetPatchInput } from '../model/budget'
import { useBudgetsStore } from '../store/budgets.store'
import { useCategoriesStore } from '@/modules/categories/store/categories.store'

// O2.1/O2.4 — BudgetsScreen: dono dos dados (store + adapter + nomes de
// categoria) e dos toasts. Erro cru nunca renderiza: só chave i18n.

interface BudgetsScreenProps {
  /** Mês inicial (YYYY-MM-01); default = mês corrente. */
  initialMonth?: string
}

export function BudgetsScreen({ initialMonth }: BudgetsScreenProps) {
  const { t } = useTranslation()
  const [month, setMonth] = useState(initialMonth ?? toMonthFirstDay(new Date()))

  const rows = useBudgetsStore((state) => state.budgets)
  const spending = useBudgetsStore((state) => state.spending)
  const status = useBudgetsStore((state) => state.status)
  const load = useBudgetsStore((state) => state.load)
  const create = useBudgetsStore((state) => state.create)
  const update = useBudgetsStore((state) => state.update)
  const remove = useBudgetsStore((state) => state.remove)

  const categoryRows = useCategoriesStore((state) => state.categories)
  const loadCategories = useCategoriesStore((state) => state.load)

  useEffect(() => {
    void load(month)
  }, [load, month])

  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  const categoryNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const category of categoryRows) names.set(category.id, category.name)
    return names
  }, [categoryRows])

  const categories = useMemo(
    () =>
      [...categoryRows]
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .map((category) => ({ id: category.id, name: category.name })),
    [categoryRows],
  )

  const budgets = useMemo(() => {
    const base = rows.map(toBudgetView)
    const txs = [...spending.entries()].map(([category_id, amount_cents]) => ({
      category_id,
      amount_cents,
    }))
    return withSpending(base, txs).map((view) => ({
      ...view,
      categoryName: categoryNames.get(view.categoryId) ?? view.categoryId,
    }))
  }, [rows, spending, categoryNames])

  const warnIfOver = useCallback(
    (categoryId: string, limitCents: number, rowMonth: string) => {
      if (rowMonth !== month) return
      const spent = spending.get(categoryId) ?? 0
      if (spent > limitCents) toast.warning(t('budgets.overToast'))
    },
    [month, spending, t],
  )

  const handleCreate = useCallback(
    async (values: BudgetInput) => {
      try {
        const row = await create(values)
        toast.success(t('budgets.toastCreated'))
        warnIfOver(row.category_id, row.limit_cents, row.month)
      } catch (e) {
        throw new Error(mapBudgetError(e, t))
      }
    },
    [create, t, warnIfOver],
  )

  const handleUpdate = useCallback(
    async (id: string, patch: BudgetPatchInput) => {
      // Defesa em profundidade: patch vazio nunca chega ao servidor.
      if (Object.keys(patch).length === 0) return
      try {
        const row = await update(id, patch)
        toast.success(t('budgets.toastUpdated'))
        warnIfOver(row.category_id, row.limit_cents, row.month)
      } catch (e) {
        throw new Error(mapBudgetError(e, t))
      }
    },
    [update, t, warnIfOver],
  )

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await remove(id)
        toast.success(t('budgets.toastRemoved'))
      } catch (e) {
        throw new Error(mapBudgetError(e, t))
      }
    },
    [remove, t],
  )

  return (
    <BudgetsView
      budgets={budgets}
      status={status}
      // Erro cru do Supabase nunca renderiza: apresentação sempre via chave i18n.
      error={status === 'error' ? t('budgets.loadError') : null}
      month={month}
      onMonthChange={setMonth}
      categories={categories}
      onRetry={() => {
        void load(month)
      }}
      onCreate={handleCreate}
      onUpdate={handleUpdate}
      onRemove={handleRemove}
    />
  )
}
