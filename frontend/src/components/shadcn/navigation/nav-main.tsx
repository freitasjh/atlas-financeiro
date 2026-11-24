"use client"

import { IconCirclePlusFilled, IconMail, type Icon } from "@tabler/icons-react"
import type { ComponentType, ReactNode } from "react"
import { Link, matchPath, useLocation } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/shadcn/ui/button"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/shadcn/ui/sidebar"
import { cn } from "@/lib/cn"

/** Ícone aceito: tabler (`Icon`) ou lucide (`LucideIcon`). */
export type NavItemIcon = Icon | ComponentType<{ className?: string }>

export interface NavMainItem {
  id?: string
  title: string
  /** Rota interna ("/contas") ou âncora não-navegável ("#") */
  url: string
  icon?: NavItemIcon
  badge?: string
  /**
   * `true` (default): ativo só no path exato. `false`: também nas rotas filhas
   * (ex.: `/internal/tenants` ativo em `/internal/tenants/:id`).
   */
  end?: boolean
}

/** Ação primária do topo da navegação. `null` remove a linha inteira. */
export interface NavQuickCreate {
  label: string
  onClick?: () => void
}

function isInternalRoute(url: string): boolean {
  return url.startsWith("/")
}

export function useNavItemActive(url: string, end = true): boolean {
  const { pathname } = useLocation()
  return isInternalRoute(url) ? matchPath({ path: url, end }, pathname) !== null : false
}

export function NavMain({
  items,
  onNewEntry,
  quickCreate,
}: {
  items: NavMainItem[]
  onNewEntry?: () => void
  quickCreate?: NavQuickCreate | null
}) {
  const { t } = useTranslation()
  const create =
    quickCreate === null
      ? null
      : {
          label: quickCreate?.label ?? t("sidebar.newEntry"),
          onClick: quickCreate?.onClick ?? onNewEntry,
        }

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        {create ? (
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-2">
              <SidebarMenuButton
                tooltip={create.label}
                onClick={create.onClick}
                className="max-md:min-h-11 min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground cursor-pointer"
              >
                <IconCirclePlusFilled />
                <span>{create.label}</span>
              </SidebarMenuButton>
              <Button
                size="icon"
                className="size-8 group-data-[collapsible=icon]:opacity-0"
                variant="outline"
              >
                <IconMail />
                <span className="sr-only">{t("sidebar.inbox")}</span>
              </Button>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        <SidebarMenu>
          {items.map((item) => (
            <SidebarNavItem
              key={item.url}
              title={item.title}
              url={item.url}
              icon={item.icon}
              badge={item.badge}
              end={item.end}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function SidebarNavItem({
  title,
  url,
  icon: Icon,
  badge,
  end,
  action,
}: {
  title: string
  url: string
  icon?: NavItemIcon
  badge?: string
  /** Default: `true` (path exato). */
  end?: boolean
  /** Elemento complementar dentro do mesmo SidebarMenuItem (ex.: dropdown). */
  action?: ReactNode
}) {
  const isActive = useNavItemActive(url, end)
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }
  const content = (
    <>
      {Icon ? <Icon /> : null}
      <span className="flex-1 truncate">{title}</span>
      {badge ? (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/15 px-1.5 font-mono text-[10px] font-semibold text-foreground group-data-[collapsible=icon]:hidden">
          {badge}
        </span>
      ) : null}
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={title}
        isActive={isActive}
        className={cn(
          "max-md:min-h-11 transition-colors",
          isActive && "bg-muted font-medium text-foreground shadow-2xs",
        )}
      >
        {isInternalRoute(url) ? (
          <Link
            to={url}
            onClick={closeMobile}
            aria-current={isActive ? "page" : undefined}
          >
            {content}
          </Link>
        ) : (
          <a href={url} onClick={closeMobile}>
            {content}
          </a>
        )}
      </SidebarMenuButton>
      {action}
    </SidebarMenuItem>
  )
}
