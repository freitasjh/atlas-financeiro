/**
 * Âncoras do control plane (REQ-05): exatamente 4, sem seletor de tenant.
 *
 * O operador não tem tenant (REQ-47) — não existe `<select>` de contexto aqui.
 */

import { Activity, Building2, LayoutDashboard, ScrollText, type LucideIcon } from "lucide-react"

export interface InternalNavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  /** Só a raiz usa `end`: `/internal` não fica ativa em `/internal/tenants`. */
  end: boolean
}

export const INTERNAL_NAV_ITEMS: readonly InternalNavItem[] = [
  { to: "/internal", labelKey: "internalAdmin.nav.home", icon: LayoutDashboard, end: true },
  { to: "/internal/tenants", labelKey: "internalAdmin.nav.tenants", icon: Building2, end: false },
  { to: "/internal/auditoria", labelKey: "internalAdmin.nav.audit", icon: ScrollText, end: false },
  { to: "/internal/telemetria", labelKey: "internalAdmin.nav.telemetry", icon: Activity, end: false },
]

/** Item ativo derivado da rota — pura, para prova unitária. */
export function isInternalNavActive(pathname: string, item: InternalNavItem): boolean {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

/**
 * Chave i18n do título da rota corrente (breadcrumb + `document.title`).
 * `/internal/foo` (404) não casa nenhuma âncora: cai no rótulo de não encontrado.
 */
export function internalNavTitleKey(pathname: string): string {
  const item = INTERNAL_NAV_ITEMS.find((candidate) => isInternalNavActive(pathname, candidate))
  return item?.labelKey ?? "internalAdmin.notFoundTitle"
}
