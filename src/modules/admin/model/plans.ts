// FE-41 — plans.ts mock (SPEC ADR-004): 4 planos (catálogo único) locais em BIGINT cents.
// Sem checkout, sem webhooks, sem tabela — base local rotulada na UI.
// Re-exporta o model canônico para o caminho citado no PLAN.
export { PLANS, planPriceCents } from './admin'
export type { Plan, PlanId } from './admin'
