import { Outlet } from "react-router-dom"

import { Toaster } from "@/components/shadcn/ui/sonner"
import { RouteErrorBoundary } from "@/routes/route-error-boundary"

// Root de todas as rotas: o Toaster precisa existir fora do App (/) para que
// toasts de /contas, /login, /register e demais rotas apareçam.
// RouteErrorBoundary em volta do Outlet captura falhas de renderização e de
// chunk lazy em qualquer rota — mostra UI de erro com "Recarregar", nunca branca.
export function RootLayout() {
  return (
    <>
      <RouteErrorBoundary>
        <Outlet />
      </RouteErrorBoundary>
      <Toaster position="top-right" />
    </>
  )
}
