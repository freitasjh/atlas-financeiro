"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import {
  IconCreditCard,
  IconDashboard,
  IconDatabase,
  IconListDetails,
  IconPigMoney,
  IconSettings,
  IconTags,
} from "@tabler/icons-react"

import { EsticaGranaMark } from "@/components/brand/EsticaGranaLogo"
import { useAuthStore } from "@/store/auth-store"

import { NavMain, type NavMainItem, type NavQuickCreate } from "@/components/shadcn/navigation/nav-main"
import { NavSecondary } from "@/components/shadcn/navigation/nav-secondary"
import {
  NavUser,
  type NavUserData,
  type NavUserMenuItem,
} from "@/components/shadcn/navigation/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/shadcn/ui/sidebar"

export type DashboardViewId = "overview" | "transactions" | "cards" | "accounts" | string

const data = {
  navMain: [
    {
      titleKey: "sidebar.overview",
      url: "/",
      icon: IconDashboard,
    },
    {
      titleKey: "sidebar.transactions",
      url: "/transacoes",
      icon: IconListDetails,
    },
    {
      titleKey: "nav.cards",
      url: "/cartoes",
      icon: IconCreditCard,
    },
    {
      titleKey: "sidebar.accounts",
      url: "/contas",
      icon: IconDatabase,
    },
    {
      titleKey: "sidebar.categories",
      url: "/categorias",
      icon: IconTags,
    },
    {
      titleKey: "sidebar.budgets",
      url: "/orcamentos",
      icon: IconPigMoney,
    },
  ],
  navSecondary: [
    {
      titleKey: "sidebar.settings",
      url: "/config",
      icon: IconSettings,
    },
  ],
  documents: [],
}

/** Marca do topo da sidebar. `href: null` deixa a marca não clicável. */
export interface AppSidebarBrand {
  title: string
  subtitle: string
  icon?: React.ComponentType<{ className?: string }>
  href?: string | null
}

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onNewEntry?: () => void
  /** Itens principais já traduzidos. Default: navegação do app de tenant. */
  navMain?: NavMainItem[]
  /** Itens secundários já traduzidos. Default: Configurações. `[]` remove. */
  navSecondary?: NavMainItem[]
  brand?: AppSidebarBrand
  user?: NavUserData
  /** `null` remove a ação primária + inbox (control plane não cria lançamento). */
  quickCreate?: NavQuickCreate | null
  userMenuItems?: NavUserMenuItem[]
  onSignOut?: () => void
  showPresence?: boolean
}

/**
 * Barra lateral do AtlasAdminLayout. A navegação é feita por rotas reais
 * (react-router <Link>); o item ativo é derivado da rota corrente
 * (useLocation + matchPath) — nunca por prop/callback.
 *
 * Todas as props de conteúdo são opcionais: sem elas o componente é a sidebar
 * do app de tenant; o control plane interno passa a própria navegação, marca e
 * usuário.
 */
export function AppSidebar({
  onNewEntry,
  navMain,
  navSecondary,
  brand,
  user,
  quickCreate,
  userMenuItems,
  onSignOut,
  showPresence,
  ...props
}: AppSidebarProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const authUser = useAuthStore((s) => s.user)
  const resolvedUser: NavUserData =
    user ??
    (authUser?.email
      ? {
          name: authUser.email.split("@")[0] || authUser.email,
          email: authUser.email,
          avatar: "",
        }
      : { name: "", email: "", avatar: "" })

  const navMainItems: NavMainItem[] =
    navMain ??
    data.navMain.map((item) => ({
      title: t(item.titleKey),
      url: item.url,
      icon: item.icon,
    }))

  const navSecondaryItems: NavMainItem[] =
    navSecondary ??
    data.navSecondary.map((item) => ({
      title: t(item.titleKey),
      url: item.url,
      icon: item.icon,
    }))

  const resolvedBrand: AppSidebarBrand = brand ?? {
    title: "Estica Grana",
    subtitle: t("sidebar.workspace"),
    href: "#/",
  }
  const CustomBrandIcon = resolvedBrand.icon
  const brandHref = resolvedBrand.href === undefined ? "#/" : resolvedBrand.href

  const brandContent = (
    <>
      {CustomBrandIcon ? (
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
          <CustomBrandIcon className="size-4" />
        </div>
      ) : (
        <EsticaGranaMark className="size-7 rounded-lg shadow-xs" />
      )}
      <div className="flex flex-col">
        <span className="text-sm font-bold tracking-tight">
          {resolvedBrand.title === "Estica Grana" ? (
            <>
              Estica <span className="text-emerald-600 dark:text-emerald-400">Grana</span>
            </>
          ) : (
            resolvedBrand.title
          )}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {resolvedBrand.subtitle}
        </span>
      </div>
    </>
  )

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5! hover:bg-transparent"
            >
              {brandHref === null ? (
                <span className="flex items-center gap-2.5">{brandContent}</span>
              ) : (
                <a href={brandHref} className="flex items-center gap-2.5">
                  {brandContent}
                </a>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain
          items={navMainItems}
          onNewEntry={onNewEntry ?? (() => navigate("/transacoes"))}
          quickCreate={quickCreate}
        />
        {navSecondaryItems.length > 0 ? (
          <NavSecondary items={navSecondaryItems} className="mt-auto" />
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={resolvedUser}
          userMenuItems={userMenuItems}
          onSignOut={onSignOut}
          showPresence={showPresence}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
