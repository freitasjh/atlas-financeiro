"use client"

import type { ReactNode } from "react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/shadcn/ui/breadcrumb"
import { Separator } from "@/components/shadcn/ui/separator"
import { SidebarTrigger } from "@/components/shadcn/ui/sidebar"
import { GlobalBalancePopover } from "@/components/shadcn/navigation/global-balance-popover"
import { useGlobalBalance } from "@/components/shadcn/navigation/use-global-balance"
import { ModeToggle } from "@/components/shadcn/navigation/mode-toggle"
import { NotificationCenter } from "@/components/shadcn/navigation/notification-center"
import { useTranslation } from "react-i18next"

export interface SiteHeaderProps {
  title?: string
  /** Rótulo da raiz do breadcrumb. Default: chave `nav.platform`. */
  breadcrumbRoot?: string
  /** Href da raiz do breadcrumb; `null` deixa a raiz não clicável. Default: `"#/"`. */
  breadcrumbRootHref?: string | null
  /** Saldo global é dado de tenant — `false` no control plane interno. Default: `true`. */
  showGlobalBalance?: boolean
  showNotifications?: boolean
  showModeToggle?: boolean
  /** Ações extras no cluster direito (ex.: chip `aal2` do control plane). */
  actions?: ReactNode
  /**
   * Rótulo acessível do botão que abre/recolhe a sidebar. Ausente ⇒ default do
   * template (`Toggle Sidebar`); superfícies traduzidas passam a chave i18n.
   */
  sidebarToggleLabel?: string
}

/**
 * Saldo global isolado num slot.
 *
 * O hook consulta `accounts.store` (dado de tenant). Só monta quando o header
 * pede: no control plane interno nenhum efeito de tenant pode rodar.
 */
export function GlobalBalanceSlot() {
  const { t } = useTranslation()
  const { accounts, loading, error, onRetry } = useGlobalBalance()
  return (
    <GlobalBalancePopover
      accounts={accounts}
      loading={loading}
      error={error ? t("accounts.loadError") : null}
      onRetry={onRetry}
    />
  )
}

export function SiteHeader({
  title,
  breadcrumbRoot,
  breadcrumbRootHref = "#/",
  showGlobalBalance = true,
  showNotifications = true,
  showModeToggle = true,
  actions,
  sidebarToggleLabel,
}: SiteHeaderProps) {
  const { t } = useTranslation()
  const resolvedTitle = title ?? t("shell.dashboardTitle")
  const resolvedRoot = breadcrumbRoot ?? t("nav.platform")
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 backdrop-blur-md transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger
          className="-ml-1 max-md:min-h-11 max-md:min-w-11"
          label={sidebarToggleLabel}
        />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <Breadcrumb className="hidden sm:block">
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:block">
              {breadcrumbRootHref === null ? (
                <span className="text-muted-foreground">{resolvedRoot}</span>
              ) : (
                <BreadcrumbLink href={breadcrumbRootHref}>{resolvedRoot}</BreadcrumbLink>
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage>{resolvedTitle}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {actions}
          {showGlobalBalance ? <GlobalBalanceSlot /> : null}
          {showModeToggle ? <ModeToggle /> : null}
          {showNotifications ? <NotificationCenter /> : null}
        </div>
      </div>
    </header>
  )
}
