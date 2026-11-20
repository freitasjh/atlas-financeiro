// O3 amarelo (a) — lookups reais do OFX: categories + rules do usuário.
// RLS via client; erro → fallback vazio honesto (sem categorias fantasmas).
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { StagingCategory } from '../components/ImportStagingTable'
import type { RuleLike } from '@/lib/rules/applyRules'

export interface OfxLookups {
  categories: StagingCategory[]
  rules: RuleLike[]
  loaded: boolean
}

export function useOfxLookups(open: boolean): OfxLookups {
  const [categories, setCategories] = useState<StagingCategory[]>([])
  const [rules, setRules] = useState<RuleLike[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoaded(false)
    async function load(): Promise<void> {
      try {
        const [cats, rls] = await Promise.all([
          supabase.from('categories').select('id,name').order('name'),
          supabase.from('rules').select('keyword,target_category_id,priority').order('priority'),
        ])
        if (cancelled) return
        const catRows = (cats.error ? [] : (cats.data ?? [])) as Array<{ id: string; name: string }>
        const ruleRows = (rls.error ? [] : (rls.data ?? [])) as Array<{
          keyword: string
          target_category_id: string
          priority: number
        }>
        setCategories(catRows.map((c) => ({ id: c.id, name: c.name })))
        setRules(
          ruleRows.map((r) => ({ keyword: r.keyword, category_id: r.target_category_id, priority: r.priority })),
        )
      } catch {
        if (!cancelled) {
          setCategories([])
          setRules([])
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open ])

  return { categories, rules, loaded }
}
