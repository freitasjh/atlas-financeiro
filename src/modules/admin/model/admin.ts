import { formatCentsBRL } from '@/lib/utils'
import {
  PLANS as CATALOG_PLANS,
  isPlanSlug,
  resolvePlanSlug,
  type PlanSlug,
} from '@/modules/landing/model/catalog'

// FE-50 — admin consome o catálogo único (ADR-001). Planos são mock
// local (SPEC ADR-004); métricas derivadas de profiles, sem faturamento.
// MRR rotulado como base local (admin.localBasis).

export type PlanId = PlanSlug

export interface Plan {
  id: PlanId
  priceCents: number
}

export const PLANS: Plan[] = CATALOG_PLANS.map((p) => ({ id: p.slug, priceCents: p.monthlyCents }))

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'canceled'

export interface Tenant {
  id: string
  full_name: string | null
  plan_id: PlanId
  subscription_status: SubscriptionStatus
}

export interface TelemetryEvent {
  id: string
  kind: string
  label: string
  at: string
}

export interface AdminMetrics {
  mrrCents: number
  arrCents: number
  totalTenants: number
  activeCount: number
  trialCount: number
  churnRate: number
  conversionRate: number
}

export function planPriceCents(planId: PlanId): number {
  return PLANS.find((p) => p.id === planId)?.priceCents ?? 0
}

export function isValidPlanId(value: unknown): value is PlanId {
  return isPlanSlug(value)
}

// FE-50 — derivação explícita de plan_id (catálogo único).
// Fase 1: `profiles` não tem coluna de plano; todo tenant deriva para
// 'free' como base local demonstrativa, sem cobrança. Quando a coluna
// real existir, esta função passa a mapear o valor persistido e o
// fallback abaixo deixa de ser o caminho dominante. Retorno sempre PlanId válido.
export function resolvePlanId(raw: unknown): PlanId {
  return resolvePlanSlug(raw)
}

export function isValidSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return value === 'trial' || value === 'active' || value === 'past_due' || value === 'canceled'
}

// MRR = soma dos planos de tenants com receita ATIVA (`active` apenas).
// Trial é contagem própria (`trialCount`) — não é receita recorrente.
// ARR = MRR * 12. Churn = canceled / total. Conversão = active / total.
export function computeAdminMetrics(input: { tenants: Tenant[] }): AdminMetrics {
  const { tenants } = input
  const total = tenants.length
  let mrrCents = 0
  let activeCount = 0
  let trialCount = 0
  let canceledCount = 0
  for (const t of tenants) {
    if (!Number.isInteger(planPriceCents(t.plan_id))) throw new Error('priceCents deve ser inteiro')
    if (t.subscription_status === 'active') mrrCents += planPriceCents(t.plan_id)
    if (t.subscription_status === 'active') activeCount += 1
    if (t.subscription_status === 'trial') trialCount += 1
    if (t.subscription_status === 'canceled') canceledCount += 1
  }
  if (!Number.isInteger(mrrCents) || mrrCents < 0) throw new Error('mrrCents deve ser inteiro >= 0')
  return {
    mrrCents,
    arrCents: mrrCents * 12,
    totalTenants: total,
    activeCount,
    trialCount,
    churnRate: total === 0 ? 0 : canceledCount / total,
    conversionRate: total === 0 ? 0 : activeCount / total,
  }
}

export function formatBRL(cents: number): string {
  return formatCentsBRL(cents)
}

export function nextStatus(current: SubscriptionStatus): SubscriptionStatus {
  return current === 'active' ? 'past_due' : 'active'
}
