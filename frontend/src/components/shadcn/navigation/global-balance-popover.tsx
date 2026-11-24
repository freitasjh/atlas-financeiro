"use client"

import { useState } from "react"
import { ChevronDown, Eye, Landmark, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/shadcn/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/shadcn/ui/empty"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/shadcn/ui/popover"
import { ScrollArea } from "@/components/shadcn/ui/scroll-area"
import { Separator } from "@/components/shadcn/ui/separator"
import { Skeleton } from "@/components/shadcn/ui/skeleton"
import { cn } from "@/lib/cn"
import { formatCentsBRL } from "@/lib/utils"

export interface GlobalBalanceAccount {
  id: string
  nickname: string
  /** Saldo em centavos (BIGINT cents — sem float). */
  balanceCents: number
}

export interface GlobalBalancePopoverProps {
  accounts?: GlobalBalanceAccount[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const DEFAULT_ACCOUNTS: GlobalBalanceAccount[] = []

export function GlobalBalancePopover({
  accounts = DEFAULT_ACCOUNTS,
  loading = false,
  error = null,
  onRetry,
  open,
  onOpenChange,
}: GlobalBalancePopoverProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || "pt-BR"
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isOpen = open ?? uncontrolledOpen
  const handleOpenChange = onOpenChange ?? setUncontrolledOpen

  const totalCents = accounts.reduce((acc, a) => acc + a.balanceCents, 0)
  const triggerLabel = t("shell.topbar.globalBalance.label")

  return (
    <Popover modal={false} open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-label={triggerLabel}
          className="h-11 min-w-0 gap-2 px-3"
        >
          <Landmark data-icon="inline-start" className="size-4 shrink-0 text-muted-foreground" />
          <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
            {t("shell.topbar.globalBalance.total")}
          </span>
          <span className="min-w-0 max-w-[38vw] truncate font-mono text-sm font-bold tabular-nums">
            {loading ? "—" : formatCentsBRL(totalCents, locale)}
          </span>
          <ChevronDown
            data-icon="inline-end"
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", isOpen && "rotate-180")}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        role="dialog"
        aria-label={triggerLabel}
        className="w-80 max-w-[calc(100vw-2rem)] cursor-default p-0"
        style={{ maxHeight: "70vh" }}
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2 p-4 pb-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t("shell.topbar.globalBalance.total")}</p>
            <p className="truncate font-mono text-xl font-extrabold tracking-tight tabular-nums">
              {loading ? "—" : formatCentsBRL(totalCents, locale)}
            </p>
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {t("shell.topbar.globalBalance.accounts", { count: accounts.length })}
          </span>
        </div>
        <Separator />
        {loading ? (
          <div className="space-y-2 p-4" role="status" aria-busy="true">
            <span className="sr-only">{t("shell.topbar.globalBalance.loading")}</span>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center" role="alert">
            <TriangleAlert data-icon="status" className="size-4 text-amber-600 dark:text-amber-400" />
            <p className="text-sm font-medium">{error}</p>
            <p className="text-xs text-muted-foreground">{t("shell.topbar.globalBalance.errorHint")}</p>
            {onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-1 h-11 min-h-11">
                {t("shell.topbar.globalBalance.retry")}
              </Button>
            )}
          </div>
        ) : accounts.length === 0 ? (
          <Empty className="border-0 p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Eye data-icon="empty" className="size-4" />
              </EmptyMedia>
              <EmptyTitle className="text-sm">{t("shell.topbar.globalBalance.empty")}</EmptyTitle>
              <EmptyDescription>{t("shell.topbar.globalBalance.emptyHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="max-h-[46vh] overflow-y-auto">
            <ul className="flex flex-col gap-0.5 p-2">
              {accounts.map((account) => (
                <li key={account.id}>
                  <div data-readonly-row className="flex min-w-0 cursor-default items-center justify-between gap-3 rounded-md px-2 py-2">
                    <span className="min-w-0 truncate text-xs font-medium">{account.nickname}</span>
                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">
                      {formatCentsBRL(account.balanceCents, locale)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
        <Separator />
        <p className="flex items-center gap-1.5 p-3 text-[11px] text-muted-foreground">
          <Eye data-icon="decorative" className="size-4 shrink-0" />
          {t("shell.topbar.globalBalance.viewOnly")}
        </p>
      </PopoverContent>
    </Popover>
  )
}
