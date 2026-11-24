/**
 * Shell do control plane (REQ-05 · UX revisão 2026-11-19).
 *
 * Compõe o **template real** — `AtlasAdminTemplate` + `AppSidebar` + `SiteHeader`
 * — evoluído no lugar por props. Nada de shell próprio: sem rail, topbar ou
 * bottom-nav locais. Sem seletor de tenant (o operador não tem tenant, REQ-47) e
 * sem dado de tenant: `showGlobalBalance={false}` desliga o slot que dispararia
 * `accounts.store.load()`.
 */

import { useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { ShieldCheck } from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/shadcn/ui/dialog"
import type { NavMainItem } from "@/components/shadcn/navigation/nav-main"
import { AtlasAdminTemplate } from "@/layouts"
import { signOutInternalOperator } from "@/internal/data/internal-client"
import { maskId } from "@/internal/ui/format"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"
import { INTERNAL_NAV_ITEMS, internalNavTitleKey } from "./internal-nav"
import { useInternalT } from "../ui/use-internal-t"

/**
 * Wrapper de conteúdo do control plane (DESIGN.md §3, regra 1).
 * Centralizado aqui: páginas `/internal/*` montadas sob este shell herdam o
 * alinhamento `px-4 lg:px-6` do SiteHeader sem repetir padding em cada view.
 * Páginas de tenant fora do shell mantêm o próprio padding — não são afetadas.
 */
export const internalContentClassName = "flex flex-col gap-6 px-4 py-4 md:py-6 lg:px-6"

function aalLabel(aalKey: "aal1" | "aal2" | null): string {
  if (aalKey === null) return "—"
  return aalKey
}

export function InternalShell() {
  const t = useInternalT()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const aalKey = useInternalOperator((store) => store.aalKey)
  const operatorId = useInternalOperator((store) => store.userId)
  const reset = useInternalOperator((store) => store.reset)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOutInternalOperator()
    } finally {
      reset()
      setSigningOut(false)
      setSignOutOpen(false)
      navigate("/internal/login", { replace: true })
    }
  }

  const navMain: NavMainItem[] = INTERNAL_NAV_ITEMS.map((item) => ({
    title: t(item.labelKey),
    url: item.to,
    icon: item.icon,
    end: item.end,
  }))

  return (
    <>
      <a
        href="#internal-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:min-h-11 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:text-primary-foreground"
      >
        {t("a11y.skipToContent")}
      </a>

      <AtlasAdminTemplate
        mainId="internal-main"
        title={t(internalNavTitleKey(pathname))}
        contentClassName={internalContentClassName}
        sidebarProps={{
          navMain,
          navSecondary: [],
          brand: {
            title: "Estica Grana",
            subtitle: t("internalAdmin.eyebrow"),
            icon: ShieldCheck,
            href: null,
          },
          user: {
            name: t("internalAdmin.shell.operator"),
            email: operatorId !== null ? maskId(operatorId) : "—",
            avatar: "",
            secondaryMono: true,
          },
          quickCreate: null,
          userMenuItems: [],
          onSignOut: () => setSignOutOpen(true),
          showPresence: false,
        }}
        headerProps={{
          breadcrumbRoot: t("internalAdmin.eyebrow"),
          breadcrumbRootHref: null,
          sidebarToggleLabel: t("internalAdmin.shell.toggleSidebar"),
          showGlobalBalance: false,
          showNotifications: false,
          actions: (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              <span className="sr-only">{t("internalAdmin.shell.aalLabel")}</span>
              <span className="font-mono tabular-nums">{aalLabel(aalKey)}</span>
            </span>
          ),
        }}
      >
        <Outlet />
      </AtlasAdminTemplate>

      <Dialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <DialogContent className="w-full max-h-[92vh] overflow-y-auto overscroll-contain p-5 sm:max-w-[480px] sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-foreground">
              {t("internalAdmin.shell.signOutTitle")}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t("internalAdmin.shell.signOutConsequence")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-5 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setSignOutOpen(false)}
            >
              {t("internalAdmin.actions.cancel")}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              {t("internalAdmin.shell.signOutConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
