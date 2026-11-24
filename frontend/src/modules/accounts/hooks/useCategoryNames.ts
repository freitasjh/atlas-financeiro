// Lookup único de categorias do usuário (id → nome) para o extrato.
// 1 query via RLS; erro → mapa vazio honesto (adapter mantém fallback).
// Sem N+1: o mapa é construído uma vez em memória.
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export function useCategoryNames(): { categoryNames: Map<string, string>; loaded: boolean } {
  const [categoryNames, setCategoryNames] = useState<Map<string, string>>(new Map())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const { data, error } = await supabase.from('categories').select('id,name').order('name')
        if (cancelled) return
        if (error || !data) {
          setCategoryNames(new Map())
          return
        }
        const map = new Map<string, string>()
        for (const row of data as Array<{ id: string; name: string }>) {
          if (row.id && row.name) map.set(row.id, row.name)
        }
        setCategoryNames(map)
      } catch {
        if (!cancelled) setCategoryNames(new Map())
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return { categoryNames, loaded }
}
