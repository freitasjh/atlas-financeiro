// FE-50 — catálogo único de planos (ADR-001): landing + admin consomem.
// 4 slugs exatos: free 0, standard 1990, pro 3990 (featured), full 6990.
// Dinheiro só BIGINT cents (int >= 0). Anual sem float: desconto de 20%
// sobre 12 mensalidades calculado só com inteiros (96/10).

export type PlanSlug = 'free' | 'standard' | 'pro' | 'full'

export type BillingMode = 'monthly' | 'annual'

export interface Plan {
  slug: PlanSlug
  monthlyCents: number
  featured: boolean
}

export const FEATURED_SLUG: PlanSlug = 'pro'

export const PLAN_SLUGS: readonly PlanSlug[] = ['free', 'standard', 'pro', 'full'] as const

export const PLANS: readonly Plan[] = [
  { slug: 'free', monthlyCents: 0, featured: false },
  { slug: 'standard', monthlyCents: 1990, featured: false },
  { slug: 'pro', monthlyCents: 3990, featured: true },
  { slug: 'full', monthlyCents: 6990, featured: false },
] as const

function assertCents(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error('monthlyCents deve ser inteiro >= 0')
}

// Anual à vista: 12 mensalidades com 20% de desconto, só com inteiros.
export function annualCentsFor(monthlyCents: number): number {
  assertCents(monthlyCents)
  const annual = Math.round((monthlyCents * 96) / 10)
  if (!Number.isInteger(annual) || annual < 0) throw new Error('annualCents deve ser inteiro >= 0')
  return annual
}

// Equivalente mensal exibido no modo anual (annual/12, inteiro p/ catálogo).
export function annualMonthlyEquivalentCents(monthlyCents: number): number {
  const annual = annualCentsFor(monthlyCents)
  const perMonth = annual / 12
  if (!Number.isInteger(perMonth)) throw new Error('equivalente mensal deve ser inteiro')
  return perMonth
}

export function isPlanSlug(value: unknown): value is PlanSlug {
  return value === 'free' || value === 'standard' || value === 'pro' || value === 'full'
}

// Allowlist: slug forjado/ausente resolve free silencioso (sem erro).
export function resolvePlanSlug(value: unknown): PlanSlug {
  return isPlanSlug(value) ? value : 'free'
}

export function planBySlug(slug: PlanSlug): Plan {
  const found = PLANS.find((p) => p.slug === slug)
  if (!found) throw new Error(`slug desconhecido: ${slug}`)
  return found
}

export function planCtaHref(slug: PlanSlug): string {
  return `/solicitar-convite?plano=${slug}`
}
