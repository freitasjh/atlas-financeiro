/**
 * Formas de fio das RPCs do painel interno (SPEC §5.2, REQ-32/REQ-35).
 *
 * Tipos puros, sem I/O: cada campo aqui existe na resposta de uma RPC
 * allowlistada. Nada de campo "previsto" — se a RPC não entrega, a tela não
 * renderiza (REQ-32).
 */

/** `admin_list_tenants` — `0039:81-160`. */
export interface TenantListRow {
  id: string
  kind: string
  cpf: string | null
  cnpj: string | null
  razao_social: string
  nome_fantasia: string | null
  plan_id: string
  subscription_status: string
  created_at: string
  owner_user_id: string
}

/**
 * Linha de `admin_get_tenant` — `0042:26-62`.
 *
 * A RPC é `RETURNS TABLE`, então o PostgREST devolve **array**: o consumidor lê
 * `rows[0]`, nunca o objeto solto (re-H3 F4).
 */
export interface TenantDetailRow {
  id: string
  kind: string
  document: string | null
  razao_social: string
  nome_fantasia: string | null
  plan_id: string
  subscription_status: string
  created_at: string
}

/** `admin_list_members` — `0042:78-100`. */
export interface TenantMemberRow {
  user_id: string
  role: string
  created_at: string
}

/** `list_admin_audit_page` — `0037:132-181`. */
export interface AdminAuditRow {
  id: string
  actor_id: string | null
  target_id: string | null
  tenant_id: string | null
  action: string
  from_value: string | null
  to_value: string | null
  reason: string | null
  at: string
}

/** `get_tenant_usage` — `0064:65-90`. `limit_max: null` = ilimitado. */
export interface TenantUsageRow {
  resource: string
  used: number
  limit_max: number | null
}

/** `admin_list_pending_invites` — `0078:287-349`. Nunca traz e-mail. */
export interface PendingInviteRow {
  invited_user_id: string
  requested_at: string
  age_hours: number
  state: string
}

/** `admin_tenant_onboarding_state` — `0079:81-145`. */
export interface TenantOnboardingStateRow {
  tenant_id: string
  state: string
  missing: string[] | null
}

/** `admin_mrr_summary` — forma congelada de `0071:139-201`. */
export interface MrrSummary {
  competencia: string
  mrr_cents: number
  active_count: number
  past_due_count: number
  overdue_cents: number
  overdue_count: number
}

/** `admin_usage_series` — `0071:68-128`. */
export interface UsageSeriesRow {
  competencia: string
  tenant_id: string
  events: number
}

/** Assinatura embutida em `admin_get_tenant_billing`. */
export interface TenantBillingSubscription {
  plan_slug: string
  status: string
  trial_ends_at: string | null
  billing_day: number | null
  period_start: string | null
  period_end: string | null
  past_due_since: string | null
  pending_plan_slug: string | null
  pending_plan_at: string | null
  cancel_at_period_end: boolean | null
  created_at: string
  updated_at: string
}

/** Fatura embutida em `admin_get_tenant_billing` (cap 50 por chamada). */
export interface TenantBillingInvoice {
  id: string
  competencia: string
  period_start: string | null
  period_end: string | null
  due_date: string | null
  amount_cents: number
  status: string
  paid_at: string | null
  created_at: string
}

/** `admin_get_tenant_billing` — `usage` é sempre `null` (`0060:237`). */
export interface TenantBilling {
  subscription: TenantBillingSubscription | null
  invoices: { items: TenantBillingInvoice[]; total: number }
  usage: null
}

/** Resultado de `admin_override_subscription`. */
export interface SubscriptionOverrideResult {
  outcome?: string
  reason?: string
}
