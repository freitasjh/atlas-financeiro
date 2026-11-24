/**
 * `/internal/telemetria` — série de `admin_usage_series` + saúde da verificação
 * medida no cliente (REQ-33/REQ-48, UX §21).
 *
 * Nenhum uptime, SLA ou percentual fabricado: a série é `count(*)` de
 * `usage_events` e a saúde é a latência real de uma chamada de verificação
 * disparada pelo operador.
 */

import { useMemo, useState } from "react"
import { Activity, RefreshCw } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/shadcn/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/shadcn/ui/table"
import type { UsageSeriesRow } from "@/internal/data/internal-types"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"
import { formatCount, formatDate, formatDateTime, maskId } from "@/internal/ui/format"
import { InternalPageHeader } from "@/internal/ui/page-header"
import { InternalEmptyState, InternalErrorState, InternalLoadingState } from "@/internal/ui/state-blocks"
import { useInternalRead } from "@/internal/ui/use-internal-read"
import { useInternalT } from "../ui/use-internal-t"

interface HealthSample {
  state: string
  elapsedMs: number
  at: string
}

export function InternalTelemetryPage() {
  const t = useInternalT()
  const series = useInternalRead<UsageSeriesRow[]>("admin_usage_series", {})
  const [sample, setSample] = useState<HealthSample | null>(null)
  const [measuring, setMeasuring] = useState(false)

  const rows = series.data ?? []

  const totals = useMemo(() => {
    const byCompetencia = new Map<string, number>()
    for (const row of rows) {
      byCompetencia.set(row.competencia, (byCompetencia.get(row.competencia) ?? 0) + row.events)
    }
    return [...byCompetencia.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [rows])

  const measure = async () => {
    setMeasuring(true)
    const started = performance.now()
    try {
      const state = await useInternalOperator.getState().verify({ force: true })
      setSample({
        state,
        elapsedMs: Math.round(performance.now() - started),
        at: new Date().toISOString(),
      })
    } finally {
      setMeasuring(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <InternalPageHeader
        title={t("internalAdmin.telemetry.title")}
        description={t("internalAdmin.telemetry.description")}
      />

      <Card className="border-border/70 shadow-xs">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="size-4" aria-hidden="true" />
            {t("internalAdmin.telemetry.seriesTitle")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">{t("internalAdmin.telemetry.seriesHint")}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          {series.failed ? <InternalErrorState onRetry={series.reload} /> : null}
          {series.loading ? <InternalLoadingState rows={4} /> : null}

          {!series.loading && !series.failed && rows.length === 0 ? (
            <InternalEmptyState
              title={t("internalAdmin.telemetry.emptyTitle")}
              description={t("internalAdmin.telemetry.emptyHint")}
            />
          ) : null}

          {totals.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("internalAdmin.telemetry.columnCompetencia")}</TableHead>
                    <TableHead className="text-right">
                      {t("internalAdmin.telemetry.columnEvents")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {totals.map(([competencia, events]) => (
                    <TableRow key={competencia}>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDate(competencia)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-foreground">
                        {formatCount(events)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-foreground">
                {t("internalAdmin.telemetry.byTenant")}
              </h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("internalAdmin.telemetry.columnCompetencia")}</TableHead>
                      <TableHead>{t("internalAdmin.telemetry.columnTenant")}</TableHead>
                      <TableHead className="text-right">
                        {t("internalAdmin.telemetry.columnEvents")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={`${row.competencia}-${row.tenant_id}`}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDate(row.competencia)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {maskId(row.tenant_id)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-foreground">
                          {formatCount(row.events)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-border/70 shadow-xs">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground">
            {t("internalAdmin.telemetry.healthTitle")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">{t("internalAdmin.telemetry.healthHint")}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={measuring}
              onClick={() => void measure()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {measuring ? t("internalAdmin.telemetry.measuring") : t("internalAdmin.telemetry.measure")}
            </Button>
          </div>

          {sample !== null ? (
            <dl className="grid gap-3 sm:grid-cols-3" aria-live="polite">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">
                  {t("internalAdmin.telemetry.healthState")}
                </dt>
                <dd className="font-mono text-sm tabular-nums text-foreground">{sample.state}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">
                  {t("internalAdmin.telemetry.healthLatency")}
                </dt>
                <dd className="font-mono text-sm tabular-nums text-foreground">
                  {formatCount(sample.elapsedMs)} ms
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">
                  {t("internalAdmin.telemetry.healthAt")}
                </dt>
                <dd className="font-mono text-sm tabular-nums text-foreground">
                  {formatDateTime(sample.at)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">{t("internalAdmin.telemetry.healthIdle")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
