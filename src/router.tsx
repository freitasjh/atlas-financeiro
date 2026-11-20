import { createHashRouter, Navigate, Outlet, useLocation } from "react-router-dom"
import { lazy, Suspense, type ReactNode } from "react"

import { LoginPage } from "@/pages/LoginPage"
import { NotFoundPage } from "@/pages/NotFoundPage"
import {
  isLegacyInternalRedirectExpired,
  resolveLegacyInternalRedirect,
} from "@/internal/legacy-redirect"
import { RequireSession } from "@/routes/guards"
import { RootLayout } from "@/routes/root-layout"
import { RouteSkeleton } from "@/routes/route-skeleton"
import { AtlasAdminLayout } from "@/layouts/AtlasAdminLayout"

const LandingPage = lazy(() => import("@/pages/LandingPage").then((m) => ({ default: m.LandingPage })))
const SetPasswordPage = lazy(() =>
  import("@/pages/SetPasswordPage").then((m) => ({ default: m.SetPasswordPage })),
)
const LinkExpiredPage = lazy(() =>
  import("@/pages/LinkExpiredPage").then((m) => ({ default: m.LinkExpiredPage })),
)
const RequestInvitePage = lazy(() =>
  import("@/pages/RequestInvitePage").then((m) => ({ default: m.RequestInvitePage })),
)
const OverviewPage = lazy(() => import("@/pages/OverviewPage"))
const AccountsPage = lazy(() => import("@/modules/accounts/pages/AccountsPage"))
const ImportOfxPage = lazy(() => import("@/modules/accounts/pages/ImportOfxPage"))
const PlaceholderPage = lazy(() => import("@/pages/PlaceholderPage"))
const CategoriesPage = lazy(() => import("@/modules/categories/pages/CategoriesPage"))
const BudgetsPage = lazy(() => import("@/modules/budgets/pages/BudgetsPage"))
const TransactionsPage = lazy(() => import("@/modules/transactions/pages/TransactionsPage"))
const CardsPage = lazy(() => import("@/modules/credit-cards/pages/CardsPage"))
const KanbanPage = lazy(() => import("@/pages/mock-views/KanbanPage"))
const SchedulerPage = lazy(() => import("@/pages/mock-views/SchedulerPage"))
const CheckoutPage = lazy(() => import("@/pages/mock-views/CheckoutPage"))
const FilesPage = lazy(() => import("@/pages/mock-views/FilesPage"))
const InternalTree = lazy(() =>
  import("@/internal/internal-tree").then((m) => ({ default: m.InternalTree })),
)

function lazyElement(node: ReactNode) {
  return <Suspense fallback={<RouteSkeleton />}>{node}</Suspense>
}

/** `/register` e `/signup` morreram com o invite-only; preserva `?plano=`. */
function RedirectPreservingSearch({ to }: { to: string }) {
  const location = useLocation()
  return <Navigate to={{ pathname: to, search: location.search }} replace />
}

/**
 * `#/admin*` e `#/backoffice*` não têm elemento: redirecionam para `/internal`
 * preservando `search` + `hash`. Depois da data de morte as rotas nem são
 * registradas (o catch-all devolve 404).
 */
function LegacyInternalRedirect() {
  const location = useLocation()
  const target = resolveLegacyInternalRedirect(
    location.pathname,
    location.search,
    location.hash,
  )
  if (target === null) return <NotFoundPage />
  return <Navigate to={target} replace />
}

export function createAppRouter() {
  return createHashRouter([
    {
      element: <RootLayout />,
      children: [
        { path: "/landing", element: lazyElement(<LandingPage />) },
        { path: "/login", element: <LoginPage /> },
        {
          path: "/definir-senha",
          element: lazyElement(<SetPasswordPage />),
        },
        {
          path: "/link-expirado",
          element: lazyElement(<LinkExpiredPage />),
        },
        {
          path: "/solicitar-convite",
          element: lazyElement(<RequestInvitePage />),
        },
        // Signup desabilitado (0052): cadastro só por convite.
        { path: "/register", element: <RedirectPreservingSearch to="/solicitar-convite" /> },
        { path: "/signup", element: <RedirectPreservingSearch to="/solicitar-convite" /> },
        {
          // Rota pathless: RequireSession + AtlasAdminLayout protegem e
          // providenciam o esqueleto para TODAS as rotas filhas.
          element: (
            <RequireSession>
              <AtlasAdminLayout>
                <Outlet />
              </AtlasAdminLayout>
            </RequireSession>
          ),
          children: [
            { index: true, handle: { title: "dashboard.title" }, element: lazyElement(<OverviewPage />) },
            { path: "contas", handle: { title: "accounts.title" }, element: lazyElement(<AccountsPage />) },
            { path: "contas/importar", handle: { title: "accounts.ofx.importPageTitle" }, element: lazyElement(<ImportOfxPage />) },
            { path: "categorias", handle: { title: "categories.title" }, element: lazyElement(<CategoriesPage />) },
            { path: "orcamentos", handle: { title: "budgets.title" }, element: lazyElement(<BudgetsPage />) },
            { path: "lancamentos", handle: { title: "nav.transactions" }, element: lazyElement(<PlaceholderPage titleKey="nav.transactions" />) },
            { path: "cartoes", handle: { title: "nav.cards" }, element: lazyElement(<CardsPage />) },
            { path: "config", handle: { title: "nav.settings" }, element: lazyElement(<PlaceholderPage titleKey="nav.settings" />) },
            { path: "transacoes", handle: { title: "mockViews.transactions.title" }, element: lazyElement(<TransactionsPage />) },
            { path: "kanban", handle: { title: "mockViews.kanban.title" }, element: lazyElement(<KanbanPage />) },
            { path: "scheduler", handle: { title: "mockViews.scheduler.title" }, element: lazyElement(<SchedulerPage />) },
            { path: "checkout", handle: { title: "mockViews.checkout.title" }, element: lazyElement(<CheckoutPage />) },
            { path: "files", handle: { title: "mockViews.files.title" }, element: lazyElement(<FilesPage />) },
          ],
        },
        // Control plane: chunk lazy próprio, fora de `RequireSession` e do
        // `AtlasAdminLayout`. O guard interno decide cada superfície.
        { path: "/internal/*", element: lazyElement(<InternalTree />) },
        // Entradas legadas sem elemento: só redirect. Saem do router após
        // `LEGACY_INTERNAL_REDIRECT_DEATH` (2026-12-31).
        ...(isLegacyInternalRedirectExpired()
          ? []
          : [
              { path: "/admin/*", element: <LegacyInternalRedirect /> },
              { path: "/backoffice/*", element: <LegacyInternalRedirect /> },
            ]),
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ])
}

export const router = createAppRouter()
