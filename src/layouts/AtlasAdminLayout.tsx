import type { CSSProperties, ReactNode } from "react"
import { Outlet, useMatches } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { SidebarProvider, SidebarInset } from "@/components/shadcn/ui/sidebar"
import {
  AppSidebar,
  type AppSidebarProps,
} from "@/components/shadcn/navigation/app-sidebar"
import { SiteHeader, type SiteHeaderProps } from "@/components/shadcn/navigation/site-header"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

export const defaultSidebarStyle: CSSProperties = {
  "--sidebar-width": "calc(var(--spacing) * 72)",
  "--header-height": "calc(var(--spacing) * 12)",
} as CSSProperties

/** Handle de rota: cada rota filha declara a chave i18n do próprio título. */
export interface AtlasRouteHandle {
  title: string
  /** Padding vertical do conteúdo. Default: py-4 md:py-6; ex.: /contas usa compacto. */
  contentClassName?: string
}

/** Padding padrão do conteúdo (todas as rotas). */
export const defaultContentClassName = "flex flex-col gap-4 py-4 md:gap-6 md:py-6"

/** Padding compacto (ex.: /contas — h1 precisa entrar no viewport inicial). */
export const compactContentClassName = "flex flex-col gap-4 py-3 md:gap-6 md:py-4"

/** Resolve o padding do conteúdo: prop > handle da rota > default. */
export function resolveContentClassName(handle: unknown, override?: string): string {
  if (override) return override
  if (handle && typeof handle === "object" && "contentClassName" in handle) {
    const value = (handle as AtlasRouteHandle).contentClassName
    if (typeof value === "string" && value.length > 0) return value
  }
  return defaultContentClassName
}

export interface AtlasAdminLayoutProps {
  /** @deprecated Sobrescreve o título derivado da rota. Manter só por compat. */
  title?: string
  /** @deprecated Rotas usam <Outlet/>. Manter só para consumidores fora do router. */
  children?: ReactNode
  /** Estilos e variáveis CSS customizadas da sidebar */
  sidebarStyle?: CSSProperties
  /** Sobrescreve o padding do conteúdo (default: handle da rota > default). */
  contentClassName?: string
  /**
   * Conteúdo do AppSidebar. Sem props o comportamento é o do app de tenant;
   * o control plane interno passa navegação, marca, usuário e `quickCreate`.
   */
  sidebarProps?: Partial<AppSidebarProps>
  /** Conteúdo do SiteHeader (raiz do breadcrumb, slots e ações extras). */
  headerProps?: SiteHeaderProps
  /**
   * Banner full-width abaixo do header, dentro do `SidebarInset` e sticky sob
   * ele (ex.: impersonation). Ausente ⇒ nenhum nó é renderizado.
   */
  banner?: ReactNode
  /** id do landmark `<main>` (alvo do skip-link). */
  mainId?: string
}

function routeTitle(handle: unknown): string | undefined {
  if (handle && typeof handle === "object" && "title" in handle) {
    return (handle as AtlasRouteHandle).title
  }
  return undefined
}

/**
 * Template Admin Atlas (Perfil Shadcn) — layout de rota pathless.
 *
 * Montado pelo router como rota pai (sem `path`) com <Outlet/>: todas as rotas
 * filhas herdam sidebar + header + <main>. A navegação lateral é por rotas
 * reais (react-router); o item ativo é derivado da rota corrente dentro do
 * AppSidebar, não por props (activeView/onSelectView removidos).
 */
export function AtlasAdminLayout({
  title,
  children,
  sidebarStyle = defaultSidebarStyle,
  contentClassName,
  sidebarProps,
  headerProps,
  banner,
  mainId,
}: AtlasAdminLayoutProps) {
  const { t } = useTranslation()
  const matches = useMatches()
  const leafHandle = matches[matches.length - 1]?.handle
  const leafTitle = routeTitle(leafHandle)
  const resolvedTitle = title ?? (leafTitle ? t(leafTitle) : t("dashboard.title"))
  const resolvedContentClassName = resolveContentClassName(leafHandle, contentClassName)
  useDocumentTitle(resolvedTitle)

  return (
    <SidebarProvider style={sidebarStyle}>
      <AppSidebar variant="inset" {...sidebarProps} />
      <SidebarInset id={mainId}>
        <SiteHeader {...headerProps} title={headerProps?.title ?? resolvedTitle} />
        {banner ? (
          <div
            data-slot="atlas-banner"
            className="sticky top-(--header-height) z-10 shrink-0"
          >
            {banner}
          </div>
        ) : null}
        {/* P2.1: div interna — SidebarInset segue como main único da página. */}
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div data-testid="atlas-content" className={resolvedContentClassName}>
              {children ?? <Outlet />}
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

// Aliases semânticos para máxima ergonomia de importação
export const AtlasAdminTemplate = AtlasAdminLayout
export const AdminLayout = AtlasAdminLayout
export const DashboardLayout = AtlasAdminLayout
export type AtlasAdminTemplateProps = AtlasAdminLayoutProps
export type AdminLayoutProps = AtlasAdminLayoutProps
export type DashboardLayoutProps = AtlasAdminLayoutProps
