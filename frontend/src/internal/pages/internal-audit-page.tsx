/**
 * `/internal/auditoria` — timeline paginada de `list_admin_audit_page`
 * (REQ-39, UX §21).
 *
 * Sem filtro de data: a RPC só aceita `p_tenant`, `p_action`, `p_limit` e
 * `p_offset` — oferecer data seria filtro decorativo.
 */

import { useState } from "react"

import { Card, CardContent } from "@/components/shadcn/ui/card"
import { Label } from "@/components/shadcn/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/shadcn/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/shadcn/ui/table"
import type { AdminAuditRow } from "@/internal/data/internal-types"
import { formatDateTime, maskId } from "@/internal/ui/format"
import { InternalPageHeader } from "@/internal/ui/page-header"
import {
  InternalEmptyState,
  InternalErrorState,
  InternalLoadingState,
  InternalPageNav,
  INTERNAL_PAGE_SIZE,
} from "@/internal/ui/state-blocks"
import { useInternalRead } from "@/internal/ui/use-internal-read"
import { useInternalT } from "../ui/use-internal-t"

const ALL = "all"

/** Domínio fechado de `list_admin_audit_page` (`0037:164-168`). */
export const AUDIT_ACTIONS = [
  "grant_admin",
  "revoke_admin",
  "change_plan",
  "tenant_status_changed",
  "quota_override",
  "grant_super_admin",
  "revoke_super_admin",
  "mfa_enrolled",
  "other",
] as const

export function InternalAuditPage() {
  const t = useInternalT()
  const [action, setAction] = useState<string>(ALL)
  const [offset, setOffset] = useState(0)

  const audit = useInternalRead<AdminAuditRow[]>("list_admin_audit_page", {
    p_action: action === ALL ? null : action,
    p_limit: INTERNAL_PAGE_SIZE,
    p_offset: offset,
  })
  const rows = audit.data ?? []

  return (
    <div className="flex flex-col gap-5">
      <InternalPageHeader
        title={t("internalAdmin.audit.title")}
        description={t("internalAdmin.audit.description")}
      />

      <Card className="border-border/70 shadow-xs">
        <CardContent className="p-0">
          <div className="flex flex-col gap-1.5 border-b border-border/70 p-3 sm:max-w-64">
            <Label htmlFor="internal-audit-action" className="text-xs font-medium">
              {t("internalAdmin.audit.filterAction")}
            </Label>
            <Select
              value={action}
              onValueChange={(value) => {
                setAction(value)
                setOffset(0)
              }}
            >
              <SelectTrigger id="internal-audit-action" className="h-10 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("internalAdmin.audit.filterAll")}</SelectItem>
                {AUDIT_ACTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {audit.failed ? (
            <div className="p-4">
              <InternalErrorState onRetry={audit.reload} />
            </div>
          ) : null}
          {audit.loading ? <InternalLoadingState rows={5} /> : null}
          {!audit.loading && !audit.failed && rows.length === 0 ? (
            <div className="p-4">
              <InternalEmptyState
                title={t("internalAdmin.audit.emptyTitle")}
                description={t("internalAdmin.audit.emptyHint")}
              />
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("internalAdmin.audit.columnAt")}</TableHead>
                    <TableHead>{t("internalAdmin.audit.columnAction")}</TableHead>
                    <TableHead>{t("internalAdmin.audit.columnFromTo")}</TableHead>
                    <TableHead>{t("internalAdmin.audit.columnReason")}</TableHead>
                    <TableHead>{t("internalAdmin.audit.columnActor")}</TableHead>
                    <TableHead>{t("internalAdmin.audit.columnTarget")}</TableHead>
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
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {row.from_value ?? "—"} → {row.to_value ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.reason ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {maskId(row.actor_id)}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {maskId(row.target_id)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          <InternalPageNav
            limit={INTERNAL_PAGE_SIZE}
            offset={offset}
            count={rows.length}
            onChange={setOffset}
          />
        </CardContent>
      </Card>
    </div>
  )
}
