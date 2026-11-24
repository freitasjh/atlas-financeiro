/**
 * `/internal/tenants/:tenantId` — detalhe em **rota** (não Sheet), com tabs
 * Visão geral/Uso/Faturamento/Membros/Trilha (UX §21, REQ-31/REQ-36).
 *
 * Cada bloco rastreia uma RPC da tabela §5.2 da SPEC. `billing.usage` nunca é
 * lido: consumo só por `get_tenant_usage` (UX "Avisos" 1).
 */

import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, RefreshCw } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Card, CardContent } from "@/components/shadcn/ui/card"
import { Input } from "@/components/shadcn/ui/input"
import { Label } from "@/components/shadcn/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/shadcn/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/shadcn/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/shadcn/ui/tabs"
import { writeInternalRpc } from "@/internal/data/internal-client"
import type {
  AdminAuditRow,
  SubscriptionOverrideResult,
  TenantBilling,
  TenantDetailRow,
  TenantMemberRow,
  TenantOnboardingStateRow,
  TenantUsageRow,
} from "@/internal/data/internal-types"
import { formatCount, formatCurrency, formatDate, formatDateTime, maskDocument, maskId } from "@/internal/ui/format"
import { InternalPageHeader } from "@/internal/ui/page-header"
import { InternalReasonDialog, REASON_MIN_LENGTH } from "@/internal/ui/reason-dialog"
import {
  InternalEmptyState,
  InternalErrorState,
  InternalLoadingState,
  InternalPageNav,
  INTERNAL_PAGE_SIZE,
} from "@/internal/ui/state-blocks"
import { InternalBanner, InternalStatusBadge } from "@/internal/ui/status-badge"
import { useInternalRead } from "@/internal/ui/use-internal-read"
import { useInternalT } from "../ui/use-internal-t"

const ONBOARDING_COMPLETE = "onboarding-complete"
const OVERRIDE_STATUSES = ["trial", "active", "past_due", "canceled"] as const

function DefinitionItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{children}</dd>
    </div>
  )
}

function UsageGauge({ used, limitMax }: { used: number; limitMax: number | null }) {
  const t = useInternalT()
  if (limitMax === null || limitMax <= 0) {
    return (
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {formatCount(used)} / {t("internalAdmin.detail.unlimited")}
      </span>
    )
  }
  const percent = Math.min(100, Math.round((used / limitMax) * 100))
  const tone =
    percent >= 85 ? "bg-rose-500" : percent >= 60 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t("internalAdmin.detail.usageGaugeLabel")}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {formatCount(used)} / {formatCount(limitMax)}
      </span>
    </div>
  )
}

function UsageTab({ tenantId }: { tenantId: string }) {
  const t = useInternalT()
  const usage = useInternalRead<TenantUsageRow[]>("get_tenant_usage", { p_tenant: tenantId })
  const rows = usage.data ?? []
  const exceeded = rows.some((row) => row.limit_max !== null && row.used > row.limit_max)

  return (
    <div className="flex flex-col gap-3">
      {exceeded ? (
        <InternalBanner tone="attention" title={t("internalAdmin.detail.quotaExceededTitle")}>
          {t("internalAdmin.detail.quotaExceededBody")}
        </InternalBanner>
      ) : null}
      {usage.failed ? <InternalErrorState onRetry={usage.reload} /> : null}
      {usage.loading ? <InternalLoadingState rows={5} /> : null}
      {!usage.loading && !usage.failed && rows.length === 0 ? <InternalEmptyState /> : null}
      {rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("internalAdmin.detail.resource")}</TableHead>
              <TableHead>{t("internalAdmin.detail.consumption")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.resource}>
                <TableCell className="font-mono text-xs tabular-nums text-foreground">
                  {row.resource}
                </TableCell>
                <TableCell>
                  <UsageGauge used={row.used} limitMax={row.limit_max} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  )
}

function BillingTab({ tenantId }: { tenantId: string }) {
  const t = useInternalT()
  const billing = useInternalRead<TenantBilling>("admin_get_tenant_billing", { p_tenant: tenantId })
  const data = billing.data

  return (
    <div className="flex flex-col gap-4">
      {billing.failed ? <InternalErrorState onRetry={billing.reload} /> : null}
      {billing.loading ? <InternalLoadingState rows={4} /> : null}

      {data !== null && data.subscription === null ? <InternalEmptyState /> : null}

      {data !== null && data.subscription !== null ? (
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DefinitionItem label={t("internalAdmin.detail.planSlug")}>
            <span className="font-mono tabular-nums">{data.subscription.plan_slug}</span>
          </DefinitionItem>
          <DefinitionItem label={t("internalAdmin.detail.status")}>
            <InternalStatusBadge status={data.subscription.status} />
          </DefinitionItem>
          <DefinitionItem label={t("internalAdmin.detail.period")}>
            <span className="font-mono tabular-nums">
              {formatDate(data.subscription.period_start)} — {formatDate(data.subscription.period_end)}
            </span>
          </DefinitionItem>
          <DefinitionItem label={t("internalAdmin.detail.billingDay")}>
            <span className="font-mono tabular-nums">
              {data.subscription.billing_day === null ? "—" : formatCount(data.subscription.billing_day)}
            </span>
          </DefinitionItem>
          <DefinitionItem label={t("internalAdmin.detail.pastDueSince")}>
            <span className="font-mono tabular-nums">{formatDate(data.subscription.past_due_since)}</span>
          </DefinitionItem>
          <DefinitionItem label={t("internalAdmin.detail.pendingPlan")}>
            <span className="font-mono tabular-nums">{data.subscription.pending_plan_slug ?? "—"}</span>
          </DefinitionItem>
        </dl>
      ) : null}

      {data !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t("internalAdmin.detail.invoices")}</h3>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {t("internalAdmin.detail.invoicesCap", { value: formatCount(data.invoices.total) })}
            </span>
          </div>
          {data.invoices.items.length === 0 ? (
            <InternalEmptyState
              title={t("internalAdmin.detail.invoicesEmptyTitle")}
              description={t("internalAdmin.detail.invoicesEmptyHint")}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("internalAdmin.detail.competencia")}</TableHead>
                    <TableHead>{t("internalAdmin.detail.dueDate")}</TableHead>
                    <TableHead className="text-right">{t("internalAdmin.detail.amount")}</TableHead>
                    <TableHead>{t("internalAdmin.detail.status")}</TableHead>
                    <TableHead>{t("internalAdmin.detail.paidAt")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.invoices.items.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDate(invoice.competencia)}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDate(invoice.due_date)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-foreground">
                        {formatCurrency(invoice.amount_cents)}
                      </TableCell>
                      <TableCell>
                        <InternalStatusBadge status={invoice.status} />
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDateTime(invoice.paid_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function MembersTab({ tenantId }: { tenantId: string }) {
  const t = useInternalT()
  const members = useInternalRead<TenantMemberRow[]>("admin_list_members", { p_tenant: tenantId })
  const rows = members.data ?? []

  return (
    <div className="flex flex-col gap-3">
      {members.failed ? <InternalErrorState onRetry={members.reload} /> : null}
      {members.loading ? <InternalLoadingState rows={3} /> : null}
      {!members.loading && !members.failed && rows.length === 0 ? <InternalEmptyState /> : null}
      {rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("internalAdmin.detail.memberId")}</TableHead>
              <TableHead>{t("internalAdmin.detail.memberRole")}</TableHead>
              <TableHead>{t("internalAdmin.detail.memberSince")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {maskId(member.user_id)}
                </TableCell>
                <TableCell className="text-xs text-foreground">{member.role}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatDateTime(member.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  )
}

function TrailTab({ tenantId }: { tenantId: string }) {
  const t = useInternalT()
  const [offset, setOffset] = useState(0)
  const trail = useInternalRead<AdminAuditRow[]>("list_admin_audit_page", {
    p_tenant: tenantId,
    p_limit: INTERNAL_PAGE_SIZE,
    p_offset: offset,
  })
  const rows = trail.data ?? []

  return (
    <div className="flex flex-col gap-3">
      {trail.failed ? <InternalErrorState onRetry={trail.reload} /> : null}
      {trail.loading ? <InternalLoadingState rows={4} /> : null}
      {!trail.loading && !trail.failed && rows.length === 0 ? <InternalEmptyState /> : null}
      {rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("internalAdmin.audit.columnAt")}</TableHead>
              <TableHead>{t("internalAdmin.audit.columnAction")}</TableHead>
              <TableHead>{t("internalAdmin.audit.columnReason")}</TableHead>
              <TableHead>{t("internalAdmin.audit.columnActor")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatDateTime(row.at)}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground">
                  {row.action}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.reason ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {maskId(row.actor_id)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <InternalPageNav
        limit={INTERNAL_PAGE_SIZE}
        offset={offset}
        count={rows.length}
        onChange={setOffset}
      />
    </div>
  )
}

export function InternalTenantDetailPage() {
  const t = useInternalT()
  const params = useParams<{ tenantId: string }>()
  const tenantId = params.tenantId ?? ""

  const tenant = useInternalRead<TenantDetailRow[]>("admin_get_tenant", { p_tenant: tenantId }, {
    enabled: tenantId.length > 0,
  })
  const onboarding = useInternalRead<TenantOnboardingStateRow[]>(
    "admin_tenant_onboarding_state",
    { p_tenant: tenantId },
    { enabled: tenantId.length > 0 },
  )

  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const [overridePlan, setOverridePlan] = useState("")
  const [overrideStatus, setOverrideStatus] = useState("")
  const [overridePending, setOverridePending] = useState(false)
  const [overrideError, setOverrideError] = useState<string | null>(null)

  const [repairOpen, setRepairOpen] = useState(false)
  const [repairPending, setRepairPending] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")
  const [cancelPending, setCancelPending] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const [feedback, setFeedback] = useState<string | null>(null)

  // `admin_get_tenant` é `RETURNS TABLE` (`0042:26`): array, não objeto.
  const detail = (tenant.data ?? [])[0] ?? null
  const onboardingRow = (onboarding.data ?? [])[0] ?? null
  const drift = onboardingRow !== null && onboardingRow.state !== ONBOARDING_COMPLETE
  const status = detail?.subscription_status ?? null

  const reloadAll = () => {
    tenant.reload()
    onboarding.reload()
  }

  const submitOverride = async (statusOverride: string | null) => {
    if (tenantId.length === 0) return
    setOverridePending(true)
    setOverrideError(null)
    try {
      const result = await writeInternalRpc<SubscriptionOverrideResult>("admin_override_subscription", {
        p_tenant: tenantId,
        p_plan: overridePlan.trim().length === 0 ? null : overridePlan.trim(),
        p_status: statusOverride,
        p_reason: overrideReason.trim(),
      })
      if (result?.outcome === "rejected") {
        setOverrideError(t("internalAdmin.actions.rejected"))
      } else {
        setFeedback(t("internalAdmin.actions.done"))
        setOverrideOpen(false)
        setOverrideReason("")
        setOverridePlan("")
        setOverrideStatus("")
        reloadAll()
      }
    } catch {
      setOverrideError(t("internalAdmin.actions.failed"))
    } finally {
      setOverridePending(false)
    }
  }

  const submitRepair = async () => {
    if (tenantId.length === 0) return
    setRepairPending(true)
    setRepairError(null)
    try {
      await writeInternalRpc<string>("admin_repair_tenant_onboarding", { p_tenant: tenantId })
      setFeedback(t("internalAdmin.actions.done"))
      setRepairOpen(false)
      reloadAll()
    } catch {
      setRepairError(t("internalAdmin.actions.failed"))
    } finally {
      setRepairPending(false)
    }
  }

  const submitCancel = async () => {
    if (tenantId.length === 0) return
    setCancelPending(true)
    setCancelError(null)
    try {
      const result = await writeInternalRpc<SubscriptionOverrideResult>("admin_override_subscription", {
        p_tenant: tenantId,
        p_plan: null,
        p_status: "canceled",
        p_reason: cancelReason.trim(),
      })
      if (result?.outcome === "rejected") {
        setCancelError(t("internalAdmin.actions.rejected"))
      } else {
        setFeedback(t("internalAdmin.actions.done"))
        setCancelOpen(false)
        setCancelReason("")
        reloadAll()
      }
    } catch {
      setCancelError(t("internalAdmin.actions.failed"))
    } finally {
      setCancelPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button asChild variant="ghost" className="min-h-11 px-2">
          <Link to="/internal/tenants">
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("internalAdmin.detail.back")}
          </Link>
        </Button>
      </div>

      <InternalPageHeader
        title={detail?.nome_fantasia ?? detail?.razao_social ?? t("internalAdmin.detail.title")}
        description={t("internalAdmin.detail.description")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={reloadAll}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("internalAdmin.tenants.refresh")}
            </Button>
            <Button type="button" className="min-h-11" onClick={() => setOverrideOpen(true)}>
              {t("internalAdmin.detail.overrideAction")}
            </Button>
          </>
        }
      />

      {feedback !== null ? (
        <p role="status" aria-live="polite" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
          {feedback}
        </p>
      ) : null}

      {status === "past_due" ? (
        <InternalBanner tone="attention" title={t("internalAdmin.detail.bannerPastDueTitle")}>
          {t("internalAdmin.detail.bannerPastDueBody")}
        </InternalBanner>
      ) : null}

      {status === "canceled" ? (
        <InternalBanner tone="negative" title={t("internalAdmin.detail.bannerCanceledTitle")}>
          {t("internalAdmin.detail.bannerCanceledBody")}
        </InternalBanner>
      ) : null}

      {drift && onboardingRow !== null ? (
        <InternalBanner tone="attention" title={t("internalAdmin.detail.bannerDriftTitle")}>
          <p>
            {t("internalAdmin.detail.bannerDriftBody", {
              missing: (onboardingRow.missing ?? []).join(", "),
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-2 min-h-11"
            onClick={() => setRepairOpen(true)}
          >
            {t("internalAdmin.detail.repairAction")}
          </Button>
        </InternalBanner>
      ) : null}

      {tenant.failed ? <InternalErrorState onRetry={reloadAll} /> : null}
      {tenant.loading ? <InternalLoadingState rows={4} /> : null}

      {detail !== null ? (
        <Tabs defaultValue="overview" className="gap-4">
          <TabsList
            variant="line"
            className="w-full justify-start overflow-x-auto max-md:group-data-[orientation=horizontal]/tabs:h-auto"
          >
            <TabsTrigger value="overview" className="max-md:min-h-11">
              {t("internalAdmin.detail.tabOverview")}
            </TabsTrigger>
            <TabsTrigger value="usage" className="max-md:min-h-11">
              {t("internalAdmin.detail.tabUsage")}
            </TabsTrigger>
            <TabsTrigger value="billing" className="max-md:min-h-11">
              {t("internalAdmin.detail.tabBilling")}
            </TabsTrigger>
            <TabsTrigger value="members" className="max-md:min-h-11">
              {t("internalAdmin.detail.tabMembers")}
            </TabsTrigger>
            <TabsTrigger value="trail" className="max-md:min-h-11">
              {t("internalAdmin.detail.tabTrail")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <Card className="border-border/70 shadow-xs">
              <CardContent className="flex flex-col gap-4 p-4">
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <DefinitionItem label={t("internalAdmin.detail.razaoSocial")}>
                    {detail.razao_social}
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.nomeFantasia")}>
                    {detail.nome_fantasia ?? "—"}
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.document")}>
                    <span className="font-mono tabular-nums">{maskDocument(detail.document)}</span>
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.kind")}>
                    {detail.kind}
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.planSlug")}>
                    <span className="font-mono tabular-nums">{detail.plan_id}</span>
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.status")}>
                    <InternalStatusBadge status={detail.subscription_status} />
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.createdAt")}>
                    <span className="font-mono tabular-nums">{formatDate(detail.created_at)}</span>
                  </DefinitionItem>
                  <DefinitionItem label={t("internalAdmin.detail.onboardingState")}>
                    <span className="font-mono text-xs tabular-nums">
                      {onboardingRow?.state ?? "—"}
                    </span>
                  </DefinitionItem>
                </dl>

                <div className="flex flex-col gap-2 border-t border-border/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    {t("internalAdmin.detail.cancelConsequence")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={status === "canceled"}
                    onClick={() => {
                      setCancelError(null)
                      setCancelOpen(true)
                    }}
                  >
                    {t("internalAdmin.detail.cancelAction")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="usage">
            <UsageTab tenantId={tenantId} />
          </TabsContent>

          <TabsContent value="billing">
            <BillingTab tenantId={tenantId} />
          </TabsContent>

          <TabsContent value="members">
            <MembersTab tenantId={tenantId} />
          </TabsContent>

          <TabsContent value="trail">
            <TrailTab tenantId={tenantId} />
          </TabsContent>
        </Tabs>
      ) : null}

      <InternalReasonDialog
        open={overrideOpen}
        onOpenChange={(open) => {
          setOverrideOpen(open)
          if (!open) setOverrideError(null)
        }}
        title={t("internalAdmin.detail.overrideTitle")}
        consequence={t("internalAdmin.detail.overrideConsequence")}
        confirmLabel={t("internalAdmin.detail.overrideConfirm")}
        requireReason
        reason={overrideReason}
        onReasonChange={setOverrideReason}
        pending={overridePending}
        error={overrideError}
        onConfirm={() => void submitOverride(overrideStatus.length === 0 ? null : overrideStatus)}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="internal-override-plan" className="text-xs font-medium">
              {t("internalAdmin.detail.overridePlan")}
            </Label>
            <Input
              id="internal-override-plan"
              value={overridePlan}
              onChange={(event) => setOverridePlan(event.target.value)}
              placeholder={t("internalAdmin.detail.overridePlanPlaceholder")}
              className="h-10 w-full font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="internal-override-status" className="text-xs font-medium">
              {t("internalAdmin.detail.overrideStatus")}
            </Label>
            <Select
              value={overrideStatus.length === 0 ? "keep" : overrideStatus}
              onValueChange={(value) => setOverrideStatus(value === "keep" ? "" : value)}
            >
              <SelectTrigger id="internal-override-status" className="h-10 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">{t("internalAdmin.detail.overrideKeep")}</SelectItem>
                {OVERRIDE_STATUSES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`internalAdmin.status.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {t("internalAdmin.actions.reasonMin", { value: REASON_MIN_LENGTH })}
        </p>
      </InternalReasonDialog>

      <InternalReasonDialog
        open={repairOpen}
        onOpenChange={(open) => {
          setRepairOpen(open)
          if (!open) setRepairError(null)
        }}
        title={t("internalAdmin.detail.repairTitle")}
        consequence={t("internalAdmin.detail.repairConsequence")}
        confirmLabel={t("internalAdmin.detail.repairConfirm")}
        pending={repairPending}
        error={repairError}
        onConfirm={() => void submitRepair()}
      />

      <InternalReasonDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          setCancelOpen(open)
          if (!open) setCancelError(null)
        }}
        title={t("internalAdmin.detail.cancelTitle")}
        consequence={t("internalAdmin.detail.cancelConsequence")}
        confirmLabel={t("internalAdmin.detail.cancelConfirm")}
        requireReason
        reason={cancelReason}
        onReasonChange={setCancelReason}
        pending={cancelPending}
        error={cancelError}
        onConfirm={() => void submitCancel()}
      />
    </div>
  )
}
