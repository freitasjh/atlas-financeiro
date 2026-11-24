/**
 * `/internal/tenants` — listagem server-driven (REQ-37..REQ-39, UX §21).
 *
 * Toolbar `<search>` com busca/status/ordenação, ação primária única, seção
 * recolhível de convites pendentes e tabela com `aria-sort` + documento
 * mascarado. O botão de convidar fica **oculto**: depende da Edge
 * `admin-invite-user` (F2-UI), fora da allowlist desta fatia (O-F4-11).
 */

import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowDown, ArrowUp, ChevronDown, RefreshCw, Search } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Card, CardContent } from "@/components/shadcn/ui/card"
import { Input } from "@/components/shadcn/ui/input"
import { Label } from "@/components/shadcn/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/shadcn/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/shadcn/ui/table"
import { writeInternalRpc } from "@/internal/data/internal-client"
import type { PendingInviteRow, TenantListRow } from "@/internal/data/internal-types"
import { formatCount, formatDate, formatDateTime, maskDocument, maskId } from "@/internal/ui/format"
import { InternalPageHeader } from "@/internal/ui/page-header"
import { InternalReasonDialog } from "@/internal/ui/reason-dialog"
import {
  InternalEmptyState,
  InternalErrorState,
  InternalLoadingState,
  InternalPager,
  INTERNAL_PAGE_SIZE,
} from "@/internal/ui/state-blocks"
import { InternalStatusBadge } from "@/internal/ui/status-badge"
import { useInternalRead } from "@/internal/ui/use-internal-read"
import { useInternalT } from "../ui/use-internal-t"

type SortColumn = "created_at" | "name" | "plan" | "status"
type SortDirection = "asc" | "desc"

const STATUS_OPTIONS = ["trial", "active", "past_due", "canceled"] as const
const ALL = "all"

function ariaSortFor(column: SortColumn, sort: SortColumn, dir: SortDirection) {
  if (column !== sort) return "none" as const
  return dir === "asc" ? ("ascending" as const) : ("descending" as const)
}

export function InternalTenantsPage() {
  const t = useInternalT()
  const navigate = useNavigate()

  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<string>(ALL)
  const [sort, setSort] = useState<SortColumn>("created_at")
  const [dir, setDir] = useState<SortDirection>("desc")
  const [offset, setOffset] = useState(0)

  const [invitesOpen, setInvitesOpen] = useState(false)
  const [inviteTarget, setInviteTarget] = useState<string | null>(null)
  const [invitePending, setInvitePending] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setOffset(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const listArgs = useMemo(
    () => ({
      p_search: search.length === 0 ? null : search,
      p_status: status === ALL ? null : status,
      p_sort: sort,
      p_dir: dir,
      p_limit: INTERNAL_PAGE_SIZE,
      p_offset: offset,
    }),
    [search, status, sort, dir, offset],
  )

  const rows = useInternalRead<TenantListRow[]>("admin_list_tenants", listArgs)
  const total = useInternalRead<number>("admin_count_tenants", {
    p_search: search.length === 0 ? null : search,
    p_status: status === ALL ? null : status,
  })
  const invites = useInternalRead<PendingInviteRow[]>(
    "admin_list_pending_invites",
    { p_limit: INTERNAL_PAGE_SIZE, p_offset: 0 },
    { enabled: invitesOpen },
  )
  const quota = useInternalRead<number>("admin_invite_quota", {}, { enabled: invitesOpen })

  const toggleSort = (column: SortColumn) => {
    setOffset(0)
    if (column === sort) {
      setDir((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSort(column)
    setDir("desc")
  }

  const handleCancelInvite = async () => {
    if (inviteTarget === null) return
    setInvitePending(true)
    setInviteError(null)
    try {
      await writeInternalRpc<boolean>("admin_cancel_invite", { p_target: inviteTarget })
      setFeedback(t("internalAdmin.tenants.inviteCanceled"))
      setInviteTarget(null)
      invites.reload()
      quota.reload()
    } catch {
      setInviteError(t("internalAdmin.actions.failed"))
    } finally {
      setInvitePending(false)
    }
  }

  const data = rows.data ?? []
  const totalCount = total.data ?? 0

  return (
    <div className="flex flex-col gap-5">
      <InternalPageHeader
        title={t("internalAdmin.tenants.title")}
        description={t("internalAdmin.tenants.description")}
      />

      {feedback !== null ? (
        <p role="status" aria-live="polite" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
          {feedback}
        </p>
      ) : null}

      <Card className="border-border/70 shadow-xs">
        <CardContent className="p-0">
          <search
            aria-label={t("internalAdmin.tenants.searchLabel")}
            className="flex flex-col gap-3 border-b border-border/70 p-3 sm:flex-row sm:items-end sm:justify-between"
          >
            <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="internal-tenant-search" className="text-xs font-medium">
                  {t("internalAdmin.tenants.searchField")}
                </Label>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="internal-tenant-search"
                    type="search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder={t("internalAdmin.tenants.searchPlaceholder")}
                    className="h-10 w-full pl-8"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5 sm:w-40">
                <Label htmlFor="internal-tenant-status" className="text-xs font-medium">
                  {t("internalAdmin.tenants.statusField")}
                </Label>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    setStatus(value)
                    setOffset(0)
                  }}
                >
                  <SelectTrigger id="internal-tenant-status" className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t("internalAdmin.tenants.statusAll")}</SelectItem>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`internalAdmin.status.${option}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5 sm:w-44">
                <Label htmlFor="internal-tenant-sort" className="text-xs font-medium">
                  {t("internalAdmin.tenants.sortField")}
                </Label>
                <Select
                  value={sort}
                  onValueChange={(value) => {
                    setSort(value as SortColumn)
                    setOffset(0)
                  }}
                >
                  <SelectTrigger id="internal-tenant-sort" className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="created_at">{t("internalAdmin.tenants.sortCreated")}</SelectItem>
                    <SelectItem value="name">{t("internalAdmin.tenants.sortName")}</SelectItem>
                    <SelectItem value="plan">{t("internalAdmin.tenants.sortPlan")}</SelectItem>
                    <SelectItem value="status">{t("internalAdmin.tenants.sortStatus")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                aria-label={t("internalAdmin.tenants.toggleDirection")}
                onClick={() => setDir((current) => (current === "asc" ? "desc" : "asc"))}
              >
                {dir === "asc" ? (
                  <ArrowUp className="size-4" aria-hidden="true" />
                ) : (
                  <ArrowDown className="size-4" aria-hidden="true" />
                )}
              </Button>
              <Button
                type="button"
                className="min-h-11"
                onClick={() => {
                  rows.reload()
                  total.reload()
                }}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {t("internalAdmin.tenants.refresh")}
              </Button>
            </div>
          </search>

          {rows.failed ? (
            <div className="p-4">
              <InternalErrorState onRetry={rows.reload} />
            </div>
          ) : null}

          {rows.loading ? <InternalLoadingState rows={5} /> : null}

          {!rows.loading && !rows.failed && data.length === 0 ? (
            <div className="p-4">
              <InternalEmptyState />
            </div>
          ) : null}

          {data.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead aria-sort={ariaSortFor("name", sort, dir)}>
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold"
                        onClick={() => toggleSort("name")}
                      >
                        {t("internalAdmin.tenants.columnName")}
                      </button>
                    </TableHead>
                    <TableHead>{t("internalAdmin.tenants.columnDocument")}</TableHead>
                    <TableHead aria-sort={ariaSortFor("plan", sort, dir)}>
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold"
                        onClick={() => toggleSort("plan")}
                      >
                        {t("internalAdmin.tenants.columnPlan")}
                      </button>
                    </TableHead>
                    <TableHead aria-sort={ariaSortFor("status", sort, dir)}>
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold"
                        onClick={() => toggleSort("status")}
                      >
                        {t("internalAdmin.tenants.columnStatus")}
                      </button>
                    </TableHead>
                    <TableHead aria-sort={ariaSortFor("created_at", sort, dir)}>
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold"
                        onClick={() => toggleSort("created_at")}
                      >
                        {t("internalAdmin.tenants.columnCreated")}
                      </button>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((tenant) => {
                    const name = tenant.nome_fantasia ?? tenant.razao_social
                    return (
                      <TableRow
                        key={tenant.id}
                        className="cursor-pointer transition-colors hover:bg-muted/50"
                        onClick={() => navigate(`/internal/tenants/${tenant.id}`)}
                      >
                        <TableCell className="min-w-0">
                          <Link
                            to={`/internal/tenants/${tenant.id}`}
                            className="font-medium text-foreground underline-offset-4 hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {name}
                          </Link>
                          <p className="truncate text-[11px] text-muted-foreground">{tenant.razao_social}</p>
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {maskDocument(tenant.cnpj ?? tenant.cpf)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-foreground">
                          {tenant.plan_id}
                        </TableCell>
                        <TableCell>
                          <InternalStatusBadge status={tenant.subscription_status} />
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDate(tenant.created_at)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}

          <InternalPager
            total={totalCount}
            limit={INTERNAL_PAGE_SIZE}
            offset={offset}
            onChange={setOffset}
          />
        </CardContent>
      </Card>

      <section className="rounded-xl border border-border/70 bg-card shadow-xs">
        <button
          type="button"
          aria-expanded={invitesOpen}
          onClick={() => setInvitesOpen((current) => !current)}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-semibold text-foreground"
        >
          <span>{t("internalAdmin.tenants.invitesTitle")}</span>
          <ChevronDown
            className={`size-4 transition-transform ${invitesOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>

        {invitesOpen ? (
          <div className="flex flex-col gap-3 border-t border-border/70 p-4">
            <p className="text-xs text-muted-foreground">
              {t("internalAdmin.tenants.invitesHint")}
            </p>
            {quota.data !== null ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("internalAdmin.tenants.invitesQuota", { value: formatCount(quota.data) })}
              </p>
            ) : null}

            {invites.failed ? <InternalErrorState onRetry={invites.reload} /> : null}
            {invites.loading ? <InternalLoadingState rows={2} /> : null}

            {!invites.loading && !invites.failed && (invites.data ?? []).length === 0 ? (
              <InternalEmptyState
                title={t("internalAdmin.tenants.invitesEmptyTitle")}
                description={t("internalAdmin.tenants.invitesEmptyHint")}
              />
            ) : null}

            {(invites.data ?? []).length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("internalAdmin.tenants.inviteTarget")}</TableHead>
                      <TableHead>{t("internalAdmin.tenants.inviteRequestedAt")}</TableHead>
                      <TableHead>{t("internalAdmin.tenants.inviteAge")}</TableHead>
                      <TableHead>{t("internalAdmin.tenants.inviteState")}</TableHead>
                      <TableHead className="text-right">
                        {t("internalAdmin.tenants.inviteActions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(invites.data ?? []).map((invite) => (
                      <TableRow key={invite.invited_user_id}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {maskId(invite.invited_user_id)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDateTime(invite.requested_at)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-foreground">
                          {formatCount(invite.age_hours)}
                        </TableCell>
                        <TableCell className="text-xs text-foreground">{invite.state}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            onClick={() => {
                              setInviteError(null)
                              setInviteTarget(invite.invited_user_id)
                            }}
                          >
                            {t("internalAdmin.tenants.inviteCancel")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <InternalReasonDialog
        open={inviteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setInviteTarget(null)
        }}
        title={t("internalAdmin.tenants.inviteCancelTitle")}
        consequence={t("internalAdmin.tenants.inviteCancelConsequence")}
        confirmLabel={t("internalAdmin.tenants.inviteCancel")}
        pending={invitePending}
        error={inviteError}
        onConfirm={() => void handleCancelInvite()}
      />
    </div>
  )
}
